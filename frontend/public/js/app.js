/**
 * iCloud Backup — Web Dashboard
 * Accounts are fetched from the backend on every load (source of truth = DB).
 * The active session token is stored in localStorage under 'sessionToken'.
 */

const POLL_MS     = 3000;
const SESSION_KEY = 'sessionToken';
const EMAIL_KEY   = 'userEmail';
const SAMPLE_SHARE_TOKEN = '027hSDCde-ExfSzGaGDm08kPQ';

// ── State ─────────────────────────────────────────────────────────────────────
let pollTimer  = null;
let histPage   = 0;
let histTotal  = 0;
let shareEmails = [];
let linkQueue  = [];
let accounts   = []; // [{ email, token }] — loaded from backend

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const els = {
  // Sidebar
  sbEmail:      $('sb-email'),
  sbStatusDot:  $('sb-status-dot'),
  sbSwitch:     $('sb-switch'),
  sbReconnect:  $('sb-reconnect'),
  sbDisconnect: $('sb-disconnect'),
  // Sync
  syncToggle:       $('toggle-sync'),
  syncMeta:         $('sync-meta'),
  syncStatusDot:    $('sync-status-dot'),
  syncStatusText:   $('sync-status-text'),
  btnSyncNow:       $('btn-sync-now'),
  inputScanFrom:    $('input-scan-from'),
  inputScanTo:      $('input-scan-to'),
  btnSetDate:       $('btn-set-date'),
  scanDateHint:     $('scan-date-hint'),
  activityRunning:  $('activity-running'),
  activityRunningTxt: $('activity-running-text'),
  activityList:     $('activity-list'),
  // Back up
  inputLinkUrl:   $('input-link-url'),
  inputLinkAlbum: $('input-link-album'),
  btnAddLink:     $('btn-add-link'),
  addLinkHint:    $('add-link-hint'),
  queueList:      $('queue-list'),
  queueCount:     $('queue-count'),
  btnClearQueue:  $('btn-clear-queue'),
  btnBackupAll:   $('btn-backup-all'),
  // History
  historyList:       $('history-list'),
  historyPagination: $('history-pagination'),
  btnHistPrev:       $('btn-hist-prev'),
  btnHistNext:       $('btn-hist-next'),
  histPageLabel:     $('hist-page-label'),
  btnExport:         $('btn-export'),
  // Settings — album naming
  selectAlbumDateSource: $('select-album-date-source'),
  inputAlbumPattern:     $('input-album-pattern'),
  inputIncludeShareToken: $('input-include-share-token'),
  selectShareTokenPosition: $('select-share-token-position'),
  btnSaveAlbumSettings:  $('btn-save-album-settings'),
  albumSettingsHint:     $('album-settings-hint'),
  albumNamePreview:      $('album-name-preview'),
  // Settings — share emails
  shareEmailsList: $('share-emails-list'),
  inputShareEmail: $('input-share-email'),
  btnAddEmail:     $('btn-add-email'),
  shareEmailHint:  $('share-email-hint'),
  // Connect overlay
  overlayDisconnected: $('overlay-disconnected'),
  connectionList:      $('connection-list'),
  btnConnect:          $('btn-connect'),
};

