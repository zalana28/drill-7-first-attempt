'use strict';

/**
 * Benign canary demo for Drill #8 follow-up (F5).
 *
 * Proves, end to end, that restore.js refuses a VALID database backup
 * carrying a trigger — and that the trigger in question is LIVE, not inert.
 *
 * The canary is deliberately harmless: a trigger on `notes` that only
 * INSERTs one row into a `canary_log` table on the next INSERT. No data
 * is deleted, exfiltrated, or altered; the whole demo runs on disposable
 * files in a temp dir, against the project's own code only.
 *
 * Steps:
 *   1. Build live.db (1 note) and canary-backup.db (same note + canary_log
 *      + AFTER INSERT trigger on notes).
 *   2. Prove the trigger fires: INSERT a note into the canary backup and
 *      show canary_log go from 0 rows to 1.
 *   3. Run `node scripts/restore.js canary-backup.db live.db` (PORT=0).
 *   4. Show the restore is refused (exit 1, BACKUP_INVALID, trigger named)
 *      and live.db is byte-identical afterwards (md5 + note count + no
 *      trigger in sqlite_master).
 *
 * Usage: node scripts/demo-canary-restore.js
 * Exit 0 = demo behaved as expected (restore refused, live DB untouched).
 * Exit 1 = something behaved differently — read the output.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { createDb, createNote } = require('../src/db');

const ROOT = path.join(__dirname, '..');

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function schemaObjects(db) {
  return db.prepare('SELECT type, name FROM sqlite_master ORDER BY type, name').all();
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notevault-canary-'));
  const livePath = path.join(dir, 'live.db');
  const canaryPath = path.join(dir, 'canary-backup.db');
  let failed = false;
  const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failed = true;
  };

  // 1. Build the two databases.
  const live = createDb(livePath);
  createNote(live, 'live note', 'must survive');
  live.close();
  fs.copyFileSync(livePath, canaryPath);
  const canary = new Database(canaryPath);
  canary.exec(`CREATE TABLE canary_log (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL);
    CREATE TRIGGER trg_canary_after_insert AFTER INSERT ON notes
    BEGIN INSERT INTO canary_log (note) VALUES ('canary-fired'); END;`);
  const beforeFire = canary.prepare('SELECT COUNT(*) AS n FROM canary_log').get().n;
  canary.close();

  // 2. Prove the trigger is LIVE: one INSERT into notes fires it.
  const fire = new Database(canaryPath);
  fire.prepare("INSERT INTO notes (title, body, created_at, updated_at) VALUES ('probe', '', '2026-11-19', '2026-11-19')").run();
  const afterFire = fire.prepare('SELECT COUNT(*) AS n FROM canary_log').get().n;
  const canaryRow = fire.prepare('SELECT note FROM canary_log LIMIT 1').get();
  fire.close();
  console.log(`canary_log rows before INSERT: ${beforeFire}, after INSERT: ${afterFire} (row: ${JSON.stringify(canaryRow)})`);
  check('trigger fires on next DML (canary is live, not inert)', afterFire === beforeFire + 1 && canaryRow.note === 'canary-fired');

  // 3. Snapshot the live DB, then attempt the restore.
  const liveMd5Before = md5(livePath);
  const liveBefore = new Database(livePath, { readonly: true });
  const liveCountBefore = liveBefore.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
  liveBefore.close();
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'restore.js'), canaryPath, livePath], {
    env: { ...process.env, PORT: '0' },
    encoding: 'utf8',
  });
  console.log(`restore exit code: ${r.status}`);
  console.log(`restore stderr: ${r.stderr.trim()}`);

  // 4. Before/after on the live DB.
  const liveMd5After = md5(livePath);
  const liveDb = new Database(livePath, { readonly: true });
  const liveCountAfter = liveDb.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
  const liveTriggers = schemaObjects(liveDb).filter((o) => o.type === 'trigger');
  liveDb.close();
  console.log(`live.db md5 before: ${liveMd5Before}`);
  console.log(`live.db md5 after:  ${liveMd5After}`);
  console.log(`live.db notes before: ${liveCountBefore}, after: ${liveCountAfter}; triggers in live.db: ${liveTriggers.length}`);

  check('restore refused (exit 1)', r.status === 1);
  check('refusal names BACKUP_INVALID', /BACKUP_INVALID/.test(r.stderr));
  check('refusal names the trigger', /trg_canary_after_insert/.test(r.stderr));
  check('live.db byte-identical (md5 unchanged)', liveMd5Before === liveMd5After);
  check('live.db note count unchanged', liveCountBefore === liveCountAfter && liveCountAfter === 1);
  check('no trigger leaked into live.db', liveTriggers.length === 0);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? 'DEMO RESULT: FAIL — see above' : 'DEMO RESULT: PASS — trigger-bearing backup refused, live DB untouched');
  process.exitCode = failed ? 1 : 0;
}

main();
