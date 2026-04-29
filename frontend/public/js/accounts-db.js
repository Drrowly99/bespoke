(() => {
  const ACCOUNT_LIST_ID = 'connection-list';
  const OVERLAY_ID = 'overlay-disconnected';
  const CONNECT_BTN_ID = 'btn-connect';
  const OVERLAY_TITLE_SELECTOR = '.overlay-title';
  const OVERLAY_SUB_SELECTOR = '.overlay-sub';
  const SESSION_KEY = 'sessionToken';
  const EMAIL_KEY = 'userEmail';
  const SELECTED_KEY = 'selectedConnectionToken';

  async function fetchAccounts() {
    const res = await fetch('/api/accounts', { headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    return data?.accounts || [];
  }

  function setActiveSession(account) {
    if (!account?.sessionToken) return;
    localStorage.setItem(SESSION_KEY, account.sessionToken);
    localStorage.setItem(EMAIL_KEY, account.email || '');
    localStorage.setItem(SELECTED_KEY, account.sessionToken);
  }

  function render(accounts) {
    const overlay = document.getElementById(OVERLAY_ID);
    const list = document.getElementById(ACCOUNT_LIST_ID);
    const connectBtn = document.getElementById(CONNECT_BTN_ID);
    const title = overlay?.querySelector(OVERLAY_TITLE_SELECTOR);
    const sub = overlay?.querySelector(OVERLAY_SUB_SELECTOR);
    if (!overlay || !list) return;

    const activeToken = localStorage.getItem(SELECTED_KEY) || localStorage.getItem(SESSION_KEY);
    if (title) title.textContent = 'Gmail connections';
    if (sub) sub.textContent = 'Pick an existing connected inbox, or add another Google account.';

    if (!accounts.length) {
      list.innerHTML = '<div class="empty-state" style="margin:0 0 16px">No saved Gmail connections yet. Add one to open the dashboard.</div>';
      if (connectBtn) {
        connectBtn.hidden = false;
        connectBtn.style.display = '';
      }
      overlay.classList.remove('hidden');
      return;
    }

    if (connectBtn) {
      connectBtn.hidden = true;
      connectBtn.style.display = 'none';
    }

    list.innerHTML = accounts.map((account, index) => {
      const isActive = account.sessionToken && account.sessionToken === activeToken;
      const lockLabel = account.isLocked ? 'locked' : (account.sessionToken ? 'connected' : 'reconnect');
      const syncLabel = account.syncStatus || 'idle';
      return `
        <button class="connection-pill ${isActive ? 'active' : ''}" data-account-token="${account.sessionToken || ''}" ${account.sessionToken ? '' : 'disabled'}>
          <span class="connection-pill-email">${account.email || `Connection ${index + 1}`}</span>
          <span class="connection-pill-meta">${syncLabel} · ${lockLabel}</span>
        </button>
      `;
    }).join('');

    list.querySelectorAll('[data-account-token]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const token = btn.getAttribute('data-account-token');
        if (!token) return;
        const account = accounts.find((row) => row.sessionToken === token);
        if (!account) return;
        setActiveSession(account);
        if (typeof window.openDashboard === 'function') {
          await window.openDashboard(token);
        } else {
          overlay.classList.add('hidden');
          location.reload();
        }
      });
    });

    overlay.classList.remove('hidden');
  }

  async function refresh() {
    const accounts = await fetchAccounts();
    render(accounts);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }
  window.refreshAccountPicker = refresh;
})();
