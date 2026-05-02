/**
 * Chrome Extension Service Worker (Manifest V3)
 *
 * Auto-login logic:
 *  On every startup, call chrome.identity.getProfileUserInfo() to read the
 *  email address of the Chrome profile's signed-in Google account.
 *  If that email matches what we have stored in chrome.storage.local, the
 *  session is still valid — the user never has to log in again on that Chrome.
 *  If they switch Chrome profiles or the session expires, they see the Connect screen.
 */

const BACKEND = 'http://localhost:4000';
const HEALTH_ALARM = 'health-check';
const HEALTH_INTERVAL_MINUTES = 5;

// ── Startup ───────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: HEALTH_INTERVAL_MINUTES });
  await detectChromeAccount();
});

chrome.runtime.onStartup.addListener(async () => {
  await detectChromeAccount();
  await runHealthCheck();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEALTH_ALARM) await runHealthCheck();
});

// ── Auto-detect iCloud share tabs ─────────────────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (!isICloudShareUrl(tab.url)) return;

  const { sessionToken } = await chrome.storage.local.get('sessionToken');
  if (!sessionToken) return; // not connected

  const url = normalizeShareUrl(tab.url);
  await submitLink(url);
});

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    CONNECT:         () => startConnectFlow(),
    AUTH_SUCCESS:    () => handleAuthSuccess(msg.sessionToken, msg.email),
    GET_SESSION:     () => getSession(),
    LOGOUT:          () => logout().then(() => ({ ok: true })),
    TOGGLE_SYNC:     () => toggleSync(msg.enabled),
    GET_STATUS:      () => fetchStatus(),
    EXPORT_LOGS:     () => exportLogs(),
    SET_SCAN_DATE:   () => setScanDate(msg.startDate, msg.endDate),
    GET_CHROME_EMAIL:() => getChromeEmail(),
    RUN_NOW:         () => apiFetch('/api/sync/run-now', { method: 'POST' }),
    GET_PROGRESS:    () => apiFetch('/api/sync/progress'),
    GET_HISTORY:        () => apiFetch(`/api/logs?page=${msg.page || 0}&limit=20`),
    GET_SHARE_EMAILS:    () => apiFetch('/api/settings/share-emails'),
    SET_SHARE_EMAILS:    () => apiFetch('/api/settings/share-emails', { method: 'POST', body: { emails: msg.emails } }),
    GET_ALBUM_SETTINGS:  () => apiFetch('/api/settings/album'),
    SET_ALBUM_SETTINGS:  () => apiFetch('/api/settings/album', { method: 'POST', body: { albumDateSource: msg.albumDateSource, albumNamePattern: msg.albumNamePattern, includeShareToken: msg.includeShareToken, shareTokenPosition: msg.shareTokenPosition } }),
    PROCESS_LINK:       () => submitLink(msg.icloudUrl, msg.albumName),
    GET_TAB_LINK:    () => getActiveTabLink(),
  };

  const handler = handlers[msg.type];
  if (!handler) return;
  handler().then(sendResponse);
  return true; // keep channel open for async response
});

// ── Chrome account auto-detection ────────────────────────────────────────────
/**
 * Read the signed-in Chrome profile email (requires "identity" permission).
 * If it matches what we already have stored, no action needed.
 * If it's a different email, clear the stale session so the user is prompted.
 */
async function detectChromeAccount() {
  try {
    const profileInfo = await new Promise((resolve, reject) =>
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) =>
        chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(info)
      )
    );

    const chromeEmail = profileInfo?.email || null;
    if (!chromeEmail) return;

    await chrome.storage.local.set({ chromeEmail });

    const { email: storedEmail, sessionToken } = await chrome.storage.local.get(['email', 'sessionToken']);

    if (!sessionToken) return; // no active session — nothing to validate

    // If the Chrome profile switched to a different Google account, clear the session
    if (storedEmail && storedEmail !== chromeEmail) {
      console.log('[sw] Chrome profile email changed — clearing stale session');
      await chrome.storage.local.remove(['sessionToken', 'email', 'connectedAt']);
      await setBadge('!', '#f59e0b');
    }
  } catch (err) {
    // Non-fatal: Chrome profiles without a signed-in account throw here
    console.warn('[sw] detectChromeAccount failed:', err.message);
  }
}

