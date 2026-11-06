/* Server management page: console (SSE), power, stats, files, backups, subusers, settings */
(async () => {
  await PZ.renderNav('dashboard');
  const uuid = location.pathname.split('/').pop();
  const $ = (id) => document.getElementById(id);
  let server = null;
  let currentDir = '/';
  let editingPath = null;
  let consoleStarted = false;

  const can = (perm) => server && server.permissions && (server.permissions.includes('*') || server.permissions.includes(perm));

  async function loadServer() {
    const { attributes } = await PZ.api(`/api/client/servers/${uuid}`);
    server = attributes;
    $('srv-icon').textContent = server.egg_icon;
    $('srv-name').textContent = server.name;
    $('srv-sub').textContent = `${server.egg_name} · ${server.plan_name} plan · node ${server.node} · connect: panelzilla.gg:${server.port}`;
    $('srv-state').innerHTML = PZ.stateBadge(server.state);
    renderStats(server.stats);
    $('set-name').value = server.name;
    $('set-desc').value = server.description || '';
    $('srv-details').innerHTML = `
      <dt>Server ID</dt><dd class="mono">${server.uuid}</dd>
      <dt>Game / egg</dt><dd>${PZ.escapeHtml(server.egg_name)} (<span class="mono">${server.egg_slug}</span>)</dd>
      <dt>RAM</dt><dd>${PZ.fmtBytes(server.ram_mb)}</dd>
      <dt>CPU</dt><dd>${server.cpu_percent}%</dd>
      <dt>Disk</dt><dd>${PZ.fmtBytes(server.disk_mb)}</dd>
      <dt>Slots</dt><dd>${server.player_slots}</dd>
      <dt>Port</dt><dd class="mono">${server.port}</dd>
      <dt>Created</dt><dd>${new Date(server.created_at).toLocaleString()}</dd>`;
    document.querySelectorAll('[data-power]').forEach(b => { b.disabled = !can('power'); });
  }

  function renderStats(st) {
    if (!st) return;
    const memPct = st.memory_limit_bytes ? Math.min(100, Math.round(st.memory_bytes / st.memory_limit_bytes * 100)) : 0;
    const cpuPct = st.cpu_limit_percent ? Math.min(100, Math.round(st.cpu_percent / st.cpu_limit_percent * 100)) : 0;
    const diskPct = st.disk_limit_bytes ? Math.min(100, Math.round(st.disk_bytes / st.disk_limit_bytes * 100)) : 0;
    const gb = (b) => (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    $('stat-cards').innerHTML = `
      <div class="card"><div class="muted" style="font-size:12px;">MEMORY</div><b>${gb(st.memory_bytes)}</b> / ${gb(st.memory_limit_bytes)}<div class="bar" style="margin-top:6px;"><div class="track"><div class="fill" style="width:${memPct}%"></div></div></div></div>
      <div class="card"><div class="muted" style="font-size:12px;">CPU</div><b>${Math.round(st.cpu_percent)}%</b> / ${st.cpu_limit_percent}%<div class="bar" style="margin-top:6px;"><div class="track"><div class="fill" style="width:${cpuPct}%"></div></div></div></div>
      <div class="card"><div class="muted" style="font-size:12px;">DISK</div><b>${gb(st.disk_bytes)}</b> / ${gb(st.disk_limit_bytes)}<div class="bar" style="margin-top:6px;"><div class="track"><div class="fill" style="width:${diskPct}%"></div></div></div></div>
      <div class="card"><div class="muted" style="font-size:12px;">UPTIME</div><b>${Math.round(st.uptime_seconds / 60)} min</b><div class="muted" style="font-size:12px; margin-top:6px;">RX ${gb(st.network_rx_bytes)} · TX ${gb(st.network_tx_bytes)}</div></div>`;
  }

  // ---- power ----
  document.querySelectorAll('[data-power]').forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await PZ.api(`/api/client/servers/${uuid}/power`, { method: 'POST', body: { action: b.dataset.power } });
        PZ.toast('Power: ' + b.dataset.power);
        setTimeout(loadServer, 1500);
      } catch (e) { PZ.toast(e.message); b.disabled = false; }
    };
  });

  // ---- tabs ----
  document.querySelectorAll('#tabs button').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('#tabs button').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      ['console', 'files', 'backups', 'subusers', 'settings'].forEach(n => { $('tab-' + n).style.display = n === t.dataset.tab ? 'block' : 'none'; });
      if (t.dataset.tab === 'files') loadFiles();
      if (t.dataset.tab === 'backups') loadBackups();
      if (t.dataset.tab === 'subusers') loadSubusers();
    };
  });

  // ---- console (SSE) ----
  function startConsole() {
    if (consoleStarted) return;
    consoleStarted = true;
    const box = $('console');
    const es = new EventSource(`/api/client/servers/${uuid}/console`);
    es.onmessage = (ev) => {
      try {
        const { line } = JSON.parse(ev.data);
        const div = document.createElement('div');
        div.className = 'line';
        div.textContent = line;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
      } catch (_) {}
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
  }
  startConsole();

  $('console-form').onsubmit = async (e) => {
    e.preventDefault();
    const input = $('console-input');
    if (!input.value.trim()) return;
    try {
      await PZ.api(`/api/client/servers/${uuid}/command`, { method: 'POST', body: { command: input.value.trim() } });
      input.value = '';
    } catch (err) { PZ.toast(err.message); }
  };

  // ---- files ----
  async function loadFiles() {
    if (!can('file')) { $('file-list').innerHTML = '<div class="empty">You don\'t have file permission.</div>'; return; }
    try {
      const { data } = await PZ.api(`/api/client/servers/${uuid}/files?dir=${encodeURIComponent(currentDir)}`);
      $('file-path').textContent = currentDir;
      const list = $('file-list');
      if (data.length === 0) { list.innerHTML = '<div class="empty">Empty folder</div>'; return; }
      list.innerHTML = data.map(f => `
        <div class="file-row" data-name="${PZ.escapeHtml(f.name)}" data-file="${f.is_file}">
          <span>${f.is_file ? '📄' : '📁'}</span>
          <span class="name">${PZ.escapeHtml(f.name)}${f.is_file ? '' : '/'}</span>
          <span class="muted" style="font-size:12px;">${f.is_file ? (f.size / 1024).toFixed(1) + ' KB' : ''}</span>
          ${f.is_file && can('file') ? `<button class="btn ghost small" data-del="${PZ.escapeHtml(f.name)}">🗑</button>` : ''}
        </div>`).join('');
      list.querySelectorAll('.file-row').forEach(row => {
        row.onclick = async (e) => {
          if (e.target.dataset.del) return;
          const name = row.dataset.name;
          if (row.dataset.file === 'true') openFile(currentDir === '/' ? '/' + name : currentDir + '/' + name);
          else { currentDir = (currentDir === '/' ? '' : currentDir) + '/' + name; loadFiles(); }
        };
      });
      list.querySelectorAll('[data-del]').forEach(b => {
        b.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm('Delete ' + b.dataset.del + '?')) return;
          await PZ.api(`/api/client/servers/${uuid}/files?path=${encodeURIComponent((currentDir === '/' ? '' : currentDir) + '/' + b.dataset.del)}`, { method: 'DELETE' });
          loadFiles();
        };
      });
    } catch (e) { $('file-list').innerHTML = `<div class="empty">${PZ.escapeHtml(e.message)}</div>`; }
  }

  async function openFile(p) {
    const r = await PZ.api(`/api/client/servers/${uuid}/files/content?path=${encodeURIComponent(p)}`);
    editingPath = p;
    $('file-editor-title').textContent = p;
    $('file-editor').value = r.content;
    $('file-editor-wrap').style.display = 'block';
  }
  $('file-up').onclick = () => {
    const parts = currentDir.split('/').filter(Boolean);
    parts.pop();
    currentDir = '/' + parts.join('/');
    if (currentDir === '/') currentDir = '/';
    loadFiles();
  };
  $('file-new').onclick = async () => {
    const name = prompt('New file name in ' + currentDir + ':');
    if (!name) return;
    const p = (currentDir === '/' ? '' : currentDir) + '/' + name;
    await PZ.api(`/api/client/servers/${uuid}/files`, { method: 'PUT', body: { path: p, content: '' } });
    loadFiles();
  };
  $('file-save').onclick = async () => {
    await PZ.api(`/api/client/servers/${uuid}/files`, { method: 'PUT', body: { path: editingPath, content: $('file-editor').value } });
    PZ.toast('Saved ' + editingPath);
  };
  $('file-close').onclick = () => { $('file-editor-wrap').style.display = 'none'; editingPath = null; };

  // ---- backups ----
  async function loadBackups() {
    try {
      const { data } = await PZ.api(`/api/client/servers/${uuid}/backups`);
      const el = $('backup-list');
      if (data.length === 0) { el.innerHTML = '<div class="empty">No backups yet.</div>'; return; }
      el.innerHTML = data.map(b => `
        <div class="file-row">
          <span>💾</span>
          <span class="name mono" style="font-size:13px;">${PZ.escapeHtml(b.name)}</span>
          <span class="muted" style="font-size:12px;">${(b.size_bytes / 1024).toFixed(1)} KB · ${new Date(b.created_at).toLocaleString()}</span>
          ${can('backup') ? `
            <a class="btn ghost small" href="/api/client/servers/${uuid}/backups/${b.id}/download">⬇</a>
            <button class="btn secondary small" data-restore="${b.id}">Restore</button>
            <button class="btn danger small" data-bdel="${b.id}">✕</button>` : ''}
        </div>`).join('');
      el.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => {
        if (!confirm('Restore this backup? Current files will be replaced.')) return;
        try { await PZ.api(`/api/client/servers/${uuid}/backups/${b.dataset.restore}/restore`, { method: 'POST' }); PZ.toast('Backup restored'); }
        catch (e) { PZ.toast(e.message); }
      });
      el.querySelectorAll('[data-bdel]').forEach(b => b.onclick = async () => {
        await PZ.api(`/api/client/servers/${uuid}/backups/${b.dataset.bdel}`, { method: 'DELETE' });
        loadBackups();
      });
    } catch (e) { $('backup-list').innerHTML = `<div class="empty">${PZ.escapeHtml(e.message)}</div>`; }
  }
  $('backup-create').onclick = async () => {
    try { await PZ.api(`/api/client/servers/${uuid}/backups`, { method: 'POST' }); PZ.toast('Backup created'); loadBackups(); }
    catch (e) { PZ.toast(e.message); }
  };
  $('backup-create').disabled = false;

  // ---- subusers ----
  async function loadSubusers() {
    if (!server.is_owner) { $('subuser-list').innerHTML = '<div class="empty">Only the owner can manage subusers.</div>'; $('subuser-add').style.display = 'none'; return; }
    const { data } = await PZ.api(`/api/client/servers/${uuid}/subusers`);
    const el = $('subuser-list');
    if (data.length === 0) { el.innerHTML = '<div class="empty">No subusers yet.</div>'; return; }
    el.innerHTML = data.map(s => `
      <div class="file-row">
        <span>👤</span>
        <span class="name"><b>${PZ.escapeHtml(s.username)}</b> <span class="muted">${PZ.escapeHtml(s.email)}</span></span>
        <span class="badge-row">${s.permissions.map(p => `<span class="badge">${p}</span>`).join('')}</span>
        <button class="btn danger small" data-subdel="${s.id}">✕</button>
      </div>`).join('');
    el.querySelectorAll('[data-subdel]').forEach(b => b.onclick = async () => {
      await PZ.api(`/api/client/servers/${uuid}/subusers/${b.dataset.subdel}`, { method: 'DELETE' });
      loadSubusers();
    });
  }
  $('subuser-invite').onclick = async () => {
    const errEl = $('subuser-error');
    errEl.textContent = '';
    const perms = [...document.querySelectorAll('#subuser-perms input:checked')].map(c => c.value);
    try {
      await PZ.api(`/api/client/servers/${uuid}/subusers`, { method: 'POST', body: { email: $('subuser-email').value.trim(), permissions: perms } });
      PZ.toast('Subuser invited');
      $('subuser-email').value = '';
      loadSubusers();
    } catch (e) { errEl.textContent = e.message; }
  };

  // ---- settings ----
  $('set-save').onclick = async () => {
    const msg = $('set-msg');
    try {
      await PZ.api(`/api/client/servers/${uuid}`, { method: 'PATCH', body: { name: $('set-name').value, description: $('set-desc').value } });
      msg.style.color = 'var(--green)';
      msg.textContent = 'Saved!';
      loadServer();
    } catch (e) { msg.style.color = 'var(--red)'; msg.textContent = e.message; }
  };

  // ---- init ----
  try {
    await loadServer();
  } catch (e) {
    document.querySelector('.container').innerHTML = `<div class="card empty">${PZ.escapeHtml(e.message)} <a href="/dashboard">← back</a></div>`;
    return;
  }
  setInterval(async () => { try { await loadServer(); } catch (_) {} }, 8000);
})();
