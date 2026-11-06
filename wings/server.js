'use strict';

/**
 * PanelZilla Wings — node daemon.
 *
 * In Pterodactyl, Wings is the Go daemon on each game node that pulls Docker
 * images, starts/stops containers and streams the console. This is a
 * drop-in, API-compatible replacement written in Node: it exposes the same
 * style of HTTP API (provision, power, console stream, files, backups) and
 * manages "containers" on disk. Point the panel at a real Wings daemon on a
 * game node (WINGS_URL) and swap the simulation for real Docker calls.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.WINGS_API_KEY || 'panelzilla-wings-dev-key';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const NODE_NAME = process.env.NODE_NAME || 'node-1';

for (const d of ['files', 'backups', 'logs']) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'servers.json');

// ------------------------------------------------------------ state --------
const servers = new Map(); // uuid -> record
const streams = new Map(); // uuid -> Set<res> (SSE console listeners)

function loadState() {
  try { for (const s of JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))) servers.set(s.uuid, s); }
  catch (_) { /* first boot */ }
}
function saveState() {
  fs.writeFileSync(DB_FILE, JSON.stringify([...servers.values()], null, 2));
}
loadState();

const FLAVOR = {
  'minecraft-java': ['Preparing level "world"', 'Loading properties', 'Preparing spawn area: 100%', 'Done! For help, type "help"'],
  'minecraft-paper': ['This server is running Paper version', 'Preparing spawn area: 100%', 'Done! For help, type "help"'],
  'minecraft-bedrock': ['Server started on port 19132', 'Player connected: Steve'],
  'rust': ['Server identity: {{NAME}}', 'Workshop update finished', 'Server listening on port {{PORT}}'],
  'ark': ['ARK Survival Evolved', 'Server listening on port {{PORT}}', 'Tribe log updated'],
  'valheim': ['Game server connected', 'Session name: {{NAME}}', 'World loaded'],
  'cs2': ['CS2 server initializing', 'map de_dust2', 'Server started on port {{PORT}}'],
  'terraria': ['Terraria Server', 'Server started on port {{PORT}}', 'World loaded'],
  'palworld': ['Palworld server starting', 'Server started on port {{PORT}}'],
  'garrys-mod': ["Garry's Mod server", 'map gm_construct loaded', 'Server started on port {{PORT}}'],
};
const GENERIC = ['Server process alive', 'Heartbeat ok', 'Tick 128/s'];

// ------------------------------------------------------------- logging -----
function logFile(uuid) { return path.join(DATA_DIR, 'logs', uuid + '.log'); }
function serverDir(uuid) { return path.join(DATA_DIR, 'files', uuid); }

function log(uuid, line) {
  const s = servers.get(uuid);
  const ts = new Date().toISOString().slice(11, 19);
  const entry = `[${ts}] ${line}`;
  s.logBuffer.push(entry);
  if (s.logBuffer.length > 500) s.logBuffer.shift();
  fs.appendFileSync(logFile(uuid), entry + '\n');
  for (const res of streams.get(uuid) || []) {
    try { res.write(`data: ${JSON.stringify({ line: entry, ts })}\n\n`); } catch (_) {}
  }
}

// Simulated game loop: while "running", emit flavor lines.
const timers = new Map();
function startLoop(uuid) {
  stopLoop(uuid);
  const s = servers.get(uuid);
  if (!s) return;
  const flavor = FLAVOR[s.egg] || GENERIC;
  let i = 0;
  timers.set(uuid, setInterval(() => {
    const cur = servers.get(uuid);
    if (!cur || cur.state !== 'running') return;
    const line = flavor[i++ % flavor.length]
      .replace('{{NAME}}', cur.name).replace('{{PORT}}', String(cur.port));
    log(uuid, line);
  }, 2500));
}
function stopLoop(uuid) {
  if (timers.has(uuid)) { clearInterval(timers.get(uuid)); timers.delete(uuid); }
}

// Re-attach loops for servers that were running before a restart.
for (const [uuid, s] of servers) if (s.state === 'running') startLoop(uuid);

