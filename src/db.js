'use strict';

/**
 * SQLite storage for notevault.
 *
 * Lessons carried in from earlier work (B5 / Challenge C):
 * - The database file is the source of truth. A live connection can keep
 *   serving from an UNLINKED inode after the file is renamed/deleted, so
 *   every health/write check must first verify the FILE exists on disk.
 * - No silent recovery: if the file is gone, the app fails closed (503),
 *   it never pretends to be healthy.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function createDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

/** True only when the database FILE exists on disk right now. */
function dbFileExists(dbPath) {
  try {
    return fs.existsSync(dbPath);
  } catch {
    return false;
  }
}

/** Run PRAGMA integrity_check on a live connection. Returns 'ok' or the error text. */
function integrityCheck(db) {
  const row = db.prepare('PRAGMA integrity_check').get();
  return row ? row.integrity_check : 'no result';
}

function createNote(db, title, body) {
  const now = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO notes (title, body, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(title, body, now, now);
  return getNote(db, Number(info.lastInsertRowid));
}

function listNotes(db) {
  return db.prepare('SELECT id, title, body, created_at, updated_at FROM notes ORDER BY id ASC').all();
}

function getNote(db, id) {
  return (
    db.prepare('SELECT id, title, body, created_at, updated_at FROM notes WHERE id = ?').get(id) || null
  );
}

function updateNote(db, id, title, body) {
  const now = new Date().toISOString();
  const info = db
    .prepare('UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?')
    .run(title, body, now, id);
  if (info.changes === 0) return null;
  return getNote(db, id);
}

function deleteNote(db, id) {
  return db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes > 0;
}

function countNotes(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
}

module.exports = {
  createDb,
  dbFileExists,
  integrityCheck,
  createNote,
  listNotes,
  getNote,
  updateNote,
  deleteNote,
  countNotes,
};
