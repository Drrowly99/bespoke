import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { resolveSession } from '../auth/session.js';
import { pollUserNow } from '../jobs/scheduler.js';
import { processDirectLink } from '../jobs/pipeline.js';
import { getState } from '../jobs/sync-state.js';
import supabase from '../config/supabase.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.get('/accounts', async (_req, res) => {
  const [usersResult, settingsResult, sessionsResult] = await Promise.all([
    supabase.from('users').select('id, email, connected_at, last_sync, is_locked').order('connected_at', { ascending: false }),
    supabase.from('user_settings').select('user_id, icloud_sync_enabled, sync_status'),
    supabase.from('sessions').select('user_id, token, expires_at, created_at').order('created_at', { ascending: false }),
  ]);

  const { data: users, error: usersError } = usersResult;
  const { data: settings, error: settingsError } = settingsResult;
  const { data: sessions, error: sessionsError } = sessionsResult;
  if (usersError || settingsError || sessionsError) {
    return res.status(500).json({ error: (usersError || settingsError || sessionsError).message });
  }

  const settingsByUserId = new Map((settings || []).map((row) => [row.user_id, row]));
  const sessionByUserId = new Map();
  const now = new Date();
  for (const row of sessions || []) {
    if (sessionByUserId.has(row.user_id)) continue;
    if (!row.expires_at || new Date(row.expires_at) < now) continue;
    sessionByUserId.set(row.user_id, row);
  }

  res.json({
    accounts: (users || []).map((user) => {
      const setting = settingsByUserId.get(user.id) || null;
      const session = sessionByUserId.get(user.id) || null;
      return {
        id: user.id,
        email: user.email,
        connectedAt: user.connected_at,
        lastSync: user.last_sync,
        isLocked: user.is_locked,
        syncEnabled: setting?.icloud_sync_enabled ?? false,
        syncStatus: setting?.sync_status ?? 'idle',
        sessionToken: session?.token ?? null,
        sessionExpiresAt: session?.expires_at ?? null,
      };
    }),
  });
});

// All API routes require authentication — except /logs/export which supports
// a ?_t= query-param token so Chrome can open it as a direct tab download.
router.use((req, res, next) => {
  // Allow ?_t= as an alternative to X-Session-Token for the export endpoint
  if (req.path === '/logs/export' && req.query._t) {
    req.headers['x-session-token'] = req.query._t;
  }
  next();
});
router.use(requireAuth);

// ── GET /api/status ───────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  const [{ data: settings }, { data: user }] = await Promise.all([
    supabase.from('user_settings')
      .select('icloud_sync_enabled, sync_status, scan_from_date, scan_to_date, updated_at')
      .eq('user_id', req.userId).single(),
    supabase.from('users')
      .select('email, last_sync')
      .eq('id', req.userId).single(),
  ]);

  res.json({
    syncEnabled:  settings?.icloud_sync_enabled ?? false,
    syncStatus:   settings?.sync_status ?? 'idle',
    scanFromDate: settings?.scan_from_date ?? null,
    scanToDate:   settings?.scan_to_date ?? null,
    lastSync:     user?.last_sync ?? null,
    email:        user?.email ?? null,
  });
});

// ── POST /api/sync/toggle ─────────────────────────────────────────────────────
router.post('/sync/toggle', async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });

  const { error } = await supabase.from('user_settings').upsert(
    {
      user_id: req.userId,
      icloud_sync_enabled: enabled,
      sync_status: enabled ? 'active' : 'paused',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) return res.status(500).json({ error: error.message });
  logger.info('Sync toggled', { userId: req.userId, enabled });

  res.json({ ok: true, syncEnabled: enabled });
});

// ── POST /api/sync/run-now ────────────────────────────────────────────────────
// Triggers an immediate poll for the current user without waiting for the scheduler.
// Returns instantly — the poll runs in the background.
router.post('/sync/run-now', async (req, res) => {
  const { data: settings, error } = await supabase
    .from('user_settings')
    .select('scan_from_date, scan_to_date')
    .eq('user_id', req.userId)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!settings?.scan_from_date) {
    return res.status(400).json({ error: 'startDate is required before running sync' });
  }

  const state = getState(req.userId);
  if (state.running) {
    return res.json({ ok: true, alreadyRunning: true });
  }

  pollUserNow(req.userId).catch((err) =>
    logger.error('run-now error', { userId: req.userId, message: err.message })
  );

  res.json({ ok: true, started: true, scanFromDate: settings.scan_from_date, scanToDate: settings.scan_to_date || todayISO() });
});