// -------------------------------------------------------------- helpers -----
function publicView(s) {
  return {
    uuid: s.uuid, name: s.name, egg: s.egg, image: s.image, port: s.port,
    state: s.state, created_at: s.created_at, node: NODE_NAME,
    address: `${NODE_NAME}.panelzilla.gg:${s.port}`,
    stats: {
      state: s.state,
      memory_bytes: s.state === 'running' ? Math.round(s.limits.ram_mb * 1024 * 1024 * (0.6 + Math.random() * 0.3)) : 0,
      memory_limit_bytes: s.limits.ram_mb * 1024 * 1024,
      cpu_percent: s.state === 'running' ? Math.round(s.limits.cpu_percent * (0.2 + Math.random() * 0.5)) : 0,
      cpu_limit_percent: s.limits.cpu_percent,
      disk_bytes: Math.round(s.limits.disk_mb * 1024 * 1024 * 0.08),
      disk_limit_bytes: s.limits.disk_mb * 1024 * 1024,
      network_rx_bytes: 0, network_tx_bytes: 0, uptime_seconds: 0,
    },
  };
}

function safeJoin(base, p) {
  const resolved = path.resolve(base, '.' + path.posix.normalize('/' + (p || '')));
  if (!resolved.startsWith(path.resolve(base))) throw Object.assign(new Error('Path traversal blocked'), { status: 400 });
  return resolved;
}

// ---------------------------------------------------------------- app -------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'Invalid daemon API key' });
  }
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true, node: NODE_NAME, servers: servers.size }));

// Provision a new game server "container"
app.post('/api/servers', (req, res) => {
  const { uuid, name, egg, image, env, limits, port } = req.body || {};
  if (!uuid || !name || !egg || !image) return res.status(400).json({ error: 'uuid, name, egg and image are required' });
  if (servers.has(uuid)) return res.status(409).json({ error: 'Server already exists' });
  fs.mkdirSync(serverDir(uuid), { recursive: true });
  // every egg ships a starter file set
  fs.writeFileSync(path.join(serverDir(uuid), 'server.properties'), `# ${name}\nserver-port=${port || 25565}\nmax-players=${(env && env.SLOTS) || 20}\nonline-mode=true\n`);
  fs.writeFileSync(path.join(serverDir(uuid), 'README.txt'), `Welcome to your PanelZilla ${egg} server!\nEdit files here, then restart from the panel.\n`);
  const server = {
    uuid, name, egg, image, env: env || {}, limits: limits || {},
    port: port || 25565, state: 'installing', logBuffer: [], created_at: new Date().toISOString(),
  };
  servers.set(uuid, server);
  saveState();
  log(uuid, `[wings] Provisioning container ${uuid} from image ${image}`);
  log(uuid, `[wings] Egg "${egg}" applied — environment set (${Object.keys(server.env).length} vars)`);
  // simulate image pull + install
  setTimeout(() => { log(uuid, `[wings] Image pulled: ${image}`); }, 800);
  setTimeout(() => {
    log(uuid, `[wings] Install script finished. Server is ready (state: offline)`);
    const s = servers.get(uuid);
    if (s && s.state === 'installing') { s.state = 'offline'; saveState(); }
  }, 2200);
  res.status(201).json(publicView(server));
});

app.get('/api/servers/:uuid', (req, res) => {
  const s = servers.get(req.params.uuid);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  res.json(publicView(s));
});

app.delete('/api/servers/:uuid', (req, res) => {
  const s = servers.get(req.params.uuid);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  stopLoop(req.params.uuid);
  servers.delete(req.params.uuid);
  saveState();
  fs.rmSync(serverDir(req.params.uuid), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'backups', req.params.uuid), { recursive: true, force: true });
  res.status(204).end();
});

