'use strict';

/**
 * Backup the notevault database with the SQLite online backup API.
 *
 * Usage: node scripts/backup.js [destination]
 *   destination defaults to ./data/notevault-backup-<YYYYMMDD-HHmmss>.db
 *   DB_PATH env overrides the source database path.
 *
 * After copying, the backup is opened and verified (integrity_check +
 * row count) before the script reports success. A backup that cannot be
 * verified is not reported as good.
 *
 * The source connection stays open until the async backup finishes — closing
 * it early aborts the backup ("The database connection is not open").
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

async function main() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'notevault.db');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dest = process.argv[2] || path.join(__dirname, '..', 'data', `notevault-backup-${stamp}.db`);

  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ ok: false, error: 'DB_MISSING', dbPath }));
    process.exitCode = 1;
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(dest);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: 'BACKUP_FAILED', message: String(err.message || err) }));
    process.exitCode = 1;
    return;
  } finally {
    db.close();
  }

  try {
    fs.chmodSync(dest, 0o600); // Drill #8 F4: owner-only.
  } catch {
    // chmod is hardening, not data — continue if the filesystem refuses.
  }

  let check;
  try {
    check = new Database(dest, { readonly: true });
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: 'BACKUP_UNREADABLE', dest, message: String(err.message || err) }));
    process.exitCode = 1;
    return;
  }
  try {
    const integrity = check.prepare('PRAGMA integrity_check').get().integrity_check;
    const notes = check.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
    if (integrity !== 'ok') {
      console.error(JSON.stringify({ ok: false, error: 'BACKUP_CORRUPT', dest, integrity }));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ok: true, dest, notes, integrity }));
  } catch (err) {
    // Drill #8 F2: verification failures are clean JSON, never a stack trace.
    console.error(JSON.stringify({ ok: false, error: 'BACKUP_UNREADABLE', dest, message: String(err.message || err) }));
    process.exitCode = 1;
  } finally {
    check.close();
  }
}

main();
