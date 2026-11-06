/* Dashboard: list servers with live state + resource bars */
(async () => {
  await PZ.renderNav('dashboard');
  const el = document.getElementById('servers');

  async function load() {
    const { data } = await PZ.api('/api/client/servers');
    if (data.length === 0) {
      el.innerHTML = `<div class="card empty" style="grid-column:1/-1;">
        <div style="font-size:44px;">🦖</div>
        <p>No servers yet.<br>Head to the <a href="/store">store</a> and launch your first game server!</p>
      </div>`;
      return;
    }
    el.innerHTML = data.map(s => {
      const st = s.stats || {};
      const memPct = st.memory_limit_bytes ? Math.round((st.memory_bytes / st.memory_limit_bytes) * 100) : 0;
      const cpuPct = st.cpu_limit_percent ? Math.round((st.cpu_percent / st.cpu_limit_percent) * 100) : 0;
      return `
      <a href="/server/${s.uuid}" class="card server-card" style="color:inherit;">
        <span class="icon">${s.egg_icon || '🖥️'}</span>
        <div class="grow">
          <h3>${PZ.escapeHtml(s.name)} ${s.is_owner ? '' : '<span class="badge">shared</span>'}</h3>
          <div class="muted" style="font-size:13px;">${PZ.escapeHtml(s.egg_name || '')} · ${PZ.escapeHtml(s.plan_name || '')} · node ${PZ.escapeHtml(s.node || 'node-1')} · port ${s.port}</div>
          <div class="stat-bars">
            <div class="bar">RAM ${memPct}%<div class="track"><div class="fill" style="width:${memPct}%"></div></div></div>
            <div class="bar">CPU ${cpuPct}%<div class="track"><div class="fill" style="width:${cpuPct}%"></div></div></div>
          </div>
        </div>
        ${PZ.stateBadge(s.state || 'offline')}
      </a>`;
    }).join('');
  }

  await load();
  setInterval(load, 10000); // refresh states
})();