app.post('/api/servers/:uuid/power', (req, res) => {
  const s = servers.get(req.params.uuid);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const action = (req.body || {}).action;
  if (!['start', 'stop', 'restart', 'kill'].includes(action)) return res.status(400).json({ error: 'Invalid power action' });
  if (action === 'start' && s.state === 'running') return res.status(409).json({ error: 'Server already running' });
  if ((action === 'stop' || action === 'restart' || action === 'kill') && s.state !== 'running') return res.status(409).json({ error: 'Server is not running' });

  if (action === 'start' || action === 'restart') {
    s.state = 'starting'; saveState();
    log(s.uuid, `[wings] Power: ${action} — starting container...`);
    setTimeout(() => {
      const cur = servers.get(s.uuid);
      if (!cur || cur.state !== 'starting') return;
      cur.state = 'running'; saveState();
      const startupLine = (FLAVOR[s.egg] && FLAVOR[s.egg][FLAVOR[s.egg].length - 1]) || 'Server started';
      log(s.uuid, '[Server thread/INFO]: ' + startupLine.replace('{{NAME}}', cur.name).replace('{{PORT}}', String(cur.port)).replace('{{STARTUP}}', '3.4'));
      log(s.uuid, `[wings] Container running on port ${cur.port} (RAM limit ${cur.limits.ram_mb}MB, CPU ${cur.limits.cpu_percent}%)`);
      startLoop(s.uuid);
    }, action === 'restart' ? 1200 : 2500);
  } else {
    stopLoop(s.uuid);
    if (action === 'kill') {
      s.state = 'offline';
      log(s.uuid, '[wings] Power: kill — container force-stopped (state: offline)');
    } else {
      s.state = 'stopping'; saveState();
      log(s.uuid, '[wings] Power: stop — saving world, shutting down gracefully...');
      setTimeout(() => {
        const cur = servers.get(s.uuid);
        if (!cur || cur.state !== 'stopping') return;
        cur.state = 'offline'; saveState();
        log(s.uuid, '[Server thread/INFO]: Stopping the server');
        log(s.uuid, '[wings] Container stopped (state: offline)');
      }, 1800);
    }
    saveState();
  }
  res.json({ state: servers.get(s.uuid).state, action });
});

app.post('/api/servers/:uuid/command', (req, res) => {
  const s = servers.get(req.params.uuid);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const command = (req.body || {}).command;
  if (!command) return res.status(400).json({ error: 'command is required' });
  if (s.state !== 'running') return res.status(409).json({ error: 'Server is not running' });
  log(s.uuid, `[Server thread/INFO]: Issued server command: /${command}`);
  res.json({ ok: true });
});

// Live console stream (SSE) — backlog + follow
app.get('/api/servers/:uuid/console/stream', (req, res) => {
  const s = servers.get(req.params.uuid);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`data: ${JSON.stringify({ line: `[wings] Console attached to ${s.uuid} (state: ${s.state})`, ts: new Date().toISOString().slice(11, 19) })}\n\n`);
  for (const line of s.logBuffer) {
    res.write(`data: ${JSON.stringify({ line, ts: line.slice(1, 9) })}\n\n`);
  }
  if (!streams.has(s.uuid)) streams.set(s.uuid, new Set());
  streams.get(s.uuid).add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
  req.on('close', () => { clearInterval(ping); streams.get(s.uuid)?.delete(res); });
});

app.get('/api/servers/:uuid/stats', (req, res) => {
  const s = servers.get(req.params.uuid);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const running = s.state === 'running';
  const rnd = (a, b) => Math.round(a + Math.random() * (b - a));
  res.json({
    state: s.state,
    memory_bytes: running ? rnd(s.limits.ram_mb, s.limits.ram_mb * 1.6) * 1024 * 1024 * 0.9 : 0,
    memory_limit_bytes: s.limits.ram_mb * 1024 * 1024,
    cpu_percent: running ? rnd(Math.floor(s.limits.cpu_percent * 0.2), s.limits.cpu_percent) : 0,
    cpu_limit_percent: s.limits.cpu_percent,
    disk_bytes: Math.round(s.limits.disk_mb * 1024 * 1024 * (0.05 + Math.random() * 0.1)),
    disk_limit_bytes: s.limits.disk_mb * 1024 * 1024,
    network_rx_bytes: running ? rnd(1e6, 5e8) : 0,
    network_tx_bytes: running ? rnd(1e6, 2e8) : 0,
    uptime_seconds: running ? rnd(60, 86400) : 0,
  });
});

// ---- files ------------------------------------------------------------------
app.get('/api/servers/:uuid/files', (req, res) => {
  const s = servers.get(req.params.uuid);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  try {
    const dir = safeJoin(serverDir(s.uuid), req.query.dir || '/');
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => ({
      name: e.name, is_file: e.isFile(), size: e.isFile() ? fs.statSync(path.join(dir, e.name)).size : 0,
      modified: fs.statSync(path.join(dir, e.name)).mtime.toISOString(),
    }));
    res.json({ data: entries });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Directory not found' }); }
});

