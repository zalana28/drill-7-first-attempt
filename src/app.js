'use strict';

/**
 * Express app for notevault.
 *
 * /health is the honest one: it checks the database FILE exists, runs
 * PRAGMA integrity_check, and runs a real COUNT(*) query. A process that
 * only answers "I'm alive" is not healthy (B5 finding F8: /health returned
 * ok while the database file was gone and writes landed in an unlinked
 * inode). Writes fail closed with 503 DB_UNAVAILABLE when the file is gone.
 */
const express = require('express');
const { createDb, dbFileExists, integrityCheck, createNote, listNotes, getNote, updateNote, deleteNote, countNotes } = require('./db');

const MAX_TITLE = 200;
const MAX_BODY = 10000;

function validateNote(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (typeof body.title !== 'string' || body.title.trim().length === 0) return 'title is required';
  if (body.title.trim().length > MAX_TITLE) return 'title must be at most 200 characters';
  if (body.body !== undefined && typeof body.body !== 'string') return 'body must be a string';
  if (typeof body.body === 'string' && body.body.length > MAX_BODY) return 'body must be at most 10000 characters';
  return null;
}

function createApp(dbPath) {
  const db = createDb(dbPath);
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  // Fail-closed guard for every write: the DB file must exist on disk.
  function requireDbFile(req, res, next) {
    if (!dbFileExists(dbPath)) {
      return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'database file is missing' });
    }
    return next();
  }

  app.get('/health', (req, res) => {
    if (!dbFileExists(dbPath)) {
      return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE', message: 'database file is missing' });
    }
    let integrity;
    try {
      integrity = integrityCheck(db);
    } catch (err) {
      return res.status(503).json({ ok: false, error: 'DB_ERROR', message: String(err.message || err) });
    }
    if (integrity !== 'ok') {
      return res.status(503).json({ ok: false, error: 'DB_CORRUPT', message: `integrity_check: ${integrity}` });
    }
    let n;
    try {
      n = countNotes(db);
    } catch (err) {
      return res.status(503).json({ ok: false, error: 'DB_ERROR', message: String(err.message || err) });
    }
    return res.json({ ok: true, notes: n });
  });

  app.post('/notes', requireDbFile, (req, res) => {
    const err = validateNote(req.body);
    if (err) return res.status(400).json({ error: 'VALIDATION', message: err });
    const note = createNote(db, req.body.title.trim(), req.body.body || '');
    return res.status(201).json(note);
  });

  app.get('/notes', (req, res) => {
    if (!dbFileExists(dbPath)) {
      return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'database file is missing' });
    }
    return res.json(listNotes(db));
  });

  app.get('/notes/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'VALIDATION', message: 'id must be a positive integer' });
    if (!dbFileExists(dbPath)) {
      return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'database file is missing' });
    }
    const note = getNote(db, id);
    if (!note) return res.status(404).json({ error: 'NOT_FOUND', message: `note ${id} not found` });
    return res.json(note);
  });

  app.put('/notes/:id', requireDbFile, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'VALIDATION', message: 'id must be a positive integer' });
    const err = validateNote(req.body);
    if (err) return res.status(400).json({ error: 'VALIDATION', message: err });
    const note = updateNote(db, id, req.body.title.trim(), req.body.body || '');
    if (!note) return res.status(404).json({ error: 'NOT_FOUND', message: `note ${id} not found` });
    return res.json(note);
  });

  app.delete('/notes/:id', requireDbFile, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'VALIDATION', message: 'id must be a positive integer' });
    if (!deleteNote(db, id)) return res.status(404).json({ error: 'NOT_FOUND', message: `note ${id} not found` });
    return res.status(204).send();
  });

  // JSON parse errors -> 400, never 500.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'malformed JSON body' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'body exceeds 100kb' });
    }
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'unexpected error' });
  });

  return { app, db };
}

module.exports = { createApp };
