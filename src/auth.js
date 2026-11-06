'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .run(token, userId, expires.toISOString());
  // housekeeping
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  return { token, expires };
}

function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.email, u.username, u.is_admin FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token);
  return row || null;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Express middleware: attaches req.user (null when logged out). */
function attachUser(req, res, next) {
  req.user = getSessionUser(req.cookies[config.sessionCookie]);
  next();
}

/** Middleware for API routes: 401 JSON when not logged in. */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

/** Middleware for HTML pages: redirect to /login when not logged in. */
function requireAuthPage(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

module.exports = { hashPassword, verifyPassword, createSession, getSessionUser, destroySession, attachUser, requireAuth, requireAuthPage };
