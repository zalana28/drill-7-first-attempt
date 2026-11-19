'use strict';

const path = require('path');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 18080);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'notevault.db');

let app;
let db;
try {
  ({ app, db } = createApp(DB_PATH));
} catch (err) {
  // Drill #8: a corrupt/unreadable database must fail with a clean error,
  // never an uncaught stack trace.
  console.error(JSON.stringify({ ok: false, error: 'DB_UNUSABLE', message: String(err.message || err) }));
  process.exit(1);
}

const server = app.listen(PORT, () => {
  console.log(JSON.stringify({ event: 'listening', port: PORT, pid: process.pid, dbPath: DB_PATH }));
});

function shutdown(signal) {
  server.close(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    process.exit(0);
  });
  // If connections hang, force exit after 2s rather than hanging forever.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
