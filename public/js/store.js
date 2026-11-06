/* Store page: game tabs, plan cards, cart drawer, demo checkout */
(async () => {
  await PZ.renderNav('store');
  const user = await PZ.me();

  const games = await PZ.api('/api/store/games');
  const tabsEl = document.getElementById('game-tabs');
  const detailEl = document.getElementById('game-detail');

  function renderGame(game) {
    const popularIdx = 1; // "Standard" plan
    detailEl.innerHTML = `
      <div class="game-header">
        <div class="icon">${game.icon}</div>
        <div>
          <h2>${PZ.escapeHtml(game.name)}</h2>
          <div class="muted">${PZ.escapeHtml(game.description)}</div>
          <div class="muted" style="font-size:12px; margin-top:4px;">Docker image: <span class="mono">${PZ.escapeHtml(game.image)}</span> · Category: ${PZ.escapeHtml(game.category)}</div>
        </div>
      </div>
      <div class="grid plans">
        ${game.plans.map((p, i) => `
          <div class="card plan ${i === popularIdx ? 'popular' : ''}">
            ${i === popularIdx ? '<span class="badge">Most popular</span>' : ''}
            <h3>${PZ.escapeHtml(p.name)}</h3>
            <div class="muted">${p.player_slots} player slots</div>
            <div class="price">${PZ.fmtMoney(p.price_cents)}<small> /mo</small></div>
            <ul>${p.features.map(f => `<li>${PZ.escapeHtml(f)}</li>`).join('')}</ul>
            <button class="btn ${i === popularIdx ? '' : 'secondary'} add-cart" data-plan="${p.id}">Add to cart</button>
          </div>`).join('')}
      </div>`;
    detailEl.querySelectorAll('.add-cart').forEach(btn => {
      btn.onclick = async () => {
        if (!user) { location.href = '/login?next=/store'; return; }
        try {
          await PZ.api('/api/store/cart', { method: 'POST', body: { plan_id: Number(btn.dataset.plan) } });
          PZ.toast('Added to cart');
          refreshCart();
        } catch (e) { PZ.toast(e.message); }
      };
    });
  }

  function renderTabs(activeSlug) {
    tabsEl.innerHTML = games.map(g =>
      `<button class="game-tab ${g.slug === activeSlug ? 'active' : ''}" data-slug="${g.slug}"><span class="icon">${g.icon}</span>${PZ.escapeHtml(g.name.split(':')[0])}</button>`
    ).join('');
    tabsEl.querySelectorAll('.game-tab').forEach(t => {
      t.onclick = () => { renderTabs(t.dataset.slug); renderGame(games.find(g => g.slug === t.dataset.slug)); };
    });
  }

  // ---- cart ----
  const drawer = document.getElementById('cart-drawer');
  async function refreshCart() {
    if (!user) return;
    const cart = await PZ.api('/api/store/cart');
    const itemsEl = document.getElementById('cart-items');
    document.getElementById('cart-total').textContent = PZ.fmtMoney(cart.total_cents);
    if (cart.items.length === 0) {
      itemsEl.innerHTML = '<div class="empty">Your cart is empty.<br>Pick a plan below 👇</div>';
      return;
    }
    itemsEl.innerHTML = cart.items.map(i => `
      <div class="cart-item">
        <span class="icon">${i.game_icon}</span>
        <div class="grow">
          <div style="font-weight:700;">${PZ.escapeHtml(i.game_name)}</div>
          <div class="muted" style="font-size:12.5px;">${PZ.escapeHtml(i.plan_name)} · ${PZ.fmtBytes(i.ram_mb)} RAM · ${i.cpu_percent}% CPU</div>
        </div>
        <div style="font-weight:700;">${PZ.fmtMoney(i.price_cents)}</div>
        <button class="btn danger small" data-cart="${i.cart_id}">✕</button>
      </div>`).join('');
    itemsEl.querySelectorAll('[data-cart]').forEach(b => {
      b.onclick = async () => { await PZ.api('/api/store/cart/' + b.dataset.cart, { method: 'DELETE' }); refreshCart(); };
    });
  }

  // cart button injected into nav
  const nav = document.querySelector('.nav .spacer');
  if (user && nav) {
    const b = document.createElement('button');
    b.className = 'btn secondary small cart-btn';
    b.style.marginRight = '10px';
    b.innerHTML = '🛒 Cart <span class="cart-count" id="cart-count">0</span>';
    b.onclick = () => { drawer.classList.add('open'); refreshCart(); };
    nav.after(b);
    const origRefresh = refreshCart;
    refreshCart = async () => { await origRefresh(); const c = await PZ.api('/api/store/cart'); document.getElementById('cart-count').textContent = c.items.length; };
  }

  // ---- checkout ----
  const modal = document.getElementById('checkout-modal');
  document.getElementById('checkout-btn').onclick = async () => {
    const cart = await PZ.api('/api/store/cart');
    if (cart.items.length === 0) { PZ.toast('Cart is empty'); return; }
    document.getElementById('checkout-summary').textContent =
      cart.items.map(i => `${i.game_icon} ${i.game_name} — ${i.plan_name}`).join(' · ');
    document.getElementById('pay-amount').textContent = PZ.fmtMoney(cart.total_cents);
    document.getElementById('checkout-error').textContent = '';
    modal.classList.add('open');
  };
  document.getElementById('cancel-checkout').onclick = () => modal.classList.remove('open');

  document.getElementById('pay-btn').onclick = async () => {
    const errEl = document.getElementById('checkout-error');
    errEl.textContent = 'Processing payment…';
    try {
      const r = await PZ.api('/api/store/checkout', {
        method: 'POST',
        body: {
          card_number: document.getElementById('cc-num').value,
          card_name: document.getElementById('cc-name').value || 'PanelZilla Customer',
          expiry: document.getElementById('cc-exp').value,
          cvc: document.getElementById('cc-cvc').value,
        },
      });
      modal.classList.remove('open');
      drawer.classList.remove('open');
      document.getElementById('success-text').innerHTML =
        `Payment ref <b class="mono">${r.payment_ref}</b> · ${r.provisioned.length} server(s) provisioned.<br>` +
        (r.failed.length ? `<span style="color:var(--amber)">${r.failed.length} server(s) queued for retry.</span>` : '');
      document.getElementById('success-modal').classList.add('open');
      refreshCart();
    } catch (e) { errEl.textContent = e.message; }
  };

  // ---- init ----
  renderTabs(games[0].slug);
  renderGame(games[0]);
  if (user) refreshCart();
})();