// ── POST /api/sync/process-link ───────────────────────────────────────────────
// Manually trigger the full pipeline for a single iCloud share URL.
// Body: { icloudUrl: "https://share.icloud.com/photos/..." }
// Returns immediately — processing runs in the background.
router.post('/sync/process-link', async (req, res) => {
  const { icloudUrl, icloudUrls, albumName } = req.body;
  const urls = Array.isArray(icloudUrls) ? icloudUrls : [icloudUrl];
  const validUrls = [...new Set(urls.map(u => typeof u === 'string' ? u.trim() : '').filter(u => u.includes('icloud.com')))];
  if (!validUrls.length) {
    return res.status(400).json({ error: 'icloudUrl or icloudUrls is required' });
  }

  logger.info('Manual link trigger', { userId: req.userId, count: validUrls.length, albumName });
  processDirectLink(req.userId, validUrls.length === 1 ? validUrls[0] : validUrls, { albumName: albumName?.trim() || null }).catch((err) =>
    logger.error('process-link error', { userId: req.userId, message: err.message })
  );

  res.json({ ok: true, icloudUrls: validUrls, message: 'Processing started — check /api/sync/progress' });
});

// ── GET /api/sync/progress ────────────────────────────────────────────────────
// Returns real-time sync state + last 10 processed emails for the activity feed.
router.get('/sync/progress', async (req, res) => {
  const syncState = getState(req.userId);

  const { data: recentItems } = await supabase
    .from('processed_emails')
    .select('id, sender, subject, caption, property_label, google_album_url, status, error_reason, received_at, created_at, total_links, link_index, total_assets, uploaded_assets')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .limit(15);

  res.json({
    running:       syncState.running,
    phase:         syncState.phase,
    currentItem:   syncState.currentItem,
    found:         syncState.found,
    done:          syncState.done,
    lastRunAt:     syncState.lastRunAt,
    lastRunFound:  syncState.lastRunFound,
    lastRunDone:   syncState.lastRunDone,
    recentItems:   recentItems || [],
  });
});

// ── GET /api/settings/scan-date ───────────────────────────────────────────────
router.get('/settings/scan-date', async (req, res) => {
  const { data } = await supabase
    .from('user_settings')
    .select('scan_from_date, scan_to_date')
    .eq('user_id', req.userId)
    .single();
  res.json({
    scanFromDate: data?.scan_from_date ?? null,
    scanToDate:   data?.scan_to_date   ?? null,
  });
});

// ── POST /api/settings/scan-date ─────────────────────────────────────────────
// Body: { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD" | null }
// endDate null = no upper limit (continuous scanning going forward)
// Setting startDate always resets last_message_id so the poll replays from there.
router.post('/settings/scan-date', async (req, res) => {
  const { startDate, endDate = null } = req.body;

  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!startDate || !ISO_RE.test(startDate)) {
    return res.status(400).json({ error: 'startDate is required and must be YYYY-MM-DD' });
  }
  if (endDate !== null && !ISO_RE.test(endDate)) {
    return res.status(400).json({ error: 'endDate must be YYYY-MM-DD or null' });
  }
  if (endDate && new Date(endDate) < new Date(startDate)) {
    return res.status(400).json({ error: 'endDate must be on or after startDate' });
  }

  const effectiveEndDate = endDate || new Date().toISOString().slice(0, 10);

  const updates = {
    user_id:        req.userId,
    scan_from_date: startDate,
    scan_to_date:   effectiveEndDate,
    updated_at:     new Date().toISOString(),
  };

  const [settingsErr, usersErr] = await Promise.all([
    supabase.from('user_settings').upsert(updates, { onConflict: 'user_id' }).then((r) => r.error),
    // Reset pointer so the next poll covers the full [startDate, endDate] window
    supabase.from('users').update({ last_message_id: null }).eq('id', req.userId).then((r) => r.error),
  ]);

  if (settingsErr || usersErr) {
    return res.status(500).json({ error: (settingsErr || usersErr).message });
  }
  logger.info('Scan window updated', { userId: req.userId, startDate, endDate });
  res.json({ ok: true, scanFromDate: startDate, scanToDate: effectiveEndDate });
});

// ── GET /api/settings/share-emails ───────────────────────────────────────────
router.get('/settings/share-emails', async (req, res) => {
  const { data } = await supabase
    .from('user_settings')
    .select('share_emails')
    .eq('user_id', req.userId)
    .single();
  res.json({ shareEmails: data?.share_emails || [] });
});

