/**
 * Stateless admin token — HMAC-SHA256 signed, no database required.
 *
 * Token format (URL-safe): base64url(payload) + '.' + base64url(hmac)
 * Payload: JSON { exp: epochMs }
 *
 * The admin logs in by submitting ADMIN_SECRET. On success they get a token
 * valid for ADMIN_TOKEN_TTL_HOURS. No other credentials exist for the admin.
 */
import { createHmac, timingSafeEqual } from 'crypto';

const ADMIN_TOKEN_TTL_HOURS = 8;

function secret() {
  return process.env.ADMIN_SECRET;
}

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

function sign(payload) {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function issueAdminToken() {
  const payload = b64url(JSON.stringify({ exp: Date.now() + ADMIN_TOKEN_TTL_HOURS * 3_600_000 }));
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

export function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;

  const payload = token.slice(0, dot);
  const sig     = token.slice(dot + 1);

  // Constant-time comparison to prevent timing attacks
  const expected = sign(payload);
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'base64url'), Buffer.from(expected, 'base64url'))) return false;
  } catch {
    return false;
  }

  const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return Date.now() < exp;
}

export function requireAdminToken(req, res, next) {
  const auth = req.headers['x-admin-token'] || req.cookies?.adminToken;
  if (!verifyAdminToken(auth)) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  next();
}