// ── API helper ────────────────────────────────────────────────────────────────
async function apiFetch(path, { method = 'GET', body } = {}) {
  const token = localStorage.getItem(SESSION_KEY);
  try {
    const res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Session-Token': token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 401) {
      console.warn('[apiFetch] 401 on', path, '— clearing session, back to picker');
      clearSession();
      showOverlay();
      return null;
    }

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const msg = data?.error || `HTTP ${res.status}`;
      console.error(`[apiFetch] ${method} ${path} → ${res.status}: ${msg}`);
      return { ok: false, error: msg };
    }

    return data;
  } catch (err) {
    console.error(`[apiFetch] ${method} ${path} → network error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(EMAIL_KEY);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  console.log('[init] fetching connected accounts from /auth/accounts…');

  // Handle OAuth redirect: ?token=...&email=...
  const params = new URLSearchParams(location.search);
  const redirectToken = params.get('token');
  const redirectEmail = params.get('email') || '';
  if (redirectToken) {
    history.replaceState(null, '', '/');
  }

  // Fetch all connected accounts from backend (source of truth)
  let fetched = [];
  try {
    const res  = await fetch('/auth/accounts');
    const data = res.ok ? await res.json() : null;
    fetched = data?.accounts || [];
    console.log('[init] accounts from DB:', fetched.map(a => a.email));
  } catch (err) {
    console.error('[init] failed to fetch /auth/accounts:', err.message);
  }

  // If we just came back from OAuth, merge the new account in (it may not be in
  // the DB list yet if the request raced, so add it explicitly)
  if (redirectToken) {
    const already = fetched.find(a => a.token === redirectToken);
    if (!already) fetched.unshift({ email: redirectEmail, token: redirectToken });
    localStorage.setItem(SESSION_KEY, redirectToken);
    if (redirectEmail) localStorage.setItem(EMAIL_KEY, redirectEmail);
  }

  accounts = fetched;

  // If we just came back from OAuth, auto-open that account — no extra click needed
  if (redirectToken) {
    console.log('[init] OAuth redirect — auto-opening dashboard for:', redirectEmail);
    return openDashboard(redirectToken);
  }

  renderConnectionOverlay();
  els.overlayDisconnected.classList.remove('hidden');
}

// ── Account picker overlay ────────────────────────────────────────────────────
function showOverlay() {
  console.log('[showOverlay] accounts available:', accounts.map(a => a.email));
  renderConnectionOverlay();
  els.overlayDisconnected.classList.remove('hidden');
}

function renderConnectionOverlay() {
  if (!els.connectionList) return;

  if (!accounts.length) {
    els.connectionList.innerHTML =
      `<div class="empty-state" style="margin:0 0 16px">No Gmail accounts connected yet.<br>Click below to add one.</div>`;
    return;
  }

  const activeToken = localStorage.getItem(SESSION_KEY);
  els.connectionList.innerHTML = accounts.map(acc => `
    <button class="connection-pill ${acc.token === activeToken ? 'active' : ''}"
            data-token="${esc(acc.token)}">
      <span class="connection-pill-email">${esc(acc.email || 'Unknown account')}</span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           style="flex-shrink:0;opacity:.4"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>
    </button>
  `).join('');

  els.connectionList.querySelectorAll('[data-token]').forEach(btn => {
    btn.addEventListener('click', () => openDashboard(btn.dataset.token));
  });
}

async function openDashboard(token) {
  if (!token) return;
  console.log('[openDashboard] validating session for token:', token.slice(0, 8) + '…');

  const acc = accounts.find(a => a.token === token);
  localStorage.setItem(SESSION_KEY, token);
  if (acc?.email) localStorage.setItem(EMAIL_KEY, acc.email);

  els.overlayDisconnected.classList.add('hidden');

  const me = await apiFetch('/auth/me');
  if (!me) {
    // apiFetch already called showOverlay on 401
    return;
  }

  console.log('[openDashboard] session valid, loading dashboard for:', me.email);

  els.sbEmail.textContent = me.email || acc?.email || '—';

  const status = await apiFetch('/api/status');
  if (status) renderSyncCard(status);

  loadShareEmails();
  loadAlbumSettings();
}

// ── Navigation ────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.section;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.section').forEach(s => s.classList.toggle('hidden', s.id !== `section-${id}`));
    if (id === 'history')  { histPage = 0; loadHistory(); }
    if (id === 'settings') { loadShareEmails(); loadAlbumSettings(); }
  });
});

// ── Sync card ─────────────────────────────────────────────────────────────────
function renderSyncCard(status) {
  els.syncToggle.checked = status?.syncEnabled ?? false;
  updateStatusBadge(status?.syncStatus ?? 'idle');
  const lastSync = status?.lastSync ? new Date(status.lastSync).toLocaleString() : 'Never';
  els.syncMeta.textContent = status?.syncEnabled
    ? `Auto-polling every 3 min · Last: ${lastSync}`
    : `Paused · Last: ${lastSync}`;
  const today = todayISO();
  els.inputScanFrom.value = status?.scanFromDate || today;
  els.inputScanFrom.max   = today;
  els.inputScanTo.value   = status?.scanToDate  || '';
  els.inputScanTo.max     = today;
  updateScanHint(status?.scanFromDate || today, status?.scanToDate || null);
}

function updateStatusBadge(s) {
  const labels = {
    active:      'Running in background',
    paused:      'Paused',
    token_error: 'Reconnect required',
    idle:        'Active',
    processing:  'Scanning now…',
  };
  const dotClass = s === 'idle' ? 'active' : s;
  els.syncStatusDot.className = `status-dot ${dotClass}`;
  els.sbStatusDot.className   = `status-dot ${dotClass}`;
  els.syncStatusText.textContent = labels[s] || 'Active';
}

function updateScanHint(from, to) {
  els.scanDateHint.textContent = !to
    ? (from === todayISO() ? 'Scanning from today onwards.' : `Scanning from ${from} → ongoing.`)
    : `Scanning ${from} – ${to}.`;
}

els.syncToggle.addEventListener('change', async () => {
  const enabled = els.syncToggle.checked;
  els.syncToggle.disabled = true;
  const result = await apiFetch('/api/sync/toggle', { method: 'POST', body: { enabled } });
  els.syncToggle.disabled = false;
  if (result?.ok) {
    updateStatusBadge(enabled ? 'active' : 'paused');
    if (enabled) setTimeout(refreshActivity, 800);
  } else {
    els.syncToggle.checked = !enabled;
  }
});

els.btnSyncNow.addEventListener('click', async () => {
  els.btnSyncNow.disabled = true;
  els.btnSyncNow.textContent = 'Starting…';
  const result = await apiFetch('/api/sync/run-now', { method: 'POST' });
  if (result?.alreadyRunning) {
    // Another sync is already in progress — just make sure the timer is watching it
    els.btnSyncNow.textContent = 'Running…';
    startPolling();
    return;
  }
  // Give the backend a moment to call startRun, then begin polling for completion
  setTimeout(() => startPolling(), 800);
});

const SYNC_NOW_HTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>Sync Now`;

els.btnSetDate.addEventListener('click', async () => {
  const startDate = els.inputScanFrom.value;
  const endDate   = els.inputScanTo.value || null;
  if (!startDate) return;
  els.btnSetDate.textContent = 'Saving…';
  els.btnSetDate.disabled = true;
  const result = await apiFetch('/api/settings/scan-date', { method: 'POST', body: { startDate, endDate } });
  els.btnSetDate.disabled = false;
  els.btnSetDate.textContent = result?.ok ? 'Saved' : 'Error';
  if (result?.ok) {
    updateScanHint(startDate, endDate);
    setTimeout(() => { els.btnSetDate.textContent = 'Apply'; }, 2000);
  }
});

// ── Activity polling ──────────────────────────────────────────────────────────
function startPolling() {
  if (pollTimer) return;
  refreshActivity();
  pollTimer = setInterval(refreshActivity, POLL_MS);
}

async function refreshActivity() {
  const p = await apiFetch('/api/sync/progress');
  if (!p) return;

  if (p.running) {
    els.activityRunning.classList.remove('hidden');
    els.activityRunningTxt.textContent = p.phase === 'scanning'
      ? 'Scanning Gmail for iCloud links…'
      : p.currentItem
        ? `Uploading: ${p.currentItem}`
        : `Found ${p.found} link(s), uploading…`;
    els.btnSyncNow.disabled = true;
    els.btnSyncNow.textContent = 'Running…';
    updateStatusBadge('processing');
    els.syncMeta.textContent = p.currentItem ? `Uploading: ${p.currentItem}` : 'Scanning Gmail…';
    // Keep the timer alive so we detect when running flips back to false
    if (!pollTimer) pollTimer = setInterval(refreshActivity, POLL_MS);
  } else {
    els.activityRunning.classList.add('hidden');
    els.btnSyncNow.disabled = false;
    els.btnSyncNow.innerHTML = SYNC_NOW_HTML;
    if (p.lastRunAt) {
      const ago = timeAgo(p.lastRunAt);
      els.syncMeta.textContent = p.lastRunFound === 0
        ? `Last scan ${ago} · No new links found`
        : `Last scan ${ago} · ${p.lastRunDone}/${p.lastRunFound} uploaded`;
    }
    // Sync is done — stop polling to save API calls
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  if (!p.recentItems?.length) {
    els.activityList.innerHTML = `<div class="empty-state">No emails processed yet.<br>Click "Sync Now" to start.</div>`;
    return;
  }
  els.activityList.innerHTML = p.recentItems.map(item => renderItem(item)).join('');
}

// ── Multi-link queue ──────────────────────────────────────────────────────────
els.btnAddLink.addEventListener('click', addLinksToQueue);
els.inputLinkUrl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addLinksToQueue(); } });

