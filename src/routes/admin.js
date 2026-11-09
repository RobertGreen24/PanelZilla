'use strict';

/**
 * Admin API — /api/admin/* (requires an admin session).
 * Overview stats, user management (promote/demote/delete), server
 * management (list/power/delete across all customers) and orders.
 */
const express = require('express');
const db = require('../db');
const wings = require('../wingsClient');
const { requireAdmin } = require('../auth');

const router = express.Router();
router.use(requireAdmin);

// Express 4 does not catch async errors — this adapter forwards them to the error middleware
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// GET /api/admin/stats — overview cards for the admin dashboard
router.get('/stats', ah(async (req, res) => {
  const one = (sql) => db.prepare(sql).get();
  const users = one('SELECT COUNT(*) AS c FROM users').c;
  const admins = one('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').c;
  const servers = one('SELECT COUNT(*) AS c FROM servers').c;
  const orders = one('SELECT COUNT(*) AS c FROM orders').c;
  const revenue = one('SELECT COALESCE(SUM(total_cents),0) AS c FROM orders').c;
  const byEgg = db.prepare(
    `SELECT e.name, e.icon, COUNT(s.id) AS count FROM eggs e
     LEFT JOIN servers s ON s.egg_id = e.id GROUP BY e.id ORDER BY count DESC`
  ).all();
  // live states from the node daemon
  const stateCounts = { running: 0, offline: 0, installing: 0, starting: 0, stopping: 0, unknown: 0 };
  const rows = db.prepare('SELECT uuid FROM servers').all();
  for (const r of rows) {
    try { const w = await wings.get(r.uuid); stateCounts[w.state] = (stateCounts[w.state] || 0) + 1; }
    catch (_) { stateCounts.unknown++; }
  }
  const recentOrders = db.prepare(
    `SELECT o.id, o.total_cents, o.status, o.payment_ref, o.created_at, u.username, u.email
     FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 8`
  ).all();
  res.json({ users, admins, servers, orders, revenue_cents: revenue, by_egg: byEgg, states: stateCounts, recent_orders: recentOrders });
}));

// GET /api/admin/users
router.get('/users', (req, res) => {
  const users = db.prepare(
    `SELECT u.id, u.email, u.username, u.is_admin, u.created_at,
            (SELECT COUNT(*) FROM servers s WHERE s.user_id = u.id) AS server_count,
            (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
            (SELECT COALESCE(SUM(total_cents),0) FROM orders o WHERE o.user_id = u.id) AS spent_cents
     FROM users u ORDER BY u.created_at DESC`
  ).all();
  res.json({ data: users });
});

// POST /api/admin/users/:id/admin { is_admin: true|false }
router.post('/users/:id/admin', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot change your own admin flag' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.is_admin ? 1 : 0, id);
  res.json({ ok: true });
});

// DELETE /api/admin/users/:id — removes the user and all their servers
router.delete('/users/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const servers = db.prepare('SELECT uuid FROM servers WHERE user_id = ?').all(id);
  for (const s of servers) {
    try { await wings.destroy(s.uuid); } catch (_) { /* node may be down */ }
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM servers WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM subusers WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(id);
    // orders/order_items reference users without ON DELETE CASCADE
    db.prepare('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE user_id = ?)').run(id);
    db.prepare('DELETE FROM orders WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, removed_servers: servers.length });
}));

// GET /api/admin/servers — every server with owner, egg, plan and live state
router.get('/servers', ah(async (req, res) => {
  const rows = db.prepare(
    `SELECT s.uuid, s.name, s.node, s.port, s.created_at,
            u.id AS owner_id, u.username AS owner_name, u.email AS owner_email,
            e.name AS egg_name, e.icon AS egg_icon, p.name AS plan_name,
            p.ram_mb, p.cpu_percent, p.disk_mb
     FROM servers s JOIN users u ON u.id = s.user_id JOIN eggs e ON e.id = s.egg_id JOIN plans p ON p.id = s.plan_id
     ORDER BY s.created_at DESC`
  ).all();
  for (const s of rows) {
    try { const w = await wings.get(s.uuid); s.state = w.state; } catch (_) { s.state = 'unknown'; }
  }
  res.json({ data: rows });
}));

// POST /api/admin/servers/:uuid/power { action }
router.post('/servers/:uuid/power', ah(async (req, res) => {
  const action = (req.body || {}).action;
  if (!['start', 'stop', 'restart', 'kill'].includes(action)) return res.status(400).json({ error: 'Invalid power action' });
  try { res.json({ attributes: await wings.power(req.params.uuid, action) }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
}));

// DELETE /api/admin/servers/:uuid — destroy a server (wings + database)
router.delete('/servers/:uuid', ah(async (req, res) => {
  const server = db.prepare('SELECT id FROM servers WHERE uuid = ?').get(req.params.uuid);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  try { await wings.destroy(req.params.uuid); } catch (_) { /* node may be down */ }
  db.prepare('DELETE FROM subusers WHERE server_id = ?').run(server.id);
  db.prepare('DELETE FROM servers WHERE uuid = ?').run(req.params.uuid);
  res.json({ ok: true });
}));

// GET /api/admin/orders — all orders with customer and item summary
router.get('/orders', (req, res) => {
  const orders = db.prepare(
    `SELECT o.id, o.total_cents, o.status, o.payment_ref, o.created_at,
            u.id AS user_id, u.username, u.email,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS items,
            (SELECT GROUP_CONCAT(oi.server_uuid) FROM order_items oi WHERE oi.order_id = o.id) AS server_uuids
     FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 200`
  ).all();
  res.json({ data: orders });
});

module.exports = router;
