/* PanelZilla shared frontend helpers */
window.PZ = (() => {
  const fmtMoney = (cents) => '£' + (cents / 100).toFixed(2);
  const fmtBytes = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB');

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || ('Request failed: ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function me() {
    try { const r = await api('/api/auth/me'); return r.user; } catch (_) { return null; }
  }

  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function renderNav(active) {
    const user = await me();
    const nav = document.querySelector('.nav');
    if (!nav) return;
    nav.innerHTML = `
      <a class="brand" href="/">Panel<span>Zilla</span></a>
      <div class="links">
        <a href="/" class="${active === 'home' ? 'active' : ''}">Home</a>
        <a href="/store" class="${active === 'store' ? 'active' : ''}">Store</a>
        ${user ? `<a href="/dashboard" class="${active === 'dashboard' ? 'active' : ''}">Dashboard</a>` : ''}
        ${user && user.is_admin ? `<a href="/admin" class="${active === 'admin' ? 'active' : ''}">🛡️ Admin</a>` : ''}
      </div>
      <div class="spacer"></div>
      ${user
        ? `<span class="user">👤 ${escapeHtml(user.username)}</span>
           <a class="btn secondary small" href="/dashboard">My servers</a>
           <button class="btn ghost small" id="logout-btn">Log out</button>`
        : `<a class="btn ghost small" href="/login">Log in</a>
           <a class="btn small" href="/register">Sign up</a>`}`;
    const lb = document.getElementById('logout-btn');
    if (lb) lb.onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function stateBadge(state) {
    return `<span class="state ${state}">${state}</span>`;
  }

  return { api, me, toast, fmtMoney, fmtBytes, renderNav, escapeHtml, stateBadge };
})();
