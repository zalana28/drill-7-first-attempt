# notevault

Notes service: Express + SQLite CRUD with a `/health` that checks the real
database, plus CLI backup/restore.

Built for **Drill #7 — First-Attempt Validity**: the evidence this service
produces must be valid on the first demo. The design carries the lessons
from the earlier break/recover work (B5): a health endpoint that only
answers "I'm alive" is a lie, a database file can disappear while the
process keeps serving from an unlinked inode, and a restore under a live
server silently restores nothing.

## Quickstart

```bash
npm install
npm test            # 10 tests, plain node:test
npm start           # PORT=18080, DB_PATH=./data/notevault.db
```

Environment: `PORT` (default 18080), `DB_PATH` (default `./data/notevault.db`).

## API

| Method | Route | Success | Notes |
|---|---|---|---|
| GET | `/health` | 200 `{ok:true, notes:N}` | Checks the DB **file** exists, runs `PRAGMA integrity_check`, and a real `COUNT(*)`. File missing or corrupt → 503 |
| POST | `/notes` | 201 note | `{title, body?}`; title required, ≤200 chars; body ≤10000 chars |
| GET | `/notes` | 200 list | Ordered by id |
| GET | `/notes/:id` | 200 note / 404 | |
| PUT | `/notes/:id` | 200 note / 404 | Same validation as POST |
| DELETE | `/notes/:id` | 204 / 404 | |

Writes fail closed with `503 DB_UNAVAILABLE` when the database file is
missing — they never land in an unlinked inode.

## Backup / restore

```bash
npm run backup                          # writes data/notevault-backup-<ts>.db, verifies it
npm run restore <backup> [dbPath]       # refuses while a server answers on $PORT
npm run db:integrity [dbPath]           # exists + integrity_check + row count
```

Restore safety rules:

1. **Refuses while a server is running.** Restoring under a live server
   leaves the server bound to the old (unlinked) inode. Stop the server
   first.
2. **Saves the current database** as `<db>.pre-restore-<timestamp>` before
   overwriting, so a bad restore can be rolled back.
3. **Verifies the restored file** (integrity + row count) before reporting
   success.

## Pre-flight checklist (run before claiming any evidence)

1. Liveness via port, not pidfile: `ss -ltnp | grep $PORT`
2. Port owner is the intended process: `ps -p <pid> -o pid,cmd`
3. DB file exists + integrity + row count: `node scripts/integrity.js`
4. Fresh environment: free port, fresh DB, `npm ci`-clean modules,
   no stale server.

## Security (Drill #8 — self-red-team, 2026-11-19)

Attacked my own service (own sandbox instance, ~80 requests, no DoS /
destructive / exfiltration). Four real findings, all fixed, all locked in
by `tests/redteam.test.js`:

| # | Finding | Fix |
|---|---|---|
| F1 | Restore's server check was HTTP-based — a hung listener holding the port but never answering `/health` did not block a restore. | Liveness is now a raw TCP connect: if the port accepts a connection, refuse. |
| F2 | Restore overwrote the live DB *before* verifying the backup; a non-database backup destroyed the live file and crashed the script with an uncaught `SqliteError`. | The backup is verified first (integrity + count); failures are clean JSON and leave the live DB untouched; a failed restore rolls back from the pre-restore snapshot. `integrity.js` and `backup.js` got the same clean-error treatment. |
| F3 | `X-Powered-By: Express` on every response. | `app.disable('x-powered-by')`. |
| F4 | Database and backup files were group/world-readable under a permissive umask. | Files are created owner-only (`0600`). |

Tested and held (no finding): SQL injection (parameterized queries —
injection is stored literally), id validation, body limit (413),
malformed JSON (400), NUL/CRLF round-trip, duplicate submission (no
idempotency by design), restore refusal while the server answers,
backup consistency under 50 concurrent writes (59 rows, ids 1–59
contiguous), backup to a symlinked destination (refused: target is not
a database), and `/health` / error bodies (no paths, no stack traces).
No authentication by design (drill #7 scope) — that is not a finding.

## Tests (19, `node --test`)

| Group | Tests |
|---|---|
| health | fresh DB reports ok with 0 notes |
| CRUD | create / list / get (+404) / update (+404) / delete (+404) / validation 400s |
| race | 20 parallel creates all persist with distinct ids |
| db-missing | renaming the DB file → health and writes 503; restoring the file brings data back |
| backup/restore CLI | backup → delete DB → restore (server stopped) → row count intact |

## Design notes

- `better-sqlite3` (synchronous): every write is atomic, so parallel
  creates serialize instead of racing. `node:sqlite` was not used because
  the test runner could not load it in this sandbox (B3 lesson).
- `journal_mode = DELETE` (single file): the DB-missing state is
  unambiguous — one file, present or not.
- `/health` checks, in order: file exists → `integrity_check` → real
  `COUNT(*)`. The file-exists check comes first on purpose: a live
  connection can pass the other two checks from an unlinked inode.
