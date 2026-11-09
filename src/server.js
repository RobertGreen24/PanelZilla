'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const storeRoutes = require('./routes/store');
const clientRoutes = require('./routes/client');
const adminRoutes = require('./routes/admin');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(auth.attachUser);

// ------------------------------------------------------------ auth pages ---
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'auth.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'auth.html')));

// ------------------------------------------------------------- auth API ----
app.post('/api/auth/register', (req, res) => {
  const { email, username, password } = req.body || {};
  if (!email || !username || !password) return res.status(400).json({ error: 'Email, username and password are required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (username.length < 3 || username.length > 24) return res.status(400).json({ error: 'Username must be 3-24 characters' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email.toLowerCase(), username);
  if (exists) return res.status(409).json({ error: 'Email or username already in use' });
  const id = db.prepare('INSERT INTO users (email, username, password_hash) VALUES (?,?,?)')
    .run(email.toLowerCase(), username, auth.hashPassword(password)).lastInsertRowid;
  const { token, expires } = auth.createSession(id);
  res.cookie(config.sessionCookie, token, { httpOnly: true, sameSite: 'lax', expires });
  res.json({ ok: true, user: { id, username, email: email.toLowerCase() } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user || !auth.verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const { token, expires } = auth.createSession(user.id);
  res.cookie(config.sessionCookie, token, { httpOnly: true, sameSite: 'lax', expires });
  res.json({ ok: true, user: { id: user.id, username: user.username, email: user.email } });
});

app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(req.cookies[config.sessionCookie]);
  res.clearCookie(config.sessionCookie);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user });
});

// --------------------------------------------------------------- API -------
app.use('/api/store', storeRoutes);
app.use('/api/client', clientRoutes);
app.use('/api/admin', adminRoutes);

// -------------------------------------------------------------- pages ------
const pages = [
  { route: '/', file: 'index.html', guard: false },
  { route: '/store', file: 'store.html', guard: false },
  { route: '/dashboard', file: 'dashboard.html', guard: true },
  { route: '/server/:uuid', file: 'server.html', guard: true },
  { route: '/admin', file: 'admin.html', guard: 'admin' },
];
const noop = (req, res, next) => next();
for (const p of pages) {
  const guard = p.guard === 'admin' ? auth.requireAdminPage : p.guard ? auth.requireAuthPage : noop;
  app.get(p.route, guard, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', p.file));
  });
}

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[panel] error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (e) => console.error('[panel] unhandled rejection:', e));

app.listen(config.port, config.host, () => {
  console.log(`[panel] ${config.siteName} panel listening on http://${config.host}:${config.port}`);
  console.log(`[panel] node daemon (wings) at ${config.wingsUrl}`);
});