function addLinksToQueue() {
  const raw   = els.inputLinkUrl.value.trim();
  const album = els.inputLinkAlbum.value.trim() || null;

  if (!raw) { showHint(els.addLinkHint, 'Paste at least one iCloud link', 'error'); return; }

  // Accept links separated by commas, newlines, or spaces
  const urls = raw.split(/[\n\r,\s]+/).map(u => u.trim()).filter(u => u.includes('icloud.com'));
  if (!urls.length) { showHint(els.addLinkHint, 'No valid iCloud links found', 'error'); return; }

  if (urls.length > 1) {
    // Multiple links → one queue entry, all photos land in the same album
    const queueKey = urls.slice().sort().join('|');
    if (linkQueue.find(q => q.urls?.slice().sort().join('|') === queueKey)) {
      showHint(els.addLinkHint, 'That batch is already in the queue', 'info');
      return;
    }
    linkQueue.push({ url: urls[0], urls, albumName: album, status: 'pending' });
    showHint(els.addLinkHint, `${urls.length} links queued → ${album ? `album "${album}"` : 'auto-named album'}`, 'ok');
  } else {
    const url = urls[0];
    if (linkQueue.find(q => q.url === url && !q.urls)) {
      showHint(els.addLinkHint, 'That link is already in the queue', 'info');
      return;
    }
    linkQueue.push({ url, albumName: album || null, status: 'pending' });
    showHint(els.addLinkHint, album ? `Queued → album "${album}"` : 'Queued (auto-named)', 'ok');
  }

  els.inputLinkUrl.value   = '';
  els.inputLinkAlbum.value = '';
  renderQueue();
}