// ── POST /api/settings/share-emails ──────────────────────────────────────────
// Body: { emails: ["a@b.com", "c@d.com"] }
router.post('/settings/share-emails', async (req, res) => {
  const { emails } = req.body;
  if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails must be an array' });

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const valid = emails.map(e => e.trim().toLowerCase()).filter(e => EMAIL_RE.test(e));

  const { error } = await supabase
    .from('user_settings')
    .upsert({ user_id: req.userId, share_emails: valid, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });

  if (error) return res.status(500).json({ error: error.message });
  logger.info('Share emails updated', { userId: req.userId, count: valid.length });
  res.json({ ok: true, shareEmails: valid });
});

// ── GET /api/settings/album ───────────────────────────────────────────────────
router.get('/settings/album', async (req, res) => {
  const { data } = await supabase
    .from('user_settings')
    .select('album_date_source, album_name_pattern')
    .eq('user_id', req.userId)
    .single();
  res.json({
    albumDateSource:  data?.album_date_source  || 'received',
    albumNamePattern: data?.album_name_pattern || 'Auto Backup - {date} - {location}',
  });
});

// ── POST /api/settings/album ──────────────────────────────────────────────────
// Body: { albumDateSource: 'received'|'exif', albumNamePattern: '{date} - {location}' }
router.post('/settings/album', async (req, res) => {
  const { albumDateSource, albumNamePattern } = req.body;
  if (albumDateSource && !['received', 'exif'].includes(albumDateSource)) {
    return res.status(400).json({ error: 'albumDateSource must be "received" or "exif"' });
  }
  if (albumNamePattern !== undefined && typeof albumNamePattern !== 'string') {
    return res.status(400).json({ error: 'albumNamePattern must be a string' });
  }
  const updates = { user_id: req.userId, updated_at: new Date().toISOString() };
  if (albumDateSource)  updates.album_date_source  = albumDateSource;
  if (albumNamePattern !== undefined) updates.album_name_pattern = albumNamePattern || 'Auto Backup - {date} - {location}';

  const { error } = await supabase
    .from('user_settings')
    .upsert(updates, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, albumDateSource: updates.album_date_source, albumNamePattern: updates.album_name_pattern });
});

// ── GET /api/logs ─────────────────────────────────────────────────────────────
router.get('/logs', async (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page  || '0', 10));
  const limit = Math.min(50, parseInt(req.query.limit || '20', 10));

  const { data, error, count } = await supabase
    .from('processed_emails')
    .select(
      'id, sender, subject, caption, property_label, icloud_url, google_album_url, geolocation, status, error_reason, received_at, created_at, total_assets, uploaded_assets',
      { count: 'exact' }
    )
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .range(page * limit, (page + 1) * limit - 1);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ items: data, total: count, page, limit });
});

// ── GET /api/logs/export (CSV) ────────────────────────────────────────────────
// Auth via X-Session-Token header OR ?_t= query param (for direct-tab download)
router.get('/logs/export', async (req, res) => {
  const { data, error } = await supabase
    .from('processed_emails')
    .select('sender, subject, caption, property_label, icloud_url, google_album_url, geolocation, status, received_at, created_at')
    .eq('user_id', req.userId)
    .eq('export_ready', true)
    .order('received_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const cols = [
    'Sender',
    'Subject',
    'Caption / Note',
    'Property / Location',
    'Latitude',
    'Longitude',
    'iCloud Share URL',
    'Google Photos Album',
    'Status',
    'Email Received',
    'Processed At',
  ];

  const rows = (data || []).map((r) => [
    csvCell(r.sender),
    csvCell(r.subject),
    csvCell(r.caption),
    csvCell(r.property_label || r.geolocation?.address),
    csvCell(r.geolocation?.latitude),
    csvCell(r.geolocation?.longitude),
    csvCell(r.icloud_url),
    csvCell(r.google_album_url),
    csvCell(r.status),
    csvCell(r.received_at),
    csvCell(r.created_at),
  ]);

  const csv = [cols.join(','), ...rows.map((r) => r.join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="icloud-backup-logs.csv"');
  // BOM so Excel auto-detects UTF-8
  res.send('\uFEFF' + csv);
});

function csvCell(val) {
  if (val == null) return '';
  return `"${String(val).replace(/"/g, '""')}"`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default router;
