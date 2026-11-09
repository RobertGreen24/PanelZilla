'use strict';

// Central configuration. Everything is overridable via environment variables,
// which is how the Docker Compose stack wires the services together.
module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH || require('path').join(__dirname, '..', 'data', 'panelzilla.db'),
  sessionSecret: process.env.SESSION_SECRET || 'panelzilla-dev-secret-change-me',
  sessionCookie: process.env.SESSION_COOKIE || 'pz_session',
  sessionTtlHours: parseInt(process.env.SESSION_TTL_HOURS || '168', 10), // 7 days
  wingsUrl: process.env.WINGS_URL || 'http://localhost:3001',
  wingsApiKey: process.env.WINGS_API_KEY || 'panelzilla-wings-dev-key',
  wingsNode: process.env.WINGS_NODE || 'node-1',
  currency: process.env.CURRENCY || 'GBP',
  siteName: process.env.SITE_NAME || 'PanelZilla',
  // Demo checkout: payments are simulated, no real gateway is called.
  demoPayments: (process.env.DEMO_PAYMENTS || 'true') === 'true',
  // Bootstrap administrator account — created/promoted automatically on boot.
  // ALWAYS set these in production via environment variables.
  adminEmail: process.env.ADMIN_EMAIL || 'admin@panelzilla.gg',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin12345',
};
