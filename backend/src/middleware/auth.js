/**
 * Express middleware — validates X-Session-Token and checks lock status.
 *
 * Returns:
 *  401 { error: 'Unauthenticated' }         — no valid session
 *  403 { error: 'account_locked', code: 'LOCKED' } — user is locked by admin
 */
import { resolveSession } from '../auth/session.js';
import supabase from '../config/supabase.js';

export async function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  console.log(`[requireAuth] ${req.method} ${req.path} | token: ${token ? token.slice(0,8)+'...' : 'NONE'}`);
  const userId = await resolveSession(token);
  console.log(`[requireAuth] → userId: ${userId || 'null (401)'}`);
  if (!userId) return res.status(401).json({ error: 'Unauthenticated' });

  // Check lock status — single lightweight query
  const { data: user } = await supabase
    .from('users')
    .select('is_locked')
    .eq('id', userId)
    .single();

  if (user?.is_locked) {
    return res.status(403).json({ error: 'account_locked', code: 'LOCKED' });
  }

  req.userId = userId;
  next();
}
