/**
 * Dashboard — full-page extension UI.
 * Communicates with the background service worker via chrome.runtime.sendMessage.
 */

const POLL_MS = 3000;
const SAMPLE_SHARE_TOKEN = '027hSDCde-ExfSzGaGDm08kPQ';

// ── State ─────────────────────────────────────────────────────────────────────
let pollTimer = null;
let histPage = 0;
let histTotal = 0;
let shareEmails = [];
let linkQueue = [];   // [{ url, albumName, status: 'pending'|'uploading'|'done'|'error', error? }]

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const els = {
  sbEmail: $('sb-email'),
  sbStatusDot: $('sb-status-dot'),
  sbReconnect: $('sb-reconnect'),
  sbDisconnect: $('sb-disconnect'),
  syncToggle: $('toggle-sync'),
  syncMeta: $('sync-meta'),
  syncStatusDot: $('sync-status-dot'),
  syncStatusText: $('sync-status-text'),
  btnSyncNow: $('btn-sync-now'),
  inputScanFrom: $('input-scan-from'),
  inputScanTo: $('input-scan-to'),
  btnSetDate: $('btn-set-date'),
  scanDateHint: $('scan-date-hint'),
  activityRunning: $('activity-running'),
  activityRunningTxt: $('activity-running-text'),
  activityList: $('activity-list'),
  // Back up
  inputLinkUrl: $('input-link-url'),
  inputLinkAlbum: $('input-link-album'),
  btnAddLink: $('btn-add-link'),
  addLinkHint: $('add-link-hint'),
  queueList: $('queue-list'),
  queueCount: $('queue-count'),
  btnClearQueue: $('btn-clear-queue'),
  btnBackupAll: $('btn-backup-all'),
  // History
  historyList: $('history-list'),
  historyPagination: $('history-pagination'),
  btnHistPrev: $('btn-hist-prev'),
  btnHistNext: $('btn-hist-next'),
  histPageLabel: $('hist-page-label'),
  btnExport: $('btn-export'),
  // Settings — album naming
  selectAlbumDateSource: $('select-album-date-source'),
  inputAlbumPattern: $('input-album-pattern'),
  inputIncludeShareToken: $('input-include-share-token'),
  selectShareTokenPosition: $('select-share-token-position'),
  btnSaveAlbumSettings: $('btn-save-album-settings'),
  albumSettingsHint: $('album-settings-hint'),
  albumNamePreview: $('album-name-preview'),
  // Settings — share emails
  shareEmailsList: $('share-emails-list'),
  inputShareEmail: $('input-share-email'),
  btnAddEmail: $('btn-add-email'),
  shareEmailHint: $('share-email-hint'),
  // Connect overlay
  overlayDisconnected: $('overlay-disconnected'),
  overlayEmailHint: $('overlay-email-hint'),
  btnConnect: $('btn-connect'),
  connectWaiting: $('connect-waiting'),
};

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const session = await sw('GET_SESSION');
  if (!session?.sessionToken) {
    const { email: chromeEmail } = await sw('GET_CHROME_EMAIL');
    if (chromeEmail) {
      els.overlayEmailHint.textContent = `Detected Chrome account: ${chromeEmail}`;
    }
    els.overlayDisconnected.classList.remove('hidden');
    return;
  }

  const status = await sw('GET_STATUS');
  if (!status || status.locked) { return; }

  els.sbEmail.textContent = session.email || status.email || '—';
  renderSyncCard(status);
  startPolling();
  loadShareEmails();
  loadAlbumSettings();
}

// ── Section navigation ────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.section;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.section').forEach(s => s.classList.toggle('hidden', s.id !== `section-${id}`));
    if (id === 'history') { histPage = 0; loadHistory(); }
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
  els.inputScanFrom.max = today;
  els.inputScanTo.value = status?.scanToDate || '';
  els.inputScanTo.max = today;
  updateScanHint(status?.scanFromDate || today, status?.scanToDate || null);
}