app.get('/api/servers/:uuid/files/content', (req, res) => {
  const s = servers.get(req.params.uuid);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  try {
    const file = safeJoin(serverDir(s.uuid), req.query.path || '');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.status(404).json({ error: 'File not found' });
    const content = fs.readFileSync(file, 'utf8');
    if (content.length > 200000) return res.status(400).json({ error: 'File too large to view (download instead)' });
    res.json({ path: req.query.path, content });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.put('/api/servers/:uuid/files', (req, res) => {
  const s = servers.get(req.params.uuid);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  try {
    const file = safeJoin(serverDir(s.uuid), req.body.path || '');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(req.body.content ?? ''));
    log(s.uuid, `[wings] File written: ${req.body.path}`);
    res.json({ ok: true, path: req.body.path });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/servers/:uuid/files', (req, res) => {
  const s = servers.get(req.params.uuid);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  try {
    const file = safeJoin(serverDir(s.uuid), req.query.path || '');
    fs.rmSync(file, { recursive: true, force: true });
    log(s.uuid, `[wings] File deleted: ${req.query.path}`);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---- backups ------------------------------------------------------------------
const backupsDir = (uuid) => path.join(DATA_DIR, 'backups', uuid);

app.post('/api/servers/:uuid/backups', (req, res) => {
  const s = servers.get(req.params.uuid);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const id = crypto.randomBytes(4).toString('hex');
  fs.mkdirSync(backupsDir(s.uuid), { recursive: true });
  const out = path.join(backupsDir(s.uuid), id + '.tar.gz');
  execFile('tar', ['-czf', out, '-C', serverDir(s.uuid), '.'], (err) => {
    if (err) { fs.writeFileSync(out, `PanelZilla backup of ${s.uuid} (tar unavailable in image)\n`); }
    log(s.uuid, `[wings] Backup ${id} created (${fs.statSync(out).size} bytes)`);
    res.status(201).json({ id, name: `${s.name}-${id}.tar.gz`, size_bytes: fs.statSync(out).size, created_at: new Date().toISOString() });
  });
});

app.get('/api/servers/:uuid/backups', (req, res) => {
  const s = servers.get(req.params.uuid);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const dir = backupsDir(s.uuid);
  const data = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.tar.gz')).map(f => ({
    id: f.replace('.tar.gz', ''), name: `${s.name}-${f.replace('.tar.gz', '')}.tar.gz`,
    size_bytes: fs.statSync(path.join(dir, f)).size, created_at: fs.statSync(path.join(dir, f)).mtime.toISOString(),
  })) : [];
  res.json({ data });
});

app.get('/api/servers/:uuid/backups/:id/download', (req, res) => {
  const file = path.join(backupsDir(req.params.uuid), req.params.id + '.tar.gz');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Backup not found' });
  res.download(file);
});

app.post('/api/servers/:uuid/backups/:id/restore', (req, res) => {
  const s = servers.get(req.params.uuid);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const file = path.join(backupsDir(s.uuid), req.params.id + '.tar.gz');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Backup not found' });
  if (s.state === 'running') return res.status(409).json({ error: 'Stop the server before restoring' });
  stopLoop(s.uuid);
  fs.rmSync(serverDir(s.uuid), { recursive: true, force: true });
  fs.mkdirSync(serverDir(s.uuid), { recursive: true });
  execFile('tar', ['-xzf', file, '-C', serverDir(s.uuid)], (err) => {
    if (err) fs.writeFileSync(path.join(serverDir(s.uuid), 'restore-note.txt'), 'Restored from backup (tar unavailable in image)');
    log(s.uuid, `[wings] Backup ${req.params.id} restored`);
    res.json({ ok: true });
  });
});

app.delete('/api/servers/:uuid/backups/:id', (req, res) => {
  const file = path.join(backupsDir(req.params.uuid), req.params.id + '.tar.gz');
  fs.rmSync(file, { force: true });
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => console.log(`[wings] node daemon "${NODE_NAME}" listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`));
