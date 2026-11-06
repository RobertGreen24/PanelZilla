/* Login / register page */
(async () => {
  await PZ.renderNav();
  const params = new URLSearchParams(location.search);
  const isRegister = location.pathname === '/register';
  const next = params.get('next') || '/dashboard';

  let mode = isRegister ? 'register' : 'login';
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const usernameField = document.getElementById('username-field');
  const submitBtn = document.getElementById('submit-btn');
  const errEl = document.getElementById('auth-error');

  function setMode(m) {
    mode = m;
    tabLogin.classList.toggle('active', m === 'login');
    tabRegister.classList.toggle('active', m === 'register');
    usernameField.style.display = m === 'register' ? 'block' : 'none';
    submitBtn.textContent = m === 'register' ? 'Create account' : 'Log in';
    errEl.textContent = '';
  }
  tabLogin.onclick = () => setMode('login');
  tabRegister.onclick = () => setMode('register');
  setMode(mode);

  document.getElementById('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    errEl.textContent = '…';
    try {
      const body = {
        email: document.getElementById('email').value.trim(),
        password: document.getElementById('password').value,
      };
      if (mode === 'register') body.username = document.getElementById('username').value.trim();
      const r = await PZ.api('/api/auth/' + mode, { method: 'POST', body });
      if (r.ok) location.href = next;
    } catch (err) { errEl.textContent = err.message; }
  };
})();
