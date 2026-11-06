'use strict';

/**
 * Store API — browse game server plans, manage a cart, checkout (demo
 * payments) and auto-provision a server on the Wings node for each item.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const wings = require('../wingsClient');
const { requireAuth } = require('../auth');

const router = express.Router();

// GET /api/store/games — egg catalog grouped with their plans (the storefront)
router.get('/games', (req, res) => {
  const eggs = db.prepare('SELECT * FROM eggs ORDER BY sort').all();
  const plans = db.prepare('SELECT * FROM plans ORDER BY egg_id, sort').all();
  const byEgg = {};
  for (const p of plans) {
    (byEgg[p.egg_id] = byEgg[p.egg_id] || []).push({
      id: p.id, name: p.name, ram_mb: p.ram_mb, cpu_percent: p.cpu_percent,
      disk_mb: p.disk_mb, price_cents: p.price_cents, player_slots: p.player_slots,
      features: JSON.parse(p.features),
    });
  }
  res.json(eggs.map((e) => ({
    slug: e.slug, name: e.name, category: e.category, icon: e.icon,
    image: e.image, description: e.description, plans: byEgg[e.id] || [],
  })));
});

// GET /api/store/cart
router.get('/cart', requireAuth, (req, res) => {
  const items = db.prepare(
    `SELECT c.id AS cart_id, c.added_at, p.id AS plan_id, p.name AS plan_name,
            p.ram_mb, p.cpu_percent, p.disk_mb, p.price_cents, p.player_slots,
            p.features, e.name AS game_name, e.icon AS game_icon, e.slug AS game_slug
     FROM cart_items c JOIN plans p ON p.id = c.plan_id JOIN eggs e ON e.id = p.egg_id
     WHERE c.user_id = ? ORDER BY c.added_at`
  ).all(req.user.id);
  const total = items.reduce((s, i) => s + i.price_cents, 0);
  res.json({ items: items.map(i => ({ ...i, features: JSON.parse(i.features) })), total_cents: total });
});

// POST /api/store/cart { plan_id }
router.post('/cart', requireAuth, (req, res) => {
  const { plan_id } = req.body || {};
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(plan_id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  db.prepare('INSERT OR IGNORE INTO cart_items (user_id, plan_id) VALUES (?,?)').run(req.user.id, plan_id);
  res.json({ ok: true });
});

// DELETE /api/store/cart/:cartId
router.delete('/cart/:cartId', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?').run(req.params.cartId, req.user.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Cart item not found' });
  res.json({ ok: true });
});

// POST /api/store/checkout { card_number, card_name, expiry, cvc }
// Demo mode: any card details are accepted and the order is marked paid.
router.post('/checkout', requireAuth, async (req, res) => {
  const { card_number, card_name, expiry, cvc } = req.body || {};
  if (!card_number || !card_name || !expiry || !cvc) {
    return res.status(400).json({ error: 'Payment details are required' });
  }
  const items = db.prepare(
    `SELECT c.id AS cart_id, p.* FROM cart_items c JOIN plans p ON p.id = c.plan_id WHERE c.user_id = ?`
  ).all(req.user.id);
  if (items.length === 0) return res.status(400).json({ error: 'Your cart is empty' });

  const total = items.reduce((s, i) => s + i.price_cents, 0);
  const paymentRef = 'DEMO-' + crypto.randomBytes(6).toString('hex').toUpperCase();

  db.exec('BEGIN');
  let orderId;
  const provisioned = [];
  const failed = [];
  try {
    orderId = db.prepare('INSERT INTO orders (user_id, total_cents, status, payment_ref) VALUES (?,?,?,?)')
      .run(req.user.id, total, 'paid', paymentRef).lastInsertRowid;

    const insItem = db.prepare('INSERT INTO order_items (order_id, plan_id) VALUES (?,?)');
    const insServer = db.prepare(
      `INSERT INTO servers (uuid, user_id, order_item_id, egg_id, plan_id, name, node, port)
       VALUES (?,?,?,?,?,?,?,?)`
    );

    for (const item of items) {
      const egg = db.prepare('SELECT * FROM eggs WHERE id = ?').get(item.egg_id);
      const uuid = crypto.randomUUID();
      const port = 25000 + Math.floor(Math.random() * 30000);
      const name = `${egg.name.split(':')[0]} Server`;

      const itemId = insItem.run(orderId, item.id).lastInsertRowid;
      insServer.run(uuid, req.user.id, itemId, egg.id, item.id, name, config.wingsNode, port);
      db.prepare('UPDATE order_items SET server_uuid = ? WHERE id = ?').run(uuid, itemId);
      db.prepare('DELETE FROM cart_items WHERE id = ?').run(item.cart_id);

      // Provision on the node daemon. If the node is down we still keep the
      // order and report the failure so an admin can retry provisioning.
      try {
        await wings.provision({
          uuid, name, egg: egg.slug, image: egg.image,
          env: { ...JSON.parse(egg.env), PORT: String(port), NAME: name, RAM: String(item.ram_mb), SLOTS: String(item.player_slots) },
          limits: { ram_mb: item.ram_mb, cpu_percent: item.cpu_percent, disk_mb: item.disk_mb, swap_mb: 0 },
          port,
        });
        provisioned.push({ uuid, name, game: egg.name });
      } catch (e) {
        failed.push({ uuid, name, error: e.message });
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[store] checkout failed:', e);
    return res.status(500).json({ error: 'Checkout failed, please try again' });
  }

  res.json({ ok: true, order_id: orderId, payment_ref: paymentRef, total_cents: total, provisioned, failed });
});

// GET /api/store/orders — the customer's order history
router.get('/orders', requireAuth, (req, res) => {
  const orders = db.prepare(
    `SELECT o.id, o.total_cents, o.status, o.payment_ref, o.created_at,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS items
     FROM orders o WHERE o.user_id = ? ORDER BY o.created_at DESC`
  ).all(req.user.id);
  res.json(orders);
});

module.exports = router;
