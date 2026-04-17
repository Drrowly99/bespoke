import { Router } from 'express';
import { getAuthUrl, exchangeCode, createOAuthClient } from './google.js';
import { createSession, deleteSession, resolveSession } from './session.js';
import { saveTokens } from './tokens.js';
import { depositSession, consumeSession } from './states.js';
import { pollUserNow } from '../jobs/scheduler.js';
import supabase from '../config/supabase.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ── Step 1: Start OAuth flow ──────────────────────────────────────────────────
// The extension always adds ?state=RANDOM_TOKEN so we can deliver the session
// back via polling instead of the broken postMessage/window.opener approach.
router.get('/google', (req, res) => {
  const { state } = req.query;
  res.redirect(getAuthUrl(state || undefined));
});

// ── Step 2: OAuth callback ────────────────────────────────────────────────────
router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) {
    logger.warn('OAuth callback error', { error });
    return res.status(400).send('Authorization denied or failed.');
  }

  try {
    const tokens = await exchangeCode(code);

    const client = createOAuthClient();
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email    = payload.email;

    // Upsert user
    const { data: user, error: upsertErr } = await supabase
      .from('users')
      .upsert({ google_id: googleId, email }, { onConflict: 'google_id' })
      .select('id')
      .single();
    if (upsertErr) throw new Error(upsertErr.message);

    await saveTokens(user.id, tokens);
    const sessionToken = await createSession(user.id);

    // Always re-enable sync on every connect so the user is never stuck in 'idle'.
    // Preserve any existing scan_from_date the user already configured.
    await supabase.from('user_settings').upsert(
      {
        user_id:             user.id,
        icloud_sync_enabled: true,
        sync_status:         'active',
        updated_at:          new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );

    // Seed scan_from_date to 30 days ago only when the row has no date yet.
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    await supabase
      .from('user_settings')
      .update({ scan_from_date: thirtyDaysAgo.toISOString().slice(0, 10) })
      .eq('user_id', user.id)
      .is('scan_from_date', null);

    // Kick off an immediate scan in the background so the user sees results right away
    pollUserNow(user.id).catch((err) =>
      logger.warn('Initial scan error', { userId: user.id, message: err.message })
    );

    logger.info('User authenticated', { googleId, email });

    // Extension flow: state token present — deposit session for service-worker polling.
    if (state) {
      depositSession(state, sessionToken, email);
      return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Connected!</title>
  <style>
    body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0}
    .card{text-align:center;padding:40px 32px;background:#1e293b;border-radius:16px;max-width:340px}
    h1{font-size:20px;font-weight:700;margin-bottom:8px}
    p{font-size:13px;color:#94a3b8;line-height:1.5}
    .dot{display:inline-block;width:8px;height:8px;background:#22c55e;border-radius:50%;margin-right:6px}
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:48px;margin-bottom:16px">✅</div>
    <h1>Connected!</h1>
    <p><span class="dot"></span>Signed in as <strong>${email}</strong></p>
    <p style="margin-top:12px">You can close this tab — the extension is now active.</p>
  </div>
</body>
</html>`);
    }

    // Web app flow: redirect back to the frontend with the session token in the query string.
    // The frontend JS reads ?token=... on load, stores it in localStorage, then clears the URL.
    const redirectUrl = new URL('/', `http://localhost:${process.env.PORT || 4000}`);
    redirectUrl.searchParams.set('token', sessionToken);
    redirectUrl.searchParams.set('email', email);
    res.redirect(redirectUrl.toString());
  } catch (err) {
    logger.error('OAuth callback failed', { message: err.message });
    res.status(500).send('Authentication failed. Please try again.');
  }
});

// ── Step 3: Extension polls this until session is ready ───────────────────────
// Called every 2 s by the service worker after opening the OAuth tab.
// Returns 200 + { sessionToken, email } once ready, or 202 (not yet), or 410 (expired/invalid).
router.get('/poll-session', (req, res) => {
  const { state } = req.query;
  if (!state) return res.status(400).json({ error: 'state required' });

  const result = consumeSession(state);
  if (result) {
    return res.json({ ready: true, sessionToken: result.sessionToken, email: result.email });
  }
  res.status(202).json({ ready: false });
});

// ── Disconnect ────────────────────────────────────────────────────────────────
router.post('/disconnect', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) return res.status(401).json({ error: 'No session' });

  const userId = await resolveSession(sessionToken);
  if (!userId) return res.status(401).json({ error: 'Invalid session' });

  await supabase.from('user_credentials').delete().eq('user_id', userId);
  await deleteSession(sessionToken);

  logger.info('User disconnected', { userId });
  res.json({ ok: true });
});

// ── Session check ─────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  const userId = await resolveSession(sessionToken);
  if (!userId) return res.status(401).json({ error: 'Unauthenticated' });

  const { data: user } = await supabase
    .from('users')
    .select('email, connected_at, last_sync')
    .eq('id', userId)
    .single();

  res.json({ userId, email: user?.email, connectedAt: user?.connected_at, lastSync: user?.last_sync });
});

export default router;
