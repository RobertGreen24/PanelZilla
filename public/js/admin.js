/* Admin area: overview stats, user management, server management, orders */
(async () => {
  await PZ.renderNav();
  const user = await PZ.me();
  if (!user || !user.is_admin) { location.href = '/dashboard'; return; }
  const $ = (id) => document.getElementById(id);

  // ---- tabs ----
  document.querySelectorAll('#admin-tabs button').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('#admin-tabs button').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      ['overview', 'users', 'servers', 'orders'].forEach(n => { $('tab-' + n).style.display = n === t.dataset.tab ? 'block' : 'none'; });
      if (t.dataset.tab === 'users') loadUsers();
      if (t.dataset.tab === 'servers') loadServers();
      if (t.dataset.tab === 'orders') loadOrders();
    };
  });

  // ---- overview ----
  async function loadStats() {
    const s = await PZ.api('/api/admin/stats');
    $('stat-cards').innerHTML = `
      <div class="card"><div class="muted" style="font-size:12px;">USERS</div><b style="font-size:26px;">${s.users}</b><div class="muted" style="font-size:12px;">${s.admins} admin(s)</div></div>
      <div class="card"><div class="muted" style="font-size:12px;">SERVERS</div><b style="font-size:26px;">${s.servers}</b><div class="muted" style="font-size:12px;">${s.states.running || 0} running</div></div>
      <div class="card"><div class="muted" style="font-size:12px;">ORDERS</div><b style="font-size:26px;">${s.orders}</b></div>
      <div class="card"><div class="muted" style="font-size:12px;">REVENUE (demo)</div><b style="font-size:26px;">${PZ.fmtMoney(s.revenue_cents)}</b><div class="muted" style="font-size:12px;">all time</div></div>`;
    $('by-egg').innerHTML = s.by_egg.map(e => `
      <div class="file-row"><span>${e.icon}</span><span class="name">${PZ.escapeHtml(e.name)}</span><b>${e.count}</b></div>`).join('') || '<div class="empty">No servers yet</div>';
    $('by-state').innerHTML = Object.entries(s.states).map(([k, v]) => `
      <div class="file-row"><span class="state ${k}">${k}</span><b style="margin-left:auto;">${v}</b></div>`).join('');
    $('recent-orders').innerHTML = s.recent_orders.length ? `<table class="table"><tr><th>#</th><th>Customer</th><th>Total</th><th>Ref</th><th>When</th></tr>` +
      s.recent_orders.map(o => `<tr><td>${o.id}</td><td>${PZ.escapeHtml(o.username)}</td><td>${PZ.fmtMoney(o.total_cents)}</td><td class="mono">${o.payment_ref}</td><td class="muted">${new Date(o.created_at).toLocaleString()}</td></tr>`).join('') + '</table>'
      : '<div class="empty">No orders yet</div>';
  }

  // ---- users ----
  async function loadUsers() {
    const { data } = await PZ.api('/api/admin/users');
    $('users-table').innerHTML = `<tr><th>ID</th><th>User</th><th>Email</th><th>Servers</th><th>Orders</th><th>Spent</th><th>Role</th><th></th></tr>` + data.map(u => `
      <tr>
        <td>${u.id}</td>
        <td><b>${PZ.escapeHtml(u.username)}</b></td>
        <td class="muted">${PZ.escapeHtml(u.email)}</td>
        <td>${u.server_count}</td>
        <td>${u.order_count}</td>
        <td>${PZ.fmtMoney(u.spent_cents)}</td>
        <td>${u.is_admin ? '<span class="badge" style="color:var(--amber); border-color:var(--amber);">admin</span>' : '<span class="badge">user</span>'}</td>
        <td>
          ${u.id === user.id ? '' : `
            <button class="btn ghost small" data-toggle-admin="${u.id}" data-admin="${u.is_admin ? 0 : 1}">${u.is_admin ? 'Revoke admin' : 'Make admin'}</button>
            <button class="btn danger small" data-del-user="${u.id}">Delete</button>`}
        </td>
      </tr>`).join('');
    document.querySelectorAll('[data-toggle-admin]').forEach(b => b.onclick = async () => {
      await PZ.api(`/api/admin/users/${b.dataset.toggleAdmin}/admin`, { method: 'POST', body: { is_admin: b.dataset.admin === '1' } });
      PZ.toast('Role updated'); loadUsers(); loadStats();
    });
    document.querySelectorAll('[data-del-user]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this user AND all their servers?')) return;
      const r = await PZ.api(`/api/admin/users/${b.dataset.delUser}`, { method: 'DELETE' });
      PZ.toast(`User deleted (${r.removed_servers} server(s) removed)`); loadUsers(); loadStats();
    });
  }

  // ---- servers ----
  async function loadServers() {
    const { data } = await PZ.api('/api/admin/servers');
    $('servers-table').innerHTML = `<tr><th>Server</th><th>Owner</th><th>Game</th><th>Plan</th><th>Port</th><th>State</th><th></th></tr>` + data.map(s => `
      <tr>
        <td><a href="/server/${s.uuid}"><b>${PZ.escapeHtml(s.name)}</b></a><div class="muted mono" style="font-size:11px;">${s.uuid.slice(0, 8)}…</div></td>
        <td>${PZ.escapeHtml(s.owner_name)}<div class="muted" style="font-size:11px;">${PZ.escapeHtml(s.owner_email)}</div></td>
        <td>${s.egg_icon} ${PZ.escapeHtml(s.egg_name)}</td>
        <td class="muted">${PZ.escapeHtml(s.plan_name)} · ${PZ.fmtBytes(s.ram_mb)}</td>
        <td class="mono">${s.port}</td>
        <td>${PZ.stateBadge(s.state)}</td>
        <td style="white-space:nowrap;">
          <button class="btn success small" data-apower="${s.uuid}:start">▶</button>
          <button class="btn secondary small" data-apower="${s.uuid}:restart">↻</button>
          <button class="btn danger small" data-apower="${s.uuid}:stop">⏹</button>
          <button class="btn ghost small" data-adel="${s.uuid}">🗑</button>
        </td>
      </tr>`).join('');
    document.querySelectorAll('[data-apower]').forEach(b => b.onclick = async () => {
      const [uuid, action] = b.dataset.apower.split(':');
      try { await PZ.api(`/api/admin/servers/${uuid}/power`, { method: 'POST', body: { action } }); PZ.toast(`Power: ${action}`); loadServers(); }
      catch (e) { PZ.toast(e.message); }
    });
    document.querySelectorAll('[data-adel]').forEach(b => b.onclick = async () => {
      if (!confirm('Destroy this server permanently?')) return;
      await PZ.api(`/api/admin/servers/${b.dataset.adel}`, { method: 'DELETE' });
      PZ.toast('Server destroyed'); loadServers(); loadStats();
    });
  }

  // ---- orders ----
  async function loadOrders() {
    const { data } = await PZ.api('/api/admin/orders');
    $('orders-table').innerHTML = `<tr><th>#</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Payment ref</th><th>When</th></tr>` + data.map(o => `
      <tr>
        <td>${o.id}</td>
        <td>${PZ.escapeHtml(o.username)}<div class="muted" style="font-size:11px;">${PZ.escapeHtml(o.email)}</div></td>
        <td>${o.items}</td>
        <td>${PZ.fmtMoney(o.total_cents)}</td>
        <td><span class="badge" style="color:var(--green); border-color:var(--green);">${o.status}</span></td>
        <td class="mono">${o.payment_ref}</td>
        <td class="muted">${new Date(o.created_at).toLocaleString()}</td>
      </tr>`).join('');
  }

  await loadStats();
})();