function renderQueue() {
  els.queueCount.textContent  = linkQueue.length;
  els.btnBackupAll.disabled   = !linkQueue.some(q => q.status === 'pending');

  if (!linkQueue.length) {
    els.queueList.innerHTML = `<div class="empty-state">No links queued yet. Add some above.</div>`;
    return;
  }

  els.queueList.innerHTML = linkQueue.map((item, i) => {
      const token     = item.url.match(/\/photos\/[#/]*([A-Za-z0-9_\-]{6,})/)?.[1] || item.url.slice(-16);
    const albumText = item.albumName
      ? `<span class="queue-item-album">${esc(item.albumName)}</span>`
      : `<span class="queue-item-album" style="font-style:italic;color:#9ca3af">auto-named</span>`;
    const statusMap = {
      pending:   `<span class="queue-item-status" style="color:#9ca3af">Queued</span>`,
      uploading: `<span class="queue-item-status queue-processing"><span class="mini-spinner"></span>Uploading…</span>`,
      done:      `<span class="queue-item-status queue-done">Done</span>`,
      error:     `<span class="queue-item-status queue-error" title="${esc(item.error || '')}">Failed</span>`,
    };
    const removeBtn = item.status === 'pending'
      ? `<button class="link-btn danger" data-remove="${i}" style="margin-left:8px" title="Remove">✕</button>`
      : '';

    return `<div class="queue-item">
      <span class="queue-item-num">${i + 1}</span>
      <span class="queue-item-url" title="${esc(item.url)}">…${token}</span>
      ${albumText}
      ${statusMap[item.status] || ''}
      ${removeBtn}
    </div>`;
  }).join('');

  els.queueList.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      linkQueue.splice(parseInt(btn.dataset.remove), 1);
      renderQueue();
    });
  });
}