async function getChromeEmail() {
  const { chromeEmail } = await chrome.storage.local.get('chromeEmail');
  return { email: chromeEmail || null };
}

// ── Connect flow (state-polling) ──────────────────────────────────────────────
/**
 * The reliable OAuth handoff:
 *  1. Generate a cryptographically random state token
 *  2. Open the OAuth URL with ?state=TOKEN in a new tab
 *  3. Poll /auth/poll-session?state=TOKEN every 2 s for up to 2 minutes
 *  4. When backend deposits the session (after callback), pick it up and close the tab
 *
 * This avoids window.opener (null for chrome.tabs.create) and postMessage entirely.
 */
async function startConnectFlow() {
  // Generate a random 32-byte hex state token
  const stateArray = new Uint8Array(32);
  crypto.getRandomValues(stateArray);
  const state = Array.from(stateArray).map(b => b.toString(16).padStart(2, '0')).join('');

  await chrome.storage.local.set({ pendingAuthState: state });

  // Open the OAuth tab
  const tab = await chrome.tabs.create({ url: `${BACKEND}/auth/google?state=${state}` });
  const tabId = tab.id;

  // Poll until session arrives or 2-minute timeout
  const INTERVAL_MS  = 2000;
  const TIMEOUT_MS   = 120_000;
  const started      = Date.now();

  const result = await new Promise((resolve) => {
    const timer = setInterval(async () => {
      if (Date.now() - started > TIMEOUT_MS) {
        clearInterval(timer);
        resolve(null);
        return;
      }
      try {
        const res = await fetch(`${BACKEND}/auth/poll-session?state=${state}`);
        if (res.status === 200) {
          const data = await res.json();
          if (data.ready) {
            clearInterval(timer);
            resolve(data);
          }
        }
      } catch { /* network not ready yet — keep polling */ }
    }, INTERVAL_MS);
  });

  // Close the OAuth tab (user is done with it)
  try { await chrome.tabs.remove(tabId); } catch { /* tab may already be closed */ }
  await chrome.storage.local.remove('pendingAuthState');

  if (result?.sessionToken) {
    await handleAuthSuccess(result.sessionToken, result.email);
    return { ok: true, email: result.email };
  }
  return { ok: false, error: 'Auth timed out or was cancelled' };
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function handleAuthSuccess(sessionToken, email) {
  await chrome.storage.local.set({ sessionToken, email, connectedAt: Date.now() });
  await setBadge('✓', '#22c55e');
  await runHealthCheck();
  return { ok: true };
}

async function getSession() {
  const stored = await chrome.storage.local.get(['sessionToken', 'email', 'connectedAt', 'chromeEmail']);
  return stored;
}

async function logout() {
  const { sessionToken } = await chrome.storage.local.get('sessionToken');
  if (sessionToken) {
    try { await apiFetch('/auth/disconnect', { method: 'POST' }); } catch { /* ignore */ }
  }
  await chrome.storage.local.remove(['sessionToken', 'email', 'connectedAt']);
  await setBadge('', '#6b7280');
}

// ── Sync toggle ───────────────────────────────────────────────────────────────
async function toggleSync(enabled) {
  const result = await apiFetch('/api/sync/toggle', { method: 'POST', body: { enabled } });
  if (result?.ok) {
    await chrome.storage.local.set({ syncEnabled: enabled });
    await updateBadgeForStatus(enabled ? 'active' : 'paused');
  }
  return result;
}

// ── Scan date ─────────────────────────────────────────────────────────────────
async function setScanDate(startDate, endDate = null) {
  const result = await apiFetch('/api/settings/scan-date', {
    method: 'POST',
    body: { startDate, endDate },
  });
  if (result?.ok) {
    await chrome.storage.local.set({ scanFromDate: startDate, scanToDate: endDate });
  }
  return result;
}

// ── Health check ──────────────────────────────────────────────────────────────
async function runHealthCheck() {
  const { sessionToken } = await chrome.storage.local.get('sessionToken');
  if (!sessionToken) return; // not connected — nothing to check

  const status = await fetchStatus();
  if (!status) return;

  await chrome.storage.local.set({ lastStatus: status, lastCheck: Date.now() });
  if (status.scanFromDate) {
    await chrome.storage.local.set({ scanFromDate: status.scanFromDate });
  }
  await updateBadgeForStatus(status.syncStatus);

  if (status.syncStatus === 'token_error') {
    chrome.notifications.create('token-error', {
      type: 'basic',
      iconUrl: '../icons/icon48.png',
      title: 'iCloud Backup — Action Required',
      message: 'Your Google account needs to be reconnected.',
    });
  }
}

async function fetchStatus() {
  try {
    const { sessionToken } = await chrome.storage.local.get('sessionToken');
    if (!sessionToken) return null;

    const headers = { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken };
    const res = await fetch(`${BACKEND}/api/status`, { headers });

    if (res.status === 403) {
      const body = await res.json();
      if (body.code === 'LOCKED') {
        await chrome.storage.local.set({ accountLocked: true });
        await setBadge('✕', '#ef4444');
        chrome.notifications.create('account-locked', {
          type: 'basic',
          iconUrl: '../icons/icon48.png',
          title: 'Account Suspended',
          message: 'Your iCloud Backup account has been suspended. Contact support.',
        });
        return { locked: true };
      }
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    await chrome.storage.local.set({ accountLocked: false });
    return res.json();
  } catch { return null; }
}

async function exportLogs() {
  const { sessionToken } = await chrome.storage.local.get('sessionToken');
  if (!sessionToken) return { error: 'Not authenticated' };
  return { url: `${BACKEND}/api/logs/export`, sessionToken };
}

// ── Badge ─────────────────────────────────────────────────────────────────────
async function updateBadgeForStatus(syncStatus) {
  const map = {
    active:      { text: '●', color: '#22c55e' },
    paused:      { text: '⏸', color: '#6b7280' },
    token_error: { text: '⚠', color: '#ef4444' },
    idle:        { text: '',  color: '#6b7280' },
  };
  const { text, color } = map[syncStatus] || map.idle;
  await setBadge(text, color);
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// ── iCloud link processing ────────────────────────────────────────────────────

function isICloudShareUrl(url) {
  return /https:\/\/share\.icloud\.com\/photos\/|https:\/\/www\.icloud\.com\/photos\/#/.test(url);
}

function normalizeShareUrl(url) {
  // www.icloud.com/photos/#/TOKEN or #TOKEN → canonical share.icloud.com form
  const hashMatch = url.match(/\/photos\/#\/?([A-Za-z0-9_\-]{10,})/);
  if (hashMatch) return `https://share.icloud.com/photos/${hashMatch[1]}`;
  // share.icloud.com/photos/TOKEN — strip per-photo index suffix (/0, /1 etc)
  return url.replace(/\/\d+$/, '').replace(/\/$/, '');
}

async function submitLink(icloudUrl, albumName = null) {
  if (!icloudUrl) return { ok: false, error: 'no_url' };

  // Local dedup — never re-submit a URL we've already queued
  const { processedLinks = [] } = await chrome.storage.local.get('processedLinks');
  if (processedLinks.includes(icloudUrl)) {
    return { ok: false, reason: 'already_processed' };
  }

  try {
    const result = await apiFetch('/api/sync/process-link', {
      method: 'POST',
      body: { icloudUrl, albumName },
    });

    if (result?.ok) {
      // Add to local dedup set (cap at 1000 entries)
      const updated = [icloudUrl, ...processedLinks].slice(0, 1000);
      await chrome.storage.local.set({ processedLinks: updated });
      await setBadge('↑', '#22c55e');
      setTimeout(() => updateBadgeForStatus('active'), 3000);
    }

    return result;
  } catch (err) {
    console.error('[sw] submitLink failed:', err.message);
    return { ok: false, error: err.message || 'Request to backend failed' };
  }
}

async function getActiveTabLink() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && isICloudShareUrl(tab.url)) {
    return { icloudUrl: normalizeShareUrl(tab.url) };
  }
  return { icloudUrl: null };
}

// ── API helper ────────────────────────────────────────────────────────────────
async function apiFetch(path, { method = 'GET', body } = {}) {
  const { sessionToken } = await chrome.storage.local.get('sessionToken');
  const headers = { 'Content-Type': 'application/json' };
  if (sessionToken) headers['X-Session-Token'] = sessionToken;

  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    if (body.code === 'LOCKED') return { locked: true, error: 'account_locked' };
  }

  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}
