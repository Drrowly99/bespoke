const views = {
  loading:     document.getElementById('view-loading'),
  connected:   document.getElementById('view-connected'),
  disconnected:document.getElementById('view-disconnected'),
};

function show(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
}

async function init() {
  show('loading');

  const session = await sw('GET_SESSION');
  if (!session?.sessionToken) {
    const { email: chromeEmail } = await sw('GET_CHROME_EMAIL');
    if (chromeEmail) {
      const hint = document.getElementById('detected-hint');
      hint.textContent = `Detected: ${chromeEmail}`;
      hint.classList.remove('hidden');
      document.getElementById('btn-connect').textContent = `Connect ${chromeEmail}`;
    }
    show('disconnected');
    return;
  }

  const status = await sw('GET_STATUS');
  if (!status || status.error === 'Unauthenticated') { show('disconnected'); return; }

  document.getElementById('account-email').textContent = session.email || status.email || '—';

  const statusLabels = {
    active: '✅ Running', paused: '⏸ Paused',
    token_error: '⚠️ Reconnect required', idle: '✅ Active', processing: '🔄 Scanning…',
  };
  document.getElementById('status-text').textContent = statusLabels[status.syncStatus] || '✅ Active';

  const dot = document.getElementById('status-dot');
  dot.className = `status-dot ${status.syncStatus === 'idle' ? 'active' : (status.syncStatus || 'active')}`;

  show('connected');
}

document.getElementById('btn-open-dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
  window.close();
});

document.getElementById('btn-sync-now').addEventListener('click', async () => {
  const btn = document.getElementById('btn-sync-now');
  btn.textContent = 'Starting…';
  btn.disabled = true;
  await sw('RUN_NOW');
  btn.textContent = 'Started ✓';
  setTimeout(() => window.close(), 800);
});

document.getElementById('btn-connect').addEventListener('click', async () => {
  const btn = document.getElementById('btn-connect');
  btn.disabled = true;
  btn.textContent = 'Opening sign-in…';
  document.getElementById('connect-waiting').classList.remove('hidden');
  const result = await sw('CONNECT');
  document.getElementById('connect-waiting').classList.add('hidden');
  if (result?.ok) await init();
  else { btn.disabled = false; btn.textContent = 'Connect Gmail'; }
});

function sw(type, payload = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type, ...payload }, res => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(res);
    });
  });
}

init();