els.btnClearQueue.addEventListener('click', () => {
  linkQueue = linkQueue.filter(q => q.status === 'uploading');
  renderQueue();
});

els.btnBackupAll.addEventListener('click', async () => {
  els.btnBackupAll.disabled = true;
  const pending = linkQueue.filter(q => q.status === 'pending');

  for (const item of pending) {
    item.status = 'uploading';
    renderQueue();
    try {
      const result = await apiFetch('/api/sync/process-link', {
        method: 'POST',
        body: item.urls?.length
          ? { icloudUrls: item.urls, albumName: item.albumName }
          : { icloudUrl: item.url, albumName: item.albumName },
      });
      item.status = result?.ok ? 'done' : 'error';
      if (!result?.ok) item.error = result?.error || 'Unknown error';
    } catch (err) {
      item.status = 'error';
      item.error  = err.message;
    }
    renderQueue();
  }

  setTimeout(refreshActivity, 1000);
  els.btnBackupAll.disabled = !linkQueue.some(q => q.status === 'pending');
});

// ── History ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  els.historyList.innerHTML = `<div class="empty-state">Loading…</div>`;
  const data = await apiFetch(`/api/logs?page=${histPage}&limit=20`);
  if (!data) {
    els.historyList.innerHTML = `<div class="empty-state">Could not load history.</div>`;
    return;
  }

  histTotal = data.total || 0;
  if (!data.items?.length) {
    els.historyList.innerHTML = `<div class="empty-state">No backup history yet.</div>`;
    els.historyPagination.classList.add('hidden');
    return;
  }

  els.historyList.innerHTML = data.items.map(item => renderItem(item, true)).join('');

  const totalPages = Math.ceil(histTotal / 20);
  if (totalPages > 1) {
    els.historyPagination.classList.remove('hidden');
    els.histPageLabel.textContent = `Page ${histPage + 1} of ${totalPages}`;
    els.btnHistPrev.disabled = histPage === 0;
    els.btnHistNext.disabled = histPage >= totalPages - 1;
  } else {
    els.historyPagination.classList.add('hidden');
  }
}

els.btnHistPrev.addEventListener('click', () => { histPage--; loadHistory(); });
els.btnHistNext.addEventListener('click', () => { histPage++; loadHistory(); });

els.btnExport.addEventListener('click', () => {
  const token = localStorage.getItem(SESSION_KEY);
  if (token) window.open(`/api/logs/export?_t=${encodeURIComponent(token)}`);
});

// ── Settings — album naming ───────────────────────────────────────────────────
async function loadAlbumSettings() {
  const data = await apiFetch('/api/settings/album');
  if (!data) return;
  els.selectAlbumDateSource.value = data.albumDateSource || 'received';
  els.inputAlbumPattern.value     = data.albumNamePattern || 'Auto Backup - {date} - {location}';
  els.inputIncludeShareToken.checked = !!data.includeShareToken;
  els.selectShareTokenPosition.value = data.shareTokenPosition || 'suffix';
  refreshAlbumPreview();
}

function updateAlbumPreview() {
  const pattern    = els.inputAlbumPattern.value || 'Auto Backup - {date} - {location}';
  const dateSource = els.selectAlbumDateSource.value;
  const exDate     = dateSource === 'exif' ? '2024-07-15' : todayISO();
  const preview    = pattern
    .replace('{date}', exDate)
    .replace('{location}', 'London, England')
    .replace(/[\s\-–|,]+$/, '').trim();
  els.albumNamePreview.textContent = preview || `Auto Backup - ${exDate}`;
}

