import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import authRoutes from './auth/routes.js';
import apiRoutes from './api/routes.js';
import adminRoutes, { serveAdminDashboard } from './admin/routes.js';
import { validateEnv } from './config/env.js';
import supabase from './config/supabase.js';
import { resumePendingLinks } from './jobs/pipeline.js';

validateEnv();

const __dirname    = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = join(__dirname, '..', '..', 'frontend', 'public');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:') ||
    process.env.NODE_ENV === 'development'
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ── Static frontend ───────────────────────────────────────────────────────────
app.use(express.static(FRONTEND_DIR));

// ── API + auth routes ─────────────────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/api',  apiRoutes);

// Admin dashboard (internal tool, no auth on the page itself)
app.get('/admin', serveAdminDashboard);
app.use('/admin', adminRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/admin')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(join(FRONTEND_DIR, 'index.html'));
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[server error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);

  // On every startup, reset any rows stuck in 'processing' (from a crashed/killed
  // previous run) back to 'pending', then re-queue them for all users.
  try {
    // Reset ALL processing rows immediately — server just started so none are live
    await supabase
      .from('processed_emails')
      .update({ status: 'pending' })
      .eq('status', 'processing');

    // Find every user who has pending work and resume it
    const { data: rows } = await supabase
      .from('processed_emails')
      .select('user_id')
      .eq('status', 'pending');

    const userIds = [...new Set((rows || []).map(r => r.user_id))];
    if (userIds.length) {
      console.log(`[server] Resuming interrupted uploads for ${userIds.length} user(s)…`);
      for (const userId of userIds) {
        resumePendingLinks(userId).catch(err =>
          console.error(`[server] Resume failed for user ${userId}: ${err.message}`)
        );
      }
    }
  } catch (err) {
    console.error('[server] Startup resume error:', err.message);
  }
});

export default app;
