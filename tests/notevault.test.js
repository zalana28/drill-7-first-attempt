'use strict';

/**
 * notevault test suite — 10 tests, plain node:test (no extra runner).
 *
 * Includes the two tests the drill demands:
 *  - race: 20 parallel creates must all persist with distinct ids.
 *  - db-missing: renaming the DB file while the server runs must make
 *    /health and writes fail closed (503), and restoring the file must
 *    bring the data back.
 * Plus a full backup -> delete -> restore CLI round-trip (with the server
 * stopped for the restore step, per the restore script's safety rule).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
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

async function req(method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // empty body (e.g. 204) is fine
  }
  return { status: res.status, json, text };
}

async function createNote(title, body = '') {
  const r = await req('POST', '/notes', { title, body });
  assert.equal(r.status, 201, `create ${title} should be 201, got ${r.status}: ${r.text}`);
  return r.json;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notevault-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  await startServer();
});

afterEach(async () => {
  await stopServer();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('health', () => {
  it('fresh DB reports ok with 0 notes', async () => {
    const r = await req('GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.notes, 0);
  });
});

describe('CRUD', () => {
  it('creates a note and returns it with id and timestamps', async () => {
    const note = await createNote('First note', 'hello world');
    assert.equal(note.id, 1);
    assert.equal(note.title, 'First note');
    assert.equal(note.body, 'hello world');
    assert.equal(typeof note.created_at, 'string');
    assert.equal(typeof note.updated_at, 'string');
  });

  it('lists created notes in id order', async () => {
    await createNote('one');
    await createNote('two');
    const r = await req('GET', '/notes');
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.json.map((n) => n.title),
      ['one', 'two']
    );
  });

  it('gets a note by id and 404s for a missing id', async () => {
    const note = await createNote('find me');
    const found = await req('GET', `/notes/${note.id}`);
    assert.equal(found.status, 200);
    assert.equal(found.json.title, 'find me');
    const missing = await req('GET', '/notes/9999');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'NOT_FOUND');
  });

  it('updates a note and 404s for a missing id', async () => {
    const note = await createNote('old title', 'old body');
    const r = await req('PUT', `/notes/${note.id}`, { title: 'new title', body: 'new body' });
    assert.equal(r.status, 200);
    assert.equal(r.json.title, 'new title');
    assert.equal(r.json.body, 'new body');
    const missing = await req('PUT', '/notes/9999', { title: 'x' });
    assert.equal(missing.status, 404);
  });

  it('deletes a note; a later get 404s', async () => {
    const note = await createNote('to delete');
    const del = await req('DELETE', `/notes/${note.id}`);
    assert.equal(del.status, 204);
    const gone = await req('GET', `/notes/${note.id}`);
    assert.equal(gone.status, 404);
    const delAgain = await req('DELETE', `/notes/${note.id}`);
    assert.equal(delAgain.status, 404);
  });

  it('rejects invalid input with 400', async () => {
    assert.equal((await req('POST', '/notes', { title: '   ' })).status, 400);
    assert.equal((await req('POST', '/notes', {})).status, 400);
    assert.equal((await req('POST', '/notes', { title: 'x'.repeat(201) })).status, 400);
    assert.equal((await req('POST', '/notes', { title: 'ok', body: 42 })).status, 400);
    const ok = await req('POST', '/notes', { title: 'valid' });
    assert.equal(ok.status, 201);
  });
});

describe('race', () => {
  it('20 parallel creates all persist with distinct ids', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => req('POST', '/notes', { title: `race-${i}` }))
    );
    assert.equal(
      results.every((r) => r.status === 201),
      true
    );
    const ids = results.map((r) => r.json.id);
    assert.equal(new Set(ids).size, 20);
    const list = await req('GET', '/notes');
    assert.equal(list.json.length, 20);
  });
});

describe('db-missing (fail closed)', () => {
  it('renaming the DB file makes health and writes 503; restoring the file brings data back', async () => {
    const note = await createNote('survivor');
    const gone = `${dbPath}.gone`;
    fs.renameSync(dbPath, gone);
    try {
      const health = await req('GET', '/health');
      assert.equal(health.status, 503);
      assert.equal(health.json.error, 'DB_UNAVAILABLE');
      const write = await req('POST', '/notes', { title: 'must not land' });
      assert.equal(write.status, 503);
      const list = await req('GET', '/notes');
      assert.equal(list.status, 503);
    } finally {
      fs.renameSync(gone, dbPath);
    }
    const health = await req('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.notes, 1);
    const found = await req('GET', `/notes/${note.id}`);
    assert.equal(found.status, 200);
    assert.equal(found.json.title, 'survivor');
  });
});

describe('backup/restore CLI', () => {
  it('backup -> delete DB -> restore (server stopped) -> row count intact', async () => {
    await createNote('backup-one');
    await createNote('backup-two');
    const backupFile = path.join(tmpDir, 'backup.db');

    const b = spawnSync('node', [path.join(ROOT, 'scripts', 'backup.js'), backupFile], {
      env: { ...process.env, DB_PATH: dbPath },
      encoding: 'utf8',
    });
    assert.equal(b.status, 0, `backup.js failed: ${b.stderr}`);
    assert.equal(JSON.parse(b.stdout).ok, true);
    assert.equal(JSON.parse(b.stdout).notes, 2);

    // Simulate total loss: delete the DB file while the server is stopped.
    await stopServer();
    fs.unlinkSync(dbPath);
    assert.equal(fs.existsSync(dbPath), false);

    const r = spawnSync('node', [path.join(ROOT, 'scripts', 'restore.js'), backupFile, dbPath], {
      env: { ...process.env, PORT: '0', DB_PATH: dbPath },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `restore.js failed: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).ok, true);
    assert.equal(JSON.parse(r.stdout).notes, 2);

    // Reopen the server on the restored file and verify the rows are there.
    await startServer();
    const health = await req('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.notes, 2);
    const list = await req('GET', '/notes');
    assert.deepEqual(
      list.json.map((n) => n.title),
      ['backup-one', 'backup-two']
    );
  });
});
