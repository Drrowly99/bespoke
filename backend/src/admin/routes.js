import { Router } from 'express';
import supabase from '../config/supabase.js';
import { issueAdminToken, requireAdminToken } from './auth.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ── POST /admin/login ─────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { secret } = req.body;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    logger.warn('Admin login failed', { ip: req.ip });
    return res.status(401).json({ error: 'Invalid admin secret' });
  }
  const token = issueAdminToken();
  logger.info('Admin logged in', { ip: req.ip });
  res.json({ token });
});

// ── All routes below require a valid admin token ──────────────────────────────
router.use(requireAdminToken);

// ── GET /admin/users ──────────────────────────────────────────────────────────
router.get('/users', async (_req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select(`
      id, email, connected_at, last_sync, is_locked, locked_at, locked_reason, locked_by,
      user_settings ( icloud_sync_enabled, sync_status ),
      processed_emails ( count )
    `)
    .order('connected_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const users = (data || []).map((u) => ({
    id:           u.id,
    email:        u.email,
    connectedAt:  u.connected_at,
    lastSync:     u.last_sync,
    isLocked:     u.is_locked,
    lockedAt:     u.locked_at,
    lockedReason: u.locked_reason,
    lockedBy:     u.locked_by,
    syncEnabled:  u.user_settings?.[0]?.icloud_sync_enabled ?? false,
    syncStatus:   u.user_settings?.[0]?.sync_status ?? 'idle',
    emailsProcessed: u.processed_emails?.length ?? 0,
  }));

  res.json({ users });
});

// ── POST /admin/users/:id/lock ────────────────────────────────────────────────
router.post('/users/:id/lock', async (req, res) => {
  const { id } = req.params;
  const { reason = 'Payment required' } = req.body;

  const { error } = await supabase.from('users').update({
    is_locked:     true,
    locked_at:     new Date().toISOString(),
    locked_reason: reason,
    locked_by:     'admin',
  }).eq('id', id);

  if (error) return res.status(500).json({ error: error.message });

  // Also pause their sync so the scheduler stops immediately
  await supabase.from('user_settings')
    .update({ icloud_sync_enabled: false, sync_status: 'locked' })
    .eq('user_id', id);

  logger.info('User locked by admin', { userId: id, reason });
  res.json({ ok: true });
});

// ── POST /admin/users/:id/unlock ──────────────────────────────────────────────
router.post('/users/:id/unlock', async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase.from('users').update({
    is_locked:     false,
    locked_at:     null,
    locked_reason: null,
    locked_by:     null,
  }).eq('id', id);

  if (error) return res.status(500).json({ error: error.message });

  // Reset sync_status so they can re-enable sync themselves
  await supabase.from('user_settings')
    .update({ sync_status: 'idle' })
    .eq('user_id', id);

  logger.info('User unlocked by admin', { userId: id });
  res.json({ ok: true });
});

// ── GET /admin (dashboard HTML) ───────────────────────────────────────────────
// This is served BEFORE requireAdminToken so the login page itself is accessible.
// The token check for /admin/users is done by requireAdminToken above.
// The dashboard is a standalone SPA — no framework, no build step.
export function serveAdminDashboard(_req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(ADMIN_HTML);
}

export default router;

