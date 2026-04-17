/**
 * iCloud Backup — Web Dashboard
 * All API calls go to the same origin (/api/..., /auth/...) via fetch().
 * Session token is stored in localStorage under 'sessionToken'.
 */

const POLL_MS      = 3000;
const SESSION_KEY  = 'sessionToken';
const EMAIL_KEY    = 'userEmail';

// ── State ─────────────────────────────────────────────────────────────────────
let pollTimer = null;
let histPage  = 0;
let histTotal = 0;
let shareEmails = [];
let linkQueue   = [];  // [{ url, albumName, status:'pending'|'uploading'|'done'|'error', error? }]

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const els = {
  // Sidebar
  sbEmail:      $('sb-email'),
  sbStatusDot:  $('sb-status-dot'),
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
      clearSession();
      location.href = '/';
      return null;
    }

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      // Surface the real error so callers can show it
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
  // Pick up session token from OAuth redirect: ?token=...&email=...
  const params = new URLSearchParams(location.search);
  if (params.has('token')) {
    localStorage.setItem(SESSION_KEY, params.get('token'));
    if (params.has('email')) localStorage.setItem(EMAIL_KEY, params.get('email'));
    history.replaceState(null, '', '/');
  }

  if (!localStorage.getItem(SESSION_KEY)) {
    showOverlay();
    return;
  }

  // Validate session against /auth/me
  const me = await apiFetch('/auth/me');
  if (!me || me.error) {
    clearSession();
    showOverlay();
    return;
  }

  els.sbEmail.textContent = me.email || localStorage.getItem(EMAIL_KEY) || '—';

  const status = await apiFetch('/api/status');
  if (status) renderSyncCard(status);

  startPolling();
  loadShareEmails();
  loadAlbumSettings();
}

function showOverlay() {
  els.overlayDisconnected.classList.remove('hidden');
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
  await apiFetch('/api/sync/run-now', { method: 'POST' });
  setTimeout(() => {
    els.btnSyncNow.disabled = false;
    els.btnSyncNow.innerHTML = SYNC_NOW_HTML;
    refreshActivity();
  }, 800);
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
  }

  if (!p.recentItems?.length) {
    els.activityList.innerHTML = `<div class="empty-state">No emails processed yet.<br>Enable sync and click "Sync Now" to start.</div>`;
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

  const urls = raw.split(/[\n\r\s]+/).map(u => u.trim()).filter(u => u.includes('icloud.com'));
  if (!urls.length) { showHint(els.addLinkHint, 'No valid iCloud links found', 'error'); return; }

  const dupes = [];
  for (const url of urls) {
    if (linkQueue.find(q => q.url === url)) { dupes.push(url); continue; }
    linkQueue.push({ url, albumName: urls.length === 1 ? album : null, status: 'pending' });
  }

  els.inputLinkUrl.value   = '';
  els.inputLinkAlbum.value = '';

  const added = urls.length - dupes.length;
  if (dupes.length) {
    showHint(els.addLinkHint, `Added ${added} link(s). ${dupes.length} already in queue.`, 'info');
  } else {
    showHint(els.addLinkHint, `${added} link(s) added to queue`, 'ok');
  }
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
        body: { icloudUrl: item.url, albumName: item.albumName },
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
  updateAlbumPreview();
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

els.inputAlbumPattern.addEventListener('input', updateAlbumPreview);
els.selectAlbumDateSource.addEventListener('change', updateAlbumPreview);

els.btnSaveAlbumSettings.addEventListener('click', async () => {
  els.btnSaveAlbumSettings.disabled = true;
  const result = await apiFetch('/api/settings/album', {
    method: 'POST',
    body: {
      albumDateSource:  els.selectAlbumDateSource.value,
      albumNamePattern: els.inputAlbumPattern.value.trim() || 'Auto Backup - {date} - {location}',
    },
  });
  els.btnSaveAlbumSettings.disabled = false;
  showHint(els.albumSettingsHint, result?.ok ? 'Saved' : 'Save failed', result?.ok ? 'ok' : 'error');
  if (result?.ok) updateAlbumPreview();
});

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
els.sbReconnect.addEventListener('click', () => { location.href = '/auth/google'; });

els.sbDisconnect.addEventListener('click', async () => {
  if (!confirm('Disconnect your Gmail account and sign out?')) return;
  const token = localStorage.getItem(SESSION_KEY);
  if (token) {
    await fetch('/auth/disconnect', {
      method: 'POST',
      headers: { 'X-Session-Token': token, 'Content-Type': 'application/json' },
    });
  }
  clearSession();
  location.reload();
});

// ── Shared item renderer ──────────────────────────────────────────────────────
// Heroicons outline — each wrapped in a coloured icon shell
const STATUS_ICONS = {
  // check-circle
  completed: `<span class="item-icon-wrap icon-completed">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg></span>`,
  // x-circle
  failed: `<span class="item-icon-wrap icon-failed">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg></span>`,
  // minus-circle
  skipped: `<span class="item-icon-wrap icon-skipped">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg></span>`,
  // clock (pending)
  pending: `<span class="item-icon-wrap icon-pending">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg></span>`,
  // arrow-path (processing — animated)
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
