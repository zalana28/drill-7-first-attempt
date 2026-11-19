'use strict';

/**
 * Restore the notevault database from a backup file.
 *
 * Usage: node scripts/restore.js <backup> [dbPath]
 *   dbPath defaults to ./data/notevault.db (or DB_PATH env).
 *   PORT env (default 18080) is the port a running server would answer on.
 *
 * Safety rules (B5 / Challenge C, learned the hard way):
 * 1. REFUSE while a server answers on $PORT. Restoring under a live server
 *    would leave the server bound to the old (unlinked) inode while the new
 *    file sits untouched on disk — silent data loss. Stop the server first.
 * 2. SAVE the current database as <dbPath>.pre-restore-<timestamp> before
 *    overwriting, so a bad restore can be rolled back.
 * 3. VERIFY the restored file (integrity_check + row count) before
 *    reporting success.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

async function serverIsUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.status === 200 || res.status === 503;
  } catch {
    return false;
  }
}

async function main() {
  const backup = process.argv[2];
  if (!backup) {
    console.error(JSON.stringify({ ok: false, error: 'USAGE', message: 'node scripts/restore.js <backup> [dbPath]' }));
    process.exitCode = 1;
    return;
  }
  const dbPath = process.argv[3] || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'notevault.db');
  const port = Number(process.env.PORT || 18080);

  if (!fs.existsSync(backup)) {
    console.error(JSON.stringify({ ok: false, error: 'BACKUP_MISSING', backup }));
    process.exitCode = 1;
    return;
  }

  if (await serverIsUp(port)) {
    console.error(
      JSON.stringify({ ok: false, error: 'SERVER_RUNNING', message: `a server answers on port ${port}; stop it before restoring`, port })
    );
    process.exitCode = 1;
    return;
  }

  let preRestore = null;
  if (fs.existsSync(dbPath)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    preRestore = `${dbPath}.pre-restore-${stamp}`;
    fs.copyFileSync(dbPath, preRestore);
  }

  fs.copyFileSync(backup, dbPath);

  const check = new Database(dbPath, { readonly: true });
  try {
    const integrity = check.prepare('PRAGMA integrity_check').get().integrity_check;
    const notes = check.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
    if (integrity !== 'ok') {
      console.error(JSON.stringify({ ok: false, error: 'RESTORE_CORRUPT', dbPath, integrity, preRestore }));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ok: true, dbPath, notes, integrity, preRestore }));
  } finally {
    check.close();
  }
}

main();