// ── Inline admin dashboard ────────────────────────────────────────────────────
const ADMIN_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>iCloud Backup — Admin</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
  a{color:#60a5fa}

  /* ── Layout ── */
  .page{max-width:960px;margin:0 auto;padding:32px 20px}
  header{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;padding-bottom:18px;border-bottom:1px solid #1e293b}
  .logo-row{display:flex;align-items:center;gap:12px}
  .logo-row h1{font-size:18px;font-weight:700;color:#f1f5f9}
  .badge{background:#1e3a5f;color:#60a5fa;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px}
  #btn-logout{background:none;border:1px solid #334155;color:#94a3b8;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px}
  #btn-logout:hover{color:#e2e8f0;border-color:#94a3b8}

  /* ── Login card ── */
  #view-login{display:flex;align-items:center;justify-content:center;min-height:80vh}
  .login-card{background:#1e293b;border:1px solid #2d3e52;border-radius:14px;padding:36px 32px;width:100%;max-width:360px}
  .login-card h2{font-size:18px;font-weight:700;margin-bottom:6px}
  .login-card p{font-size:12px;color:#64748b;margin-bottom:22px}
  .field{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
  label{font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
  input[type=password]{background:#0f172a;border:1px solid #334155;border-radius:7px;color:#e2e8f0;font-size:13px;padding:9px 12px;width:100%}
  input[type=password]:focus{outline:none;border-color:#3b82f6}
  .btn-primary{background:#3b82f6;color:#fff;border:none;border-radius:7px;padding:10px;width:100%;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}
  .btn-primary:hover{opacity:.85}
  .btn-primary:disabled{opacity:.5;cursor:default}
  .error-msg{font-size:12px;color:#f87171;margin-top:8px;display:none}

  /* ── Dashboard ── */
  #view-dashboard{display:none}
  .stats-row{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
  .stat-card{background:#1e293b;border:1px solid #2d3e52;border-radius:10px;padding:16px 20px;flex:1;min-width:140px}
  .stat-val{font-size:26px;font-weight:700;color:#f1f5f9}
  .stat-lbl{font-size:11px;color:#64748b;margin-top:2px}

  /* ── Table ── */
  .table-wrap{background:#1e293b;border:1px solid #2d3e52;border-radius:12px;overflow:hidden}
  .table-header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #2d3e52}
  .table-header h2{font-size:14px;font-weight:600}
  #btn-refresh{background:#1e3a5f;color:#93c5fd;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;padding:10px 16px;font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #2d3e52}
  td{padding:12px 16px;font-size:12px;border-bottom:1px solid #1a2535;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#172033}

  /* ── Status pills ── */
  .pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:10px;font-size:11px;font-weight:600}
  .pill.active  {background:#14532d;color:#4ade80}
  .pill.locked  {background:#450a0a;color:#f87171}
  .pill.idle    {background:#1e2d3d;color:#94a3b8}
  .pill.paused  {background:#1e2d3d;color:#94a3b8}

  /* ── Action buttons ── */
  .btn-lock  {background:#450a0a;color:#f87171;border:1px solid #7f1d1d;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer;transition:opacity .15s}
  .btn-unlock{background:#14532d;color:#4ade80;border:1px solid #166534;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer;transition:opacity .15s}
  .btn-lock:hover,.btn-unlock:hover{opacity:.8}

  /* ── Modal ── */
  .modal-bg{position:fixed;inset:0;background:#00000080;display:flex;align-items:center;justify-content:center;z-index:100;display:none}
  .modal{background:#1e293b;border:1px solid #2d3e52;border-radius:14px;padding:28px;width:100%;max-width:400px}
  .modal h3{font-size:16px;font-weight:700;margin-bottom:6px}
  .modal p{font-size:12px;color:#94a3b8;margin-bottom:18px}
  .modal textarea{width:100%;background:#0f172a;border:1px solid #334155;border-radius:7px;color:#e2e8f0;font-size:12px;padding:8px 10px;height:70px;resize:vertical;margin-bottom:14px}
  .modal textarea:focus{outline:none;border-color:#3b82f6}
  .modal-actions{display:flex;gap:10px;justify-content:flex-end}
  .btn-cancel{background:none;border:1px solid #334155;color:#94a3b8;border-radius:6px;padding:7px 16px;font-size:12px;cursor:pointer}
  .btn-confirm-lock{background:#ef4444;color:#fff;border:none;border-radius:6px;padding:7px 16px;font-size:12px;font-weight:600;cursor:pointer}

  /* ── Loading ── */
  .loading{text-align:center;padding:40px;color:#475569}
  .spinner{display:inline-block;width:20px;height:20px;border:2px solid #334155;border-top-color:#3b82f6;border-radius:50%;animation:spin .7s linear infinite;margin-right:8px;vertical-align:middle}
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<!-- ── Login ── -->
<div id="view-login">
  <div class="login-card">
    <h2>Admin Login</h2>
    <p>Enter your admin secret to manage users.</p>
    <div class="field">
      <label>Admin Secret</label>
      <input type="password" id="input-secret" placeholder="••••••••••••" autocomplete="current-password"/>
    </div>
    <button class="btn-primary" id="btn-login">Sign In</button>
    <p class="error-msg" id="login-error">Incorrect secret. Try again.</p>
  </div>
</div>

<!-- ── Dashboard ── -->
<div id="view-dashboard">
  <div class="page">
    <header>
      <div class="logo-row">
        <h1>iCloud Backup Admin</h1>
        <span class="badge">Admin</span>
      </div>
      <button id="btn-logout">Sign Out</button>
    </header>

    <!-- Stats -->
    <div class="stats-row">
      <div class="stat-card"><div class="stat-val" id="stat-total">—</div><div class="stat-lbl">Total Users</div></div>
      <div class="stat-card"><div class="stat-val" id="stat-active">—</div><div class="stat-lbl">Active Sync</div></div>
      <div class="stat-card"><div class="stat-val" id="stat-locked">—</div><div class="stat-lbl">Locked</div></div>
      <div class="stat-card"><div class="stat-val" id="stat-emails">—</div><div class="stat-lbl">Emails Processed</div></div>
    </div>

    <!-- Users table -->
    <div class="table-wrap">
      <div class="table-header">
        <h2>Users</h2>
        <button id="btn-refresh">↻ Refresh</button>
      </div>
      <div id="table-body">
        <div class="loading"><span class="spinner"></span>Loading users…</div>
      </div>
    </div>
  </div>
</div>

<!-- ── Lock confirmation modal ── -->
<div class="modal-bg" id="modal-bg">
  <div class="modal">
    <h3 id="modal-title">Lock Account</h3>
    <p id="modal-desc">This will immediately stop all syncing for this user.</p>
    <textarea id="modal-reason" placeholder="Reason (shown in admin logs, not to user)…">Payment required</textarea>
    <div class="modal-actions">
      <button class="btn-cancel" id="modal-cancel">Cancel</button>
      <button class="btn-confirm-lock" id="modal-confirm">Lock Account</button>
    </div>
  </div>
</div>

<script>
  const API = '';
  let adminToken = sessionStorage.getItem('adminToken');
  let pendingLockId = null;

  // ── Boot ────────────────────────────────────────────────────────────────────
  if (adminToken) showDashboard();
  else showLogin();

  function showLogin() {
    document.getElementById('view-login').style.display = 'flex';
    document.getElementById('view-dashboard').style.display = 'none';
  }
  function showDashboard() {
    document.getElementById('view-login').style.display = 'none';
    document.getElementById('view-dashboard').style.display = 'block';
    loadUsers();
  }

  // ── Login ───────────────────────────────────────────────────────────────────
  document.getElementById('btn-login').addEventListener('click', login);
  document.getElementById('input-secret').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

  async function login() {
    const secret = document.getElementById('input-secret').value.trim();
    const btn = document.getElementById('btn-login');
    const err = document.getElementById('login-error');
    if (!secret) return;

    btn.disabled = true; btn.textContent = 'Signing in…';
    err.style.display = 'none';

    try {
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      adminToken = data.token;
      sessionStorage.setItem('adminToken', adminToken);
      showDashboard();
    } catch {
      err.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = 'Sign In';
    }
  }

  // ── Logout ──────────────────────────────────────────────────────────────────
  document.getElementById('btn-logout').addEventListener('click', () => {
    adminToken = null;
    sessionStorage.removeItem('adminToken');
    showLogin();
  });

  // ── Load users ──────────────────────────────────────────────────────────────
  document.getElementById('btn-refresh').addEventListener('click', loadUsers);

  async function loadUsers() {
    document.getElementById('table-body').innerHTML = '<div class="loading"><span class="spinner"></span>Loading…</div>';
    try {
      const res = await adminFetch('/admin/users');
      if (!res.ok) { if (res.status === 401) { showLogin(); return; } throw new Error(); }
      const { users } = await res.json();
      renderTable(users);
    } catch {
      document.getElementById('table-body').innerHTML = '<div class="loading">Failed to load users.</div>';
    }
  }

  function renderTable(users) {
    // Stats
    document.getElementById('stat-total').textContent  = users.length;
    document.getElementById('stat-active').textContent = users.filter(u => u.syncEnabled && !u.isLocked).length;
    document.getElementById('stat-locked').textContent = users.filter(u => u.isLocked).length;
    document.getElementById('stat-emails').textContent = users.reduce((s, u) => s + (u.emailsProcessed || 0), 0);

    if (!users.length) {
      document.getElementById('table-body').innerHTML = '<div class="loading">No users yet.</div>';
      return;
    }

    const rows = users.map((u) => {
      const status = u.isLocked ? 'locked' : u.syncEnabled ? 'active' : (u.syncStatus || 'idle');
      const statusLabel = u.isLocked ? 'Locked' : u.syncEnabled ? 'Active' : 'Idle';
      const actionBtn = u.isLocked
        ? \`<button class="btn-unlock" onclick="confirmUnlock('\${u.id}','\${esc(u.email)}')">Unlock</button>\`
        : \`<button class="btn-lock"   onclick="confirmLock('\${u.id}','\${esc(u.email)}')">Lock</button>\`;

      return \`<tr>
        <td>\${esc(u.email)}</td>
        <td>\${u.connectedAt ? new Date(u.connectedAt).toLocaleDateString() : '—'}</td>
        <td>\${u.lastSync ? new Date(u.lastSync).toLocaleString() : 'Never'}</td>
        <td>\${u.emailsProcessed ?? 0}</td>
        <td><span class="pill \${status}">\${statusLabel}</span></td>
        <td>\${u.isLocked ? '<span style="font-size:11px;color:#64748b">' + esc(u.lockedReason||'') + '</span>' : ''}</td>
        <td>\${actionBtn}</td>
      </tr>\`;
    }).join('');

    document.getElementById('table-body').innerHTML = \`
      <table>
        <thead><tr>
          <th>Email</th><th>Connected</th><th>Last Sync</th>
          <th>Processed</th><th>Status</th><th>Lock Reason</th><th>Action</th>
        </tr></thead>
        <tbody>\${rows}</tbody>
      </table>\`;
  }

  // ── Lock / Unlock ───────────────────────────────────────────────────────────
  function confirmLock(id, email) {
    pendingLockId = id;
    document.getElementById('modal-title').textContent = 'Lock Account';
    document.getElementById('modal-desc').textContent  = 'Lock ' + email + '? All syncing stops immediately.';
    document.getElementById('modal-confirm').textContent = 'Lock Account';
    document.getElementById('modal-confirm').onclick    = executeLock;
    document.getElementById('modal-bg').style.display  = 'flex';
  }

  function confirmUnlock(id, email) {
    pendingLockId = id;
    document.getElementById('modal-title').textContent = 'Unlock Account';
    document.getElementById('modal-desc').textContent  = 'Restore access for ' + email + '?';
    document.getElementById('modal-confirm').textContent = 'Unlock Account';
    document.getElementById('modal-confirm').onclick    = executeUnlock;
    document.getElementById('modal-bg').style.display  = 'flex';
  }

  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-bg').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
  function closeModal() { document.getElementById('modal-bg').style.display = 'none'; pendingLockId = null; }

  async function executeLock() {
    if (!pendingLockId) return;
    const reason = document.getElementById('modal-reason').value.trim() || 'Payment required';
    closeModal();
    try {
      const res = await adminFetch('/admin/users/' + pendingLockId + '/lock', {
        method: 'POST', body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error();
      loadUsers();
    } catch { alert('Failed to lock user. Try again.'); }
  }

  async function executeUnlock() {
    if (!pendingLockId) return;
    closeModal();
    try {
      const res = await adminFetch('/admin/users/' + pendingLockId + '/unlock', { method: 'POST' });
      if (!res.ok) throw new Error();
      loadUsers();
    } catch { alert('Failed to unlock user. Try again.'); }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function adminFetch(path, opts = {}) {
    return fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken, ...(opts.headers||{}) },
    });
  }

  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
</script>
</body>
</html>`;
