'use strict';

const path = require('path');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 18080);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'notevault.db');

const { app, db } = createApp(DB_PATH);

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
