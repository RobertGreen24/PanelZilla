'use strict';

/**
 * Client API — mirrors the public shape of Pterodactyl's client API
 * (/api/client/...): list servers, power control, live console, files,
 * backups, subusers and resource stats.
 */
const express = require('express');
const db = require('../db');
const config = require('../config');
const wings = require('../wingsClient');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Small helper: load a server owned by (or shared with) the current user.
function loadServer(req, res) {
  const server = db.prepare(
    `SELECT s.*, e.slug AS egg_slug, e.name AS egg_name, e.icon AS egg_icon,
            p.name AS plan_name, p.ram_mb, p.cpu_percent, p.disk_mb, p.player_slots
     FROM servers s JOIN eggs e ON e.id = s.egg_id JOIN plans p ON p.id = s.plan_id
     WHERE s.uuid = ?`
  ).get(req.params.uuid);
  if (!server) { res.status(404).json({ error: 'Server not found' }); return null; }
  const owner = server.user_id === req.user.id;
  const sub = db.prepare('SELECT permissions FROM subusers WHERE server_id = ? AND user_id = ?')
    .get(server.id, req.user.id);
  if (!owner && !sub) { res.status(403).json({ error: 'You do not have access to this server' }); return null; }
  server.permissions = owner ? ['*'] : JSON.parse(sub.permissions);
  server.is_owner = owner;
  return server;
}

// GET /api/client — account info (Pterodactyl: GET /api/client)
router.get('/', (req, res) => {
  res.json({ attributes: { id: req.user.id, username: req.user.username, email: req.user.email, is_admin: !!req.user.is_admin } });
});

// GET /api/client/servers
router.get('/servers', async (req, res) => {
  const rows = db.prepare(
    `SELECT s.uuid, s.name, s.description, s.node, s.port, s.created_at,
            e.slug AS egg_slug, e.name AS egg_name, e.icon AS egg_icon,
            p.name AS plan_name, p.ram_mb, p.cpu_percent, p.disk_mb, p.player_slots
     FROM servers s JOIN eggs e ON e.id = s.egg_id JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = ? ORDER BY s.created_at DESC`
  ).all(req.user.id);
  const shared = db.prepare(
    `SELECT s.uuid, s.name, s.node, s.port, e.name AS egg_name, e.icon AS egg_icon, sub.permissions
     FROM subusers sub JOIN servers s ON s.id = sub.server_id JOIN eggs e ON e.id = s.egg_id
     WHERE sub.user_id = ?`
  ).all(req.user.id);
  const servers = [];
  for (const s of rows) {
    let state = 'offline', stats = null;
    try { const w = await wings.get(s.uuid); state = w.state; stats = w.stats; } catch (_) { /* node unreachable */ }
    servers.push({ ...s, state, stats, is_owner: true, permissions: ['*'] });
  }
  for (const s of shared) servers.push({ ...s, is_owner: false, permissions: JSON.parse(s.permissions) });
  res.json({ data: servers });
});

// GET /api/client/servers/:uuid
router.get('/servers/:uuid', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  let wingsData = null;
  try { wingsData = await wings.get(server.uuid); } catch (e) { return res.status(502).json({ error: 'Node daemon unreachable: ' + e.message }); }
  res.json({ attributes: { ...server, state: wingsData.state, stats: wingsData.stats, address: wingsData.address } });
});

// POST /api/client/servers/:uuid/power { action: start|stop|restart|kill }
router.post('/servers/:uuid/power', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.permissions.includes('*') && !server.permissions.includes('power'))
    return res.status(403).json({ error: 'Missing power permission' });
  const action = (req.body || {}).action;
  if (!['start', 'stop', 'restart', 'kill'].includes(action))
    return res.status(400).json({ error: 'action must be start|stop|restart|kill' });
  try {
    const result = await wings.power(server.uuid, action);
    res.json({ attributes: result });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// POST /api/client/servers/:uuid/command { command } — send to console
router.post('/servers/:uuid/command', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.permissions.includes('*') && !server.permissions.includes('console'))
    return res.status(403).json({ error: 'Missing console permission' });
  const command = (req.body || {}).command;
  if (!command || typeof command !== 'string') return res.status(400).json({ error: 'command is required' });
  try { await wings.command(server.uuid, command); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// GET /api/client/servers/:uuid/console — live console stream (SSE proxy)
router.get('/servers/:uuid/console', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.permissions.includes('*') && !server.permissions.includes('console'))
    return res.status(403).json({ error: 'Missing console permission' });
  let upstream;
  try {
    upstream = await fetch(wings.consoleStreamUrl(server.uuid), {
      headers: { Authorization: `Bearer ${config.wingsApiKey}` },
    });
  } catch (e) {
    return res.status(502).json({ error: 'Node daemon unreachable' });
  }
  res.writeHead(upstream.status, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  const pump = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) { await new Promise(r => res.once('drain', r)); }
      }
    } catch (_) { /* client disconnected */ }
    res.end();
  };
  pump();
  req.on('close', () => reader.cancel().catch(() => {}));
});

