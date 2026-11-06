'use strict';

/**
 * Client for the node daemon ("Wings") that actually runs the game servers
 * in Docker containers — the same panel -> node-daemon split Pterodactyl uses.
 * In this build the daemon is PanelZilla Wings (see /wings), a drop-in node
 * agent exposing a Wings-style HTTP API. Swap WINGS_URL to point at a real
 * Wings daemon on a game node and no panel code changes.
 */
const config = require('./config');

async function wingsFetch(path, options = {}) {
  const res = await fetch(config.wingsUrl + path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${config.wingsApiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch (_) { /* ignore */ }
    const err = new Error(`Wings ${res.status}: ${detail || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

module.exports = {
  provision: (payload) => wingsFetch('/api/servers', { method: 'POST', body: JSON.stringify(payload) }),
  get: (uuid) => wingsFetch(`/api/servers/${uuid}`),
  destroy: (uuid) => wingsFetch(`/api/servers/${uuid}`, { method: 'DELETE' }),
  power: (uuid, action) => wingsFetch(`/api/servers/${uuid}/power`, { method: 'POST', body: JSON.stringify({ action }) }),
  command: (uuid, command) => wingsFetch(`/api/servers/${uuid}/command`, { method: 'POST', body: JSON.stringify({ command }) }),
  stats: (uuid) => wingsFetch(`/api/servers/${uuid}/stats`),
  listFiles: (uuid, dir) => wingsFetch(`/api/servers/${uuid}/files?dir=${encodeURIComponent(dir || '/')}`),
  readFile: (uuid, filePath) => wingsFetch(`/api/servers/${uuid}/files/content?path=${encodeURIComponent(filePath)}`),
  writeFile: (uuid, filePath, content) => wingsFetch(`/api/servers/${uuid}/files`, { method: 'PUT', body: JSON.stringify({ path: filePath, content }) }),
  deleteFile: (uuid, filePath) => wingsFetch(`/api/servers/${uuid}/files?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' }),
  createBackup: (uuid) => wingsFetch(`/api/servers/${uuid}/backups`, { method: 'POST' }),
  listBackups: (uuid) => wingsFetch(`/api/servers/${uuid}/backups`),
  restoreBackup: (uuid, backupId) => wingsFetch(`/api/servers/${uuid}/backups/${backupId}/restore`, { method: 'POST' }),
  deleteBackup: (uuid, backupId) => wingsFetch(`/api/servers/${uuid}/backups/${backupId}`, { method: 'DELETE' }),
  backupDownloadUrl: (uuid, backupId) => `${config.wingsUrl}/api/servers/${uuid}/backups/${backupId}/download`,
  consoleStreamUrl: (uuid) => `${config.wingsUrl}/api/servers/${uuid}/console/stream`,
  wingsFetch,
};