els.inputAlbumPattern.addEventListener('input', refreshAlbumPreview);
els.selectAlbumDateSource.addEventListener('change', refreshAlbumPreview);

els.btnSaveAlbumSettings.addEventListener('click', async () => {
  els.btnSaveAlbumSettings.disabled = true;
  const result = await apiFetch('/api/settings/album', {
    method: 'POST',
    body: {
      albumDateSource:  els.selectAlbumDateSource.value,
      albumNamePattern: els.inputAlbumPattern.value.trim() || 'Auto Backup - {date} - {location}',
      includeShareToken: els.inputIncludeShareToken.checked,
      shareTokenPosition: els.selectShareTokenPosition.value,
    },
  });
  els.btnSaveAlbumSettings.disabled = false;
  showHint(els.albumSettingsHint, result?.ok ? 'Saved' : 'Save failed', result?.ok ? 'ok' : 'error');
  if (result?.ok) refreshAlbumPreview();
});

function updateShareTokenControls() {
  els.selectShareTokenPosition.disabled = !els.inputIncludeShareToken.checked;
}

function refreshAlbumPreview() {
  const pattern = els.inputAlbumPattern.value || 'Auto Backup - {date} - {location}';
  const dateSource = els.selectAlbumDateSource.value;
  const exDate = dateSource === 'exif' ? '2024-07-15' : todayISO();
  const includeToken = els.inputIncludeShareToken.checked;
  const tokenPattern = pattern.includes('{icloudToken}');
  const preview = pattern
    .replace(/\{date\}/g, exDate)
    .replace(/\{location\}/g, 'London, England')
    .replace(/\{icloudToken\}/g, includeToken ? SAMPLE_SHARE_TOKEN : '');
  const arranged = includeToken && SAMPLE_SHARE_TOKEN && !tokenPattern
    ? (els.selectShareTokenPosition.value === 'prefix' ? `${SAMPLE_SHARE_TOKEN} - ${preview}` : `${preview} - ${SAMPLE_SHARE_TOKEN}`)
    : preview;
  els.albumNamePreview.textContent = arranged.replace(/[\s\-–|,]+$/, '').replace(/\s{2,}/g, ' ').trim() || `Auto Backup - ${exDate}`;
  updateShareTokenControls();
}

els.inputAlbumPattern.addEventListener('input', refreshAlbumPreview);
els.selectAlbumDateSource.addEventListener('change', refreshAlbumPreview);
els.inputIncludeShareToken.addEventListener('change', refreshAlbumPreview);
els.selectShareTokenPosition.addEventListener('change', refreshAlbumPreview);

// ── Settings — share emails ───────────────────────────────────────────────────
async function loadShareEmails() {
  const data = await apiFetch('/api/settings/share-emails');
  shareEmails = data?.shareEmails || [];
  renderShareEmails();
}

function renderShareEmails() {
  if (!shareEmails.length) {
    els.shareEmailsList.innerHTML = `<p class="hint-text" style="padding:8px 0">No recipients yet.</p>`;
    return;
  }
  els.shareEmailsList.innerHTML = shareEmails.map((email, i) =>
    `<div class="share-email-row">
      <span class="share-email-addr">${esc(email)}</span>
      <button class="btn btn-ghost btn-sm" data-idx="${i}">Remove</button>
    </div>`
  ).join('');
  els.shareEmailsList.querySelectorAll('[data-idx]').forEach(btn => {
    btn.addEventListener('click', async () => {
      shareEmails.splice(parseInt(btn.dataset.idx), 1);
      await saveShareEmails();
    });
  });
}

