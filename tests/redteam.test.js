'use strict';

/**
 * notevault red-team regression tests (Drill #8).
 *
 * Each test locks in a finding that was proven live against the running
 * server or CLI before the fix:
 *  F1  restore's server check was HTTP-based — a hung listener holding the
 *      port did not block a restore. Now a raw TCP connect decides.
 *  F2  restore overwrote the live DB before verifying the backup, and a
 *      non-database backup crashed restore.js / integrity.js with an
 *      uncaught SqliteError. Now the backup is verified first, failures
 *      are clean JSON, and a failed restore rolls back.
 *  F3  X-Powered-By: Express on every response (framework fingerprinting).
 *  F4  database and backup files were created group/world-readable under
 *      a permissive umask. Now owner-only (0600).
 *  F5  (follow-up, 2026-11-19) restore verified integrity + row count but
 *      never looked at the schema: a backup carrying a trigger would
 *      restore cleanly, and the trigger would fire on the next write.
 *      A table-only whitelist does NOT close this — a trigger attached to
 *      the notes table itself passes it. Now verifyDbFile rejects ANY
 *      trigger and any object outside {table:notes, table:sqlite_sequence}.
 *      Proven with a benign canary trigger (scripts/demo-canary-restore.js).
 *
 * Also locked in: SQL injection is stored literally (parameterized
 * queries), __proto__ payloads do not pollute Object.prototype, oversized
 * bodies are 413, malformed JSON is 400.
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createApp } = require('../src/app');

const ROOT = path.join(__dirname, '..');

let tmpDir;
let dbPath;
let server;
let base;
let db;

function startServer() {
  const { app, db: opened } = createApp(dbPath);
  db = opened;
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

async function stopServer() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  if (db) {
    try {
      db.close();
    } catch {
      // already closed
    }
    db = null;
  }
}

async function req(method, p, body, rawBody) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // empty body (e.g. 204) is fine
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function createNote(title, body = '') {
  const r = await req('POST', '/notes', { title, body });
  assert.equal(r.status, 201, `create ${title} should be 201, got ${r.status}: ${r.text}`);
  return r.json;
}

function runScript(name, args, env) {
  return spawnSync('node', [path.join(ROOT, 'scripts', name), ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notevault-redteam-'));
  dbPath = path.join(tmpDir, 'test.db');
  await startServer();
});

afterEach(async () => {
  await stopServer();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('F3: no framework fingerprint', () => {
  it('responses carry no X-Powered-By header', async () => {
    const health = await req('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-powered-by'), null);
    const missing = await req('GET', '/notes/9999');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('x-powered-by'), null);
  });
});

describe('injection holds', () => {
  it('SQL in title/body is stored literally; the table survives', async () => {
    const note = await createNote("x'; DROP TABLE notes; --", "'); DELETE FROM notes; --");
    assert.equal(note.title, "x'; DROP TABLE notes; --");
    const list = await req('GET', '/notes');
    assert.equal(list.status, 200);
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].body, "'); DELETE FROM notes; --");
    const health = await req('GET', '/health');
    assert.equal(health.json.notes, 1);
  });

  it('__proto__ payload does not pollute Object.prototype', async () => {
    const r = await req('POST', '/notes', { title: 'proto', body: 'x', __proto__: { polluted: true } });
    assert.equal(r.status, 201);
    assert.equal({}.polluted, undefined);
  });
});

describe('body limits', () => {
  it('body over 100kb is 413, malformed JSON is 400', async () => {
    const big = await req('POST', '/notes', undefined, JSON.stringify({ title: 'big', body: 'z'.repeat(200000) }));
    assert.equal(big.status, 413);
    assert.equal(big.json.error, 'PAYLOAD_TOO_LARGE');
    const bad = await req('POST', '/notes', undefined, '{json rusak');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'BAD_REQUEST');
  });
});

describe('F1: restore refuses a hung listener', () => {
  it('a non-responding TCP listener on the port blocks restore', async () => {
    await createNote('keep me');
    const backupFile = path.join(tmpDir, 'backup.db');
    const b = runScript('backup.js', [backupFile], { DB_PATH: dbPath });
    assert.equal(b.status, 0, `backup failed: ${b.stderr}`);

    // A listener that accepts connections but never answers HTTP.
    const dummy = net.createServer(() => {});
    await new Promise((resolve) => dummy.listen(0, '127.0.0.1', resolve));
    const dummyPort = dummy.address().port;
    try {
      const r = runScript('restore.js', [backupFile, dbPath], { PORT: String(dummyPort), DB_PATH: dbPath });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /SERVER_RUNNING/);
    } finally {
      await new Promise((resolve) => dummy.close(resolve));
    }
    // The live database is untouched.
    const health = await req('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.notes, 1);
  });
});

describe('F2: restore verifies before overwriting', () => {
  it('a non-database backup is a clean no-op; the live DB survives', async () => {
    await createNote('survivor-one');
    await createNote('survivor-two');
    const garbage = path.join(tmpDir, 'garbage.db');
    fs.writeFileSync(garbage, 'this is not a database at all\n');

    await stopServer();
    const r = runScript('restore.js', [garbage, dbPath], { PORT: '0', DB_PATH: dbPath });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BACKUP_INVALID/);
    assert.doesNotMatch(r.stderr, /SqliteError/);
    assert.doesNotMatch(r.stderr, /\n    at /);

    // The live file is byte-identical to before: still a valid DB, 2 notes.
    const check = runScript('integrity.js', [dbPath], { DB_PATH: dbPath });
    assert.equal(check.status, 0, `integrity failed: ${check.stdout} ${check.stderr}`);
    assert.equal(JSON.parse(check.stdout).notes, 2);

    await startServer();
    const health = await req('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.notes, 2);
  });

  it('integrity.js on a non-database file fails clean, without a stack trace', async () => {
    const garbage = path.join(tmpDir, 'garbage.db');
    fs.writeFileSync(garbage, 'not a database\n');
    const r = runScript('integrity.js', [garbage], { DB_PATH: garbage });
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).error, 'NOT_A_DATABASE');
    assert.doesNotMatch(r.stdout + r.stderr, /SqliteError/);
    assert.doesNotMatch(r.stdout + r.stderr, /\n    at /);
  });
});

describe('F5: restore rejects executable schema', () => {
  it('a backup with a trigger ON notes itself is rejected; the live DB survives', async () => {
    await createNote('survivor-one');
    await createNote('survivor-two');
    const backupFile = path.join(tmpDir, 'canary-backup.db');
    const b = runScript('backup.js', [backupFile], { DB_PATH: dbPath });
    assert.equal(b.status, 0, `backup failed: ${b.stderr}`);

    // Benign canary: a trigger on notes that only writes to a canary table.
    // It is LIVE (proven to fire in scripts/demo-canary-restore.js), not inert.
    const canary = new Database(backupFile);
    canary.exec(`CREATE TABLE canary_log (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL);
      CREATE TRIGGER trg_canary_after_insert AFTER INSERT ON notes
      BEGIN INSERT INTO canary_log (note) VALUES ('canary-fired'); END;`);
    canary.close();

    await stopServer();
    const r = runScript('restore.js', [backupFile, dbPath], { PORT: '0', DB_PATH: dbPath });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BACKUP_INVALID/);
    assert.match(r.stderr, /trg_canary_after_insert/);
    assert.match(r.stderr, /trigger/);
    assert.doesNotMatch(r.stderr, /SqliteError/);
    assert.doesNotMatch(r.stderr, /\n    at /);

    // The live file is byte-identical to before: still a valid DB, 2 notes.
    const check = runScript('integrity.js', [dbPath], { DB_PATH: dbPath });
    assert.equal(check.status, 0, `integrity failed: ${check.stdout} ${check.stderr}`);
    assert.equal(JSON.parse(check.stdout).notes, 2);

    await startServer();
    const health = await req('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.notes, 2);
  });

  it('a backup with a benign extra table is rejected; the live DB survives', async () => {
    await createNote('survivor-one');
    const backupFile = path.join(tmpDir, 'extra-table-backup.db');
    const b = runScript('backup.js', [backupFile], { DB_PATH: dbPath });
    assert.equal(b.status, 0, `backup failed: ${b.stderr}`);

    const extra = new Database(backupFile);
    extra.exec('CREATE TABLE harmless_extra (id INTEGER PRIMARY KEY, v TEXT);');
    extra.close();

    await stopServer();
    const r = runScript('restore.js', [backupFile, dbPath], { PORT: '0', DB_PATH: dbPath });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BACKUP_INVALID/);
    assert.match(r.stderr, /harmless_extra/);

    await startServer();
    const health = await req('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.notes, 1);
  });
});

describe('F4: owner-only file modes', () => {
  it('the database file is 0600', () => {
    assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
  });

  it('backup files are 0600', async () => {
    await createNote('mode check');
    const backupFile = path.join(tmpDir, 'backup.db');
    const b = runScript('backup.js', [backupFile], { DB_PATH: dbPath });
    assert.equal(b.status, 0, `backup failed: ${b.stderr}`);
    assert.equal(fs.statSync(backupFile).mode & 0o777, 0o600);
  });
});