function updateStatusBadge(s) {
  const labels = {
    active: '✅ Running in background', paused: '⏸ Paused',
    token_error: '⚠️ Reconnect Required', idle: '✅ Active',
    processing: '🔄 Scanning now…',
  };
  const dotClass = s === 'idle' ? 'active' : s;
  els.syncStatusDot.className = `status-dot ${dotClass}`;
  els.sbStatusDot.className = `status-dot ${dotClass}`;
  els.syncStatusText.textContent = labels[s] || '✅ Active';
}

function updateScanHint(from, to) {
  els.scanDateHint.textContent = !to
    ? (from === todayISO() ? 'Scanning from today onwards.' : `Scanning from ${from} → ongoing.`)
    : `Scanning ${from} - ${to}.`;
}

els.syncToggle.addEventListener('change', async () => {
  const enabled = els.syncToggle.checked;
  els.syncToggle.disabled = true;
  const result = await sw('TOGGLE_SYNC', { enabled });
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
  await sw('RUN_NOW');
  setTimeout(() => {
    els.btnSyncNow.disabled = false;
    els.btnSyncNow.textContent = 'Sync Now';
    refreshActivity();
  }, 800);
});

els.btnSetDate.addEventListener('click', async () => {
  const startDate = els.inputScanFrom.value;
  const endDate = els.inputScanTo.value || null;
  if (!startDate) return;
  els.btnSetDate.textContent = '…';
  els.btnSetDate.disabled = true;
  const result = await sw('SET_SCAN_DATE', { startDate, endDate });
  els.btnSetDate.textContent = result?.ok ? 'Saved ✓' : 'Error';
  els.btnSetDate.disabled = false;
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
  const p = await sw('GET_PROGRESS');
  if (!p) return;

  if (p.running) {
    els.activityRunning.classList.remove('hidden');
    els.activityRunningTxt.textContent = p.phase === 'scanning'
      ? 'Scanning Gmail for iCloud links…'
      : p.currentItem ? `Uploading: ${p.currentItem}` : `Found ${p.found} link(s), uploading…`;
    els.btnSyncNow.disabled = true;
    els.btnSyncNow.textContent = 'Running…';
    updateStatusBadge('processing');
    els.syncMeta.textContent = p.currentItem ? `Uploading: ${p.currentItem}` : 'Scanning Gmail…';
  } else {
    els.activityRunning.classList.add('hidden');
    els.btnSyncNow.disabled = false;
    els.btnSyncNow.textContent = 'Sync Now';
    if (p.lastRunAt) {
      const ago = timeAgo(p.lastRunAt);
      els.syncMeta.textContent = p.lastRunFound === 0
        ? `Last scan ${ago} · No new links found`
        : `Last scan ${ago} · ${p.lastRunDone}/${p.lastRunFound} uploaded`;
    }
  }

  if (!p.recentItems?.length) {
    els.activityList.innerHTML = `<div class="empty-state">No emails processed yet. Enable sync and click "Sync Now" to start.</div>`;
    return;
  }
  els.activityList.innerHTML = p.recentItems.map(item => renderItem(item)).join('');
}

// ── Multi-link queue ──────────────────────────────────────────────────────────
els.btnAddLink.addEventListener('click', addLinksToQueue);
els.inputLinkUrl.addEventListener('keydown', e => { if (e.key === 'Enter') addLinksToQueue(); });

function addLinksToQueue() {
  const raw = els.inputLinkUrl.value.trim();
  const album = els.inputLinkAlbum.value.trim() || null;

  if (!raw) { showHint(els.addLinkHint, 'Paste at least one iCloud link', 'error'); return; }

  // Support bulk paste — split on newlines and spaces
  const urls = raw.split(/[\n\r\s]+/).map(u => u.trim()).filter(u => u.includes('icloud.com'));

  if (!urls.length) {
    showHint(els.addLinkHint, 'No valid iCloud links found', 'error');
    return;
  }

  const dupes = [];
  for (const url of urls) {
    if (linkQueue.find(q => q.url === url)) { dupes.push(url); continue; }
    linkQueue.push({ url, albumName: urls.length === 1 ? album : null, status: 'pending' });
  }

  els.inputLinkUrl.value = '';
  els.inputLinkAlbum.value = '';

  if (dupes.length) {
    showHint(els.addLinkHint, `Added ${urls.length - dupes.length} link(s). ${dupes.length} already in queue.`, 'info');
  } else {
    showHint(els.addLinkHint, `${urls.length} link(s) added to queue`, 'ok');
  }

  renderQueue();
}

function renderQueue() {
  els.queueCount.textContent = linkQueue.length;
  els.btnBackupAll.disabled = linkQueue.length === 0 || linkQueue.every(q => q.status !== 'pending');

  if (!linkQueue.length) {
    els.queueList.innerHTML = `<div class="empty-state">No links queued. Add some above.</div>`;
    return;
  }

  els.queueList.innerHTML = linkQueue.map((item, i) => {
    const token = item.url.match(/\/photos\/[#/]*([A-Za-z0-9_\-]{6,})/)?.[1] || item.url.slice(-16);
    const albumText = item.albumName ? `<span class="queue-item-album">${esc(item.albumName)}</span>` : `<span class="queue-item-album" style="color:#cbd5e1">auto-named</span>`;
    const statusHtml = {
      pending: `<span class="queue-item-status">—</span>`,
      uploading: `<span class="queue-item-status queue-processing"><span class="mini-spinner"></span> Uploading…</span>`,
      done: `<span class="queue-item-status queue-done">✅ Done</span>`,
      error: `<span class="queue-item-status queue-error" title="${esc(item.error || '')}">❌ Failed</span>`,
    }[item.status] || '';

    const removeBtn = item.status === 'pending'
      ? `<button class="link-btn danger" data-remove="${i}" title="Remove">✕</button>`
      : '';

    return `<div class="queue-item">
      <span class="queue-item-num">${i + 1}</span>
      <span class="queue-item-url" title="${esc(item.url)}">…${token}</span>
      ${albumText}
      ${statusHtml}
      ${removeBtn}
    </div>`;
  }).join('');

  // Wire remove buttons
  els.queueList.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      linkQueue.splice(parseInt(btn.dataset.remove), 1);
      renderQueue();
    });
  });
}

