'use strict';

/**
 * Check a notevault database file: exists, integrity_check, row count.
 *
 * Usage: node scripts/integrity.js [dbPath]
 *   dbPath defaults to ./data/notevault.db (or DB_PATH env).
 *   Exit 0 when the file exists and integrity is ok, else 1.
 *
 * Drill #8 F2: a non-database file used to crash this script with an
 * uncaught SqliteError stack trace. All failures are now clean JSON.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function main() {
  const dbPath = process.argv[2] || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'notevault.db');
  if (!fs.existsSync(dbPath)) {
    console.log(JSON.stringify({ ok: false, dbPath, exists: false }));
    process.exitCode = 1;
    return;
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    console.log(JSON.stringify({ ok: false, dbPath, exists: true, error: 'NOT_A_DATABASE', message: String(err.message || err) }));
    process.exitCode = 1;
    return;
  }
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const notes = db.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
    console.log(JSON.stringify({ ok: integrity === 'ok', dbPath, exists: true, integrity, notes }));
    if (integrity !== 'ok') process.exitCode = 1;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, dbPath, exists: true, error: 'NOT_A_DATABASE', message: String(err.message || err) }));
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
