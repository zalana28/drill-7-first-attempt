'use strict';

/**
 * Check a notevault database file: exists, integrity_check, row count.
 *
 * Usage: node scripts/integrity.js [dbPath]
 *   dbPath defaults to ./data/notevault.db (or DB_PATH env).
 *   Exit 0 when the file exists and integrity is ok, else 1.
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
  const db = new Database(dbPath, { readonly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const notes = db.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
    console.log(JSON.stringify({ ok: integrity === 'ok', dbPath, exists: true, integrity, notes }));
    if (integrity !== 'ok') process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
