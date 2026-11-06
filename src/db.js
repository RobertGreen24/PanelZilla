'use strict';

/**
 * Database layer built on Node's built-in SQLite (node:sqlite).
 * A single file mounted as a Docker volume in production — simple to back up,
 * and swappable for Postgres/MySQL later without touching route code.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const EGGS = require('./eggs');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS eggs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  icon TEXT NOT NULL,
  image TEXT NOT NULL,
  startup TEXT NOT NULL,
  description TEXT NOT NULL,
  env TEXT NOT NULL,          -- JSON
  log_line TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  egg_id INTEGER NOT NULL REFERENCES eggs(id),
  name TEXT NOT NULL,
  ram_mb INTEGER NOT NULL,
  cpu_percent INTEGER NOT NULL,
  disk_mb INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,   -- monthly price in pence
  player_slots INTEGER NOT NULL,
  features TEXT NOT NULL,         -- JSON array
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, plan_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid',   -- demo checkout always lands 'paid'
  payment_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  server_uuid TEXT,                       -- filled in once provisioned
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  order_item_id INTEGER REFERENCES order_items(id),
  egg_id INTEGER NOT NULL REFERENCES eggs(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  node TEXT NOT NULL,
  port INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS subusers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permissions TEXT NOT NULL,              -- JSON array of permission keys
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (server_id, user_id)
);
`;
db.exec(SCHEMA);

// ---------------------------------------------------------------- seed ----
const seed = db.prepare('SELECT COUNT(*) AS c FROM eggs').get();
if (seed.c === 0) {
  const insEgg = db.prepare(
    'INSERT INTO eggs (slug, name, category, icon, image, startup, description, env, log_line, sort) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  const insPlan = db.prepare(
    'INSERT INTO plans (egg_id, name, ram_mb, cpu_percent, disk_mb, price_cents, player_slots, features, sort) VALUES (?,?,?,?,?,?,?,?,?)'
  );

  // Store tiers shared across games: name, RAM, CPU%, disk, £/mo, slots, features
  const TIERS = [
    { name: 'Starter',  ram_mb: 2048,  cpu: 100, disk_mb: 10240,  price: 499,  slots: 10,  features: ['2 GB RAM', '10 GB NVMe disk', 'DDoS protection', 'Daily backups', '1 server'] },
    { name: 'Standard', ram_mb: 4096,  cpu: 200, disk_mb: 20480,  price: 899,  slots: 25,  features: ['4 GB RAM', '20 GB NVMe disk', 'DDoS protection', 'Daily backups', '1 server', 'Priority support'] },
    { name: 'Pro',      ram_mb: 8192,  cpu: 300, disk_mb: 40960,  price: 1599, slots: 50,  features: ['8 GB RAM', '40 GB NVMe disk', 'DDoS protection', 'Daily backups', '1 server', 'Priority support', 'Free subdomain'] },
    { name: 'Beast',    ram_mb: 16384, cpu: 400, disk_mb: 81920,  price: 2999, slots: 100, features: ['16 GB RAM', '80 GB NVMe disk', 'DDoS protection', 'Daily backups', '1 server', 'Priority support', 'Free subdomain', 'Dedicated core'] },
  ];

  const tx = () => {
    db.exec('BEGIN');
    try {
      EGGS.forEach((egg, i) => {
        insEgg.run(egg.slug, egg.name, egg.category, egg.icon, egg.image, egg.startup, egg.description, JSON.stringify(egg.env), egg.logLine, i);
        const eggId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
        TIERS.forEach((t, j) => {
          insPlan.run(eggId, t.name, t.ram_mb, t.cpu, t.disk_mb, t.price, t.slots, JSON.stringify(t.features), j);
        });
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  tx();
  console.log(`[db] seeded ${EGGS.length} eggs with ${EGGS.length * TIERS.length} store plans`);
}

module.exports = db;