// GET /api/client/servers/:uuid/stats
router.get('/servers/:uuid/stats', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  try { res.json({ attributes: await wings.stats(server.uuid) }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// ---- files ----------------------------------------------------------------
router.get('/servers/:uuid/files', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.permissions.includes('*') && !server.permissions.includes('file'))
    return res.status(403).json({ error: 'Missing file permission' });
  try { res.json(await wings.listFiles(server.uuid, req.query.dir || '/')); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

router.get('/servers/:uuid/files/content', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.permissions.includes('*') && !server.permissions.includes('file'))
    return res.status(403).json({ error: 'Missing file permission' });
  try { res.json(await wings.readFile(server.uuid, req.query.path || '')); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

router.put('/servers/:uuid/files', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.permissions.includes('*') && !server.permissions.includes('file'))
    return res.status(403).json({ error: 'Missing file permission' });
  const { path: p, content } = req.body || {};
  if (!p) return res.status(400).json({ error: 'path is required' });
  try { res.json(await wings.writeFile(server.uuid, p, content || '')); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

router.delete('/servers/:uuid/files', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.permissions.includes('*') && !server.permissions.includes('file'))
    return res.status(403).json({ error: 'Missing file permission' });
  try { res.json(await wings.deleteFile(server.uuid, req.query.path || '')); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// ---- backups ---------------------------------------------------------------
router.get('/servers/:uuid/backups', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  try { res.json(await wings.listBackups(server.uuid)); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

router.post('/servers/:uuid/backups', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.permissions.includes('*') && !server.permissions.includes('backup'))
    return res.status(403).json({ error: 'Missing backup permission' });
  try { res.json({ attributes: await wings.createBackup(server.uuid) }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

router.post('/servers/:uuid/backups/:backupId/restore', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.permissions.includes('*') && !server.permissions.includes('backup'))
    return res.status(403).json({ error: 'Missing backup permission' });
  try { res.json(await wings.restoreBackup(server.uuid, req.params.backupId)); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

router.delete('/servers/:uuid/backups/:backupId', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.permissions.includes('*') && !server.permissions.includes('backup'))
    return res.status(403).json({ error: 'Missing backup permission' });
  try { res.json(await wings.deleteBackup(server.uuid, req.params.backupId)); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

router.get('/servers/:uuid/backups/:backupId/download', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  const upstream = await fetch(wings.backupDownloadUrl(server.uuid, req.params.backupId), {
    headers: { Authorization: `Bearer ${config.wingsApiKey}` },
  });
  if (!upstream.ok) return res.status(upstream.status).json({ error: 'Backup not found' });
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${req.params.backupId}.tar.gz"`,
  });
  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(Buffer.from(value))) await new Promise(r => res.once('drain', r));
  }
  res.end();
});

// ---- subusers ---------------------------------------------------------------
const PERMISSIONS = ['console', 'power', 'file', 'backup', 'settings'];

router.get('/servers/:uuid/subusers', (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.is_owner) return res.status(403).json({ error: 'Only the owner can manage subusers' });
  const rows = db.prepare(
    `SELECT sub.id, sub.permissions, u.id AS user_id, u.username, u.email
     FROM subusers sub JOIN users u ON u.id = sub.user_id WHERE sub.server_id = ?`
  ).all(server.id);
  res.json({ data: rows.map(r => ({ ...r, permissions: JSON.parse(r.permissions) })) });
});

router.post('/servers/:uuid/subusers', (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.is_owner) return res.status(403).json({ error: 'Only the owner can manage subusers' });
  const { email, permissions } = req.body || {};
  const user = db.prepare('SELECT id, username, email FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user) return res.status(404).json({ error: 'No user with that email' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot add yourself' });
  const perms = Array.isArray(permissions) ? permissions.filter(p => PERMISSIONS.includes(p)) : [];
  db.prepare('INSERT OR REPLACE INTO subusers (server_id, user_id, permissions) VALUES (?,?,?)')
    .run(server.id, user.id, JSON.stringify(perms));
  res.json({ ok: true, user, permissions: perms });
});

router.delete('/servers/:uuid/subusers/:subId', (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.is_owner) return res.status(403).json({ error: 'Only the owner can manage subusers' });
  db.prepare('DELETE FROM subusers WHERE id = ? AND server_id = ?').run(req.params.subId, server.id);
  res.json({ ok: true });
});

// ---- server settings ---------------------------------------------------------
router.patch('/servers/:uuid', (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  if (!server.permissions.includes('*') && !server.permissions.includes('settings'))
    return res.status(403).json({ error: 'Missing settings permission' });
  const { name, description } = req.body || {};
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 3) return res.status(400).json({ error: 'Name must be at least 3 characters' });
    db.prepare('UPDATE servers SET name = ? WHERE id = ?').run(name.trim(), server.id);
  }
  if (description !== undefined) {
    db.prepare('UPDATE servers SET description = ? WHERE id = ?').run(String(description).slice(0, 200), server.id);
  }
  res.json({ ok: true });
});

module.exports = router;