async function saveShareEmails() {
  const result = await apiFetch('/api/settings/share-emails', { method: 'POST', body: { emails: shareEmails } });
  if (result?.ok) {
    shareEmails = result.shareEmails;
    renderShareEmails();
    showHint(els.shareEmailHint, 'Saved', 'ok');
  } else {
    const msg = result?.error || 'Save failed';
    showHint(els.shareEmailHint, msg.includes('column') ? 'DB column missing — run SQL migrations' : msg, 'error');
  }
}

els.btnAddEmail.addEventListener('click', async () => {
  const email = els.inputShareEmail.value.trim().toLowerCase();
  if (!email || !email.includes('@')) { showHint(els.shareEmailHint, 'Enter a valid email address', 'error'); return; }
  if (shareEmails.includes(email))    { showHint(els.shareEmailHint, 'Already in list', 'info'); return; }
  shareEmails.push(email);
  els.inputShareEmail.value = '';
  await saveShareEmails();
});
els.inputShareEmail.addEventListener('keydown', e => { if (e.key === 'Enter') els.btnAddEmail.click(); });

// ── Account ───────────────────────────────────────────────────────────────────
els.sbSwitch.addEventListener('click', () => {
  clearSession();
  showOverlay();
});

els.sbReconnect.addEventListener('click', () => { location.href = '/auth/google'; });

els.sbDisconnect.addEventListener('click', async () => {
  if (!confirm('Disconnect this Gmail account?')) return;
  const token = localStorage.getItem(SESSION_KEY);
  if (token) {
    await fetch('/auth/disconnect', {
      method: 'POST',
      headers: { 'X-Session-Token': token, 'Content-Type': 'application/json' },
    });
  }
  clearSession();
  // Reload so the picker re-fetches accounts from the DB (removed account won't appear)
  location.reload();
});

// ── Shared item renderer ──────────────────────────────────────────────────────
const STATUS_ICONS = {
  completed: `<span class="item-icon-wrap icon-completed">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg></span>`,
  failed: `<span class="item-icon-wrap icon-failed">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg></span>`,
  skipped: `<span class="item-icon-wrap icon-skipped">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg></span>`,
  pending: `<span class="item-icon-wrap icon-pending">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg></span>`,
  processing: `<span class="item-icon-wrap icon-processing">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" class="spin-icon">
      <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
    </svg></span>`,
};

function renderItem(item, showDetails = false) {
  const iconHtml = STATUS_ICONS[item.status] || STATUS_ICONS.pending;
  const sender    = (item.sender || '').replace(/<.*>/, '').trim().slice(0, 35);
  const subject   = (item.subject || '(no subject)').slice(0, 55);
  const location  = item.property_label || item.caption || '';
  const albumLink = item.google_album_url
    ? `<a href="${esc(item.google_album_url)}" target="_blank" rel="noopener" class="album-link">Open Album ↗</a>`
    : '';
  const errorHint = item.status === 'failed' && item.error_reason
    ? `<div class="item-error">${esc(item.error_reason.slice(0, 100))}</div>` : '';
  const assetCount = showDetails && item.total_assets
    ? `<span class="item-dot">·</span><span class="item-assets">${item.uploaded_assets ?? 0}/${item.total_assets} files</span>` : '';
  const badge = showDetails
    ? `<span class="status-badge status-${item.status}">${item.status}</span>` : '';

  return `<div class="list-item">
    <div class="item-icon-col">${iconHtml}</div>
    <div class="item-body">
      <div class="item-subject">${esc(subject)}${badge}</div>
      <div class="item-meta">
        ${sender   ? `<span class="item-sender">${esc(sender)}</span>` : ''}
        ${location ? `<span class="item-dot">·</span><span class="item-location">${esc(location.slice(0, 40))}</span>` : ''}
        ${assetCount}
        <span class="item-dot">·</span>
        <span class="item-time">${timeAgo(item.created_at)}</span>
      </div>
      ${errorHint}
      ${albumLink}
    </div>
  </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showHint(el, msg, type = 'info') {
  el.textContent = msg;
  el.className   = `hint-text hint-${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3500);
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function timeAgo(iso) {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

init();
