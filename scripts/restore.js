'use strict';

/**
 * Restore the notevault database from a backup file.
 *
 * Usage: node scripts/restore.js <backup> [dbPath]
 *   dbPath defaults to ./data/notevault.db (or DB_PATH env).
 *   PORT env (default 18080) is the port a running server would answer on.
 *
 * Safety rules (B5 / Challenge C, hardened in Drill #8):
 * 1. VERIFY THE BACKUP FIRST. The backup is opened read-only and checked
 *    (integrity_check + row count + SCHEMA) BEFORE the live database is
 *    touched. A corrupt or non-database backup used to overwrite the live
 *    file and only fail afterwards (Drill #8 F2) — now it is a clean
 *    no-op. Schema check (Drill #8 follow-up, F5): the backup's
 *    sqlite_master must contain exactly table:notes and
 *    table:sqlite_sequence — ANY trigger (type='trigger'), view, index,
 *    or extra table is rejected. A table-only whitelist is NOT enough:
 *    a trigger attached to the notes table itself passes it, so triggers
 *    are rejected explicitly, whatever they attach to.
 * 2. REFUSE while anything listens on $PORT. The check is a raw TCP
 *    connect, not an HTTP request: a hung server that holds the port but
 *    never answers /health used to slip past the old fetch-based check
 *    (Drill #8 F1). If the port accepts a connection, refuse.
 * 3. SAVE the current database as <dbPath>.pre-restore-<timestamp> before
 *    overwriting, so a bad restore can be rolled back.
 * 4. VERIFY the restored file (integrity_check + row count) before
 *    reporting success; on failure, roll back from the pre-restore
 *    snapshot when one exists.
 * 5. All failures are clean JSON on stderr with exit 1 — never an uncaught
 *    stack trace (Drill #8 F2: SQLITE_NOTADB used to crash the script).
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const Database = require('better-sqlite3');

function fail(error, message, extra) {
  console.error(JSON.stringify({ ok: false, error, message, ...extra }));
  process.exitCode = 1;
}

/** True when something accepts a TCP connection on the port (listening). */
function portIsListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 1000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Open a database file read-only and verify it. Throws a clean Error on failure. */
function verifyDbFile(filePath, label) {
  let check;
  try {
    check = new Database(filePath, { readonly: true });
  } catch (err) {
    throw new Error(`${label}: cannot open (${String(err.message || err)})`);
  }
  try {
    const integrity = check.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') throw new Error(`${label}: integrity_check: ${integrity}`);
    // F5: schema validation. The only objects a notevault database may
    // contain are the notes table and sqlite_sequence (AUTOINCREMENT).
    // Triggers are rejected explicitly and unconditionally — a trigger
    // attached to notes itself would pass a table-only whitelist, and a
    // trigger is executable code that runs on the next DML after restore.
    // Rejected (fail closed), never stripped: stripping would silently
    // change what the backup means.
    const objects = check.prepare('SELECT type, name FROM sqlite_master ORDER BY type, name').all();
    const triggers = objects.filter((o) => o.type === 'trigger');
    if (triggers.length > 0) {
      throw new Error(
        `${label}: schema rejected: ${triggers.length} trigger(s) present (${triggers.map((t) => t.name).join(', ')}) — triggers are never allowed in a notevault backup`
      );
    }
    const allowed = new Set(['table:notes', 'table:sqlite_sequence']);
    const unexpected = objects.filter((o) => !allowed.has(`${o.type}:${o.name}`));
    if (unexpected.length > 0) {
      throw new Error(
        `${label}: schema rejected: unexpected object(s) ${unexpected.map((o) => `${o.type}:${o.name}`).join(', ')} — expected only table:notes and table:sqlite_sequence`
      );
    }
    const notes = check.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
    return { integrity, notes };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(label)) throw err;
    throw new Error(`${label}: not a usable notevault database (${String(err.message || err)})`);
  } finally {
    check.close();
  }
}

async function main() {
  const backup = process.argv[2];
  if (!backup) {
    fail('USAGE', 'node scripts/restore.js <backup> [dbPath]');
    return;
  }
  const dbPath = process.argv[3] || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'notevault.db');
  const port = Number(process.env.PORT || 18080);

  if (!fs.existsSync(backup)) {
    fail('BACKUP_MISSING', `backup file not found: ${backup}`, { backup });
    return;
  }

  // Rule 1: verify the backup BEFORE touching the live database.
  let backupInfo;
  try {
    backupInfo = verifyDbFile(backup, 'backup');
  } catch (err) {
    fail('BACKUP_INVALID', err.message, { backup });
    return;
  }

  // Rule 2: refuse while anything listens on the server port.
  if (await portIsListening(port)) {
    fail(
      'SERVER_RUNNING',
      `something listens on port ${port}; stop the server before restoring`,
      { port }
    );
    return;
  }

  // Rule 3: snapshot the current database for rollback.
  let preRestore = null;
  if (fs.existsSync(dbPath)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    preRestore = `${dbPath}.pre-restore-${stamp}`;
    fs.copyFileSync(dbPath, preRestore);
  }

  fs.copyFileSync(backup, dbPath);
  try {
    fs.chmodSync(dbPath, 0o600); // Drill #8 F4: owner-only.
  } catch {
    // chmod is hardening, not data — continue if the filesystem refuses.
  }

  // Rule 4: verify the restored file; roll back on failure.
  try {
    const restored = verifyDbFile(dbPath, 'restored');
    console.log(JSON.stringify({ ok: true, dbPath, notes: restored.notes, integrity: restored.integrity, preRestore }));
  } catch (err) {
    if (preRestore && fs.existsSync(preRestore)) {
      try {
        fs.copyFileSync(preRestore, dbPath);
      } catch {
        // rollback itself failed — report both facts, do not hide either.
        fail('RESTORE_FAILED_ROLLBACK_FAILED', `${err.message}; rollback from ${preRestore} also failed`, { dbPath, preRestore });
        return;
      }
      fail('RESTORE_FAILED_ROLLED_BACK', err.message, { dbPath, preRestore });
      return;
    }
    fail('RESTORE_FAILED', err.message, { dbPath, preRestore });
  }
}

main();