els.btnClearQueue.addEventListener('click', () => {
  linkQueue = linkQueue.filter(q => q.status === 'uploading'); // keep in-flight
  renderQueue();
});

els.btnBackupAll.addEventListener('click', async () => {
  els.btnBackupAll.disabled = true;
  const pending = linkQueue.filter(q => q.status === 'pending');

  for (const item of pending) {
    item.status = 'uploading';
    renderQueue();

    const result = await sw('PROCESS_LINK', { icloudUrl: item.url, albumName: item.albumName });

    if (!result) {
      item.status = 'error';
      item.error = 'Extension not responding';
    } else if (result.reason === 'already_processed') {
      item.status = 'done';
    } else if (result.ok) {
      item.status = 'done';
    } else {
      item.status = 'error';
      item.error = result.error || 'Unknown error';
    }
    renderQueue();
  }

  setTimeout(refreshActivity, 800);
  els.btnBackupAll.disabled = false;
});

// ── History ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  els.historyList.innerHTML = `<div class="empty-state">Loading…</div>`;
  const data = await sw('GET_HISTORY', { page: histPage });
  if (!data) { els.historyList.innerHTML = `<div class="empty-state">Could not load history.</div>`; return; }

  histTotal = data.total || 0;
  if (!data.items?.length) {
    els.historyList.innerHTML = `<div class="empty-state">No history yet.</div>`;
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
els.btnExport.addEventListener('click', async () => {
  const result = await sw('EXPORT_LOGS');
  if (result?.url && result?.sessionToken) {
    chrome.tabs.create({ url: `${result.url}?_t=${encodeURIComponent(result.sessionToken)}` });
  }
});

// ── Settings — album naming ───────────────────────────────────────────────────
async function loadAlbumSettings() {
  const data = await sw('GET_ALBUM_SETTINGS');
  if (!data) return;
  els.selectAlbumDateSource.value = data.albumDateSource || 'received';
  els.inputAlbumPattern.value = data.albumNamePattern || 'Auto Backup - {date} - {location}';
  els.inputIncludeShareToken.checked = !!data.includeShareToken;
  els.selectShareTokenPosition.value = data.shareTokenPosition || 'suffix';
  refreshAlbumPreview();
}

function updateAlbumPreview() {
  const pattern = els.inputAlbumPattern.value || 'Auto Backup - {date} - {location}';
  const dateSource = els.selectAlbumDateSource.value;
  const exampleDate = dateSource === 'exif' ? '2024-07-15' : todayISO();
  const preview = pattern
    .replace('{date}', exampleDate)
    .replace('{location}', 'London, England')
    .replace(/[\s\-–|,]+$/, '').trim();
  els.albumNamePreview.textContent = preview || 'Auto Backup - ' + exampleDate;
}

els.inputAlbumPattern.addEventListener('input', refreshAlbumPreview);
els.selectAlbumDateSource.addEventListener('change', refreshAlbumPreview);

els.btnSaveAlbumSettings.addEventListener('click', async () => {
  els.btnSaveAlbumSettings.disabled = true;
  const result = await sw('SET_ALBUM_SETTINGS', {
    albumDateSource: els.selectAlbumDateSource.value,
    albumNamePattern: els.inputAlbumPattern.value.trim() || 'Auto Backup - {date} - {location}',
    includeShareToken: els.inputIncludeShareToken.checked,
    shareTokenPosition: els.selectShareTokenPosition.value,
  });
  els.btnSaveAlbumSettings.disabled = false;
  if (result?.ok) {
    showHint(els.albumSettingsHint, 'Saved', 'ok');
    refreshAlbumPreview();
  } else {
    showHint(els.albumSettingsHint, 'Save failed', 'error');
  }
});

// ── Settings — share emails ───────────────────────────────────────────────────
function updateShareTokenControls() {
  els.selectShareTokenPosition.disabled = !els.inputIncludeShareToken.checked;
}

function refreshAlbumPreview() {
  const pattern = els.inputAlbumPattern.value || 'Auto Backup - {date} - {location}';
  const dateSource = els.selectAlbumDateSource.value;
  const exampleDate = dateSource === 'exif' ? '2024-07-15' : todayISO();
  const includeToken = els.inputIncludeShareToken.checked;
  const tokenPattern = pattern.includes('{icloudToken}');
  const preview = pattern
    .replace(/\{date\}/g, exampleDate)
    .replace(/\{location\}/g, 'London, England')
    .replace(/\{icloudToken\}/g, includeToken ? SAMPLE_SHARE_TOKEN : '');
  const arranged = includeToken && SAMPLE_SHARE_TOKEN && !tokenPattern
    ? (els.selectShareTokenPosition.value === 'prefix' ? `${SAMPLE_SHARE_TOKEN} - ${preview}` : `${preview} - ${SAMPLE_SHARE_TOKEN}`)
    : preview;
  els.albumNamePreview.textContent = arranged.replace(/[\s\-–|,]+$/, '').replace(/\s{2,}/g, ' ').trim() || 'Auto Backup - ' + exampleDate;
  updateShareTokenControls();
}

els.inputAlbumPattern.addEventListener('input', refreshAlbumPreview);
els.selectAlbumDateSource.addEventListener('change', refreshAlbumPreview);
els.inputIncludeShareToken.addEventListener('change', refreshAlbumPreview);
els.selectShareTokenPosition.addEventListener('change', refreshAlbumPreview);

async function loadShareEmails() {
  const data = await sw('GET_SHARE_EMAILS');
  shareEmails = data?.shareEmails || [];
  renderShareEmails();
}

function renderShareEmails() {
  if (!shareEmails.length) {
    els.shareEmailsList.innerHTML = `<p class="hint-text">No recipients yet.</p>`;
    return;
  }
  els.shareEmailsList.innerHTML = shareEmails.map((email, i) =>
    `<div class="share-email-row">
      <span class="share-email-addr">${esc(email)}</span>
      <button class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:11px" data-idx="${i}">Remove</button>
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
  const result = await sw('SET_SHARE_EMAILS', { emails: shareEmails });
  if (result?.ok) {
    shareEmails = result.shareEmails;
    renderShareEmails();
    showHint(els.shareEmailHint, 'Saved', 'ok');
  } else {
    showHint(els.shareEmailHint, 'Save failed', 'error');
  }
}

els.btnAddEmail.addEventListener('click', async () => {
  const email = els.inputShareEmail.value.trim().toLowerCase();
  if (!email || !email.includes('@')) { showHint(els.shareEmailHint, 'Enter a valid email', 'error'); return; }
  if (shareEmails.includes(email)) { showHint(els.shareEmailHint, 'Already in list', 'info'); return; }
  shareEmails.push(email);
  els.inputShareEmail.value = '';
  await saveShareEmails();
});
els.inputShareEmail.addEventListener('keydown', e => { if (e.key === 'Enter') els.btnAddEmail.click(); });

// ── Account actions ───────────────────────────────────────────────────────────
els.sbReconnect.addEventListener('click', async () => {
  els.sbReconnect.textContent = 'Opening…';
  const result = await sw('CONNECT');
  if (result?.ok) location.reload();
  else els.sbReconnect.textContent = 'Reconnect';
});

els.sbDisconnect.addEventListener('click', async () => {
  if (!confirm('Disconnect your Gmail account?')) return;
  await sw('LOGOUT');
  location.reload();
});

// ── Connect overlay ───────────────────────────────────────────────────────────
els.btnConnect.addEventListener('click', async () => {
  els.btnConnect.disabled = true;
  els.btnConnect.textContent = 'Opening Google sign-in…';
  els.connectWaiting.classList.remove('hidden');
  const result = await sw('CONNECT');
  els.connectWaiting.classList.add('hidden');
  if (result?.ok) location.reload();
  else { els.btnConnect.disabled = false; els.btnConnect.textContent = 'Connect Gmail'; }
});

// ── Shared item renderer ──────────────────────────────────────────────────────
function renderItem(item, showDetails = false) {
  const icon = { completed: '✅', failed: '❌', skipped: '⏭', processing: '⏳', pending: '🕐' }[item.status] || '⏳';
  const isLoading = item.status === 'processing' || item.status === 'pending';
  const sender = (item.sender || '').replace(/<.*>/, '').trim().slice(0, 35);
  const subject = (item.subject || '(no subject)').slice(0, 55);
  const location = item.property_label || item.caption || '';
  const albumLink = item.google_album_url
    ? `<a href="${item.google_album_url}" target="_blank" class="album-link">Open Album ↗</a>`
    : '';
  const errorHint = item.status === 'failed' && item.error_reason
    ? `<div class="item-error">${esc(item.error_reason.slice(0, 100))}</div>` : '';
  const assetCount = showDetails && item.total_assets
    ? `<span class="item-dot">·</span><span class="item-assets">${item.uploaded_assets ?? 0}/${item.total_assets} files</span>` : '';
  const badge = showDetails
    ? `<span class="status-badge status-${item.status}">${item.status}</span>` : '';

  return `<div class="list-item">
    <div class="item-icon">${isLoading ? '<span class="mini-spinner"></span>' : icon}</div>
    <div class="item-body">
      <div class="item-subject">${esc(subject)}${badge}</div>
      <div class="item-meta">
        ${sender ? `<span class="item-sender">${esc(sender)}</span>` : ''}
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
  el.className = `hint-text hint-${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3500);
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function timeAgo(iso) {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sw(type, payload = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type, ...payload }, res => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(res);
    });
  });
}

init();
