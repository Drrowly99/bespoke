/**
 * Session management backed by Supabase.
 * Sessions are opaque random tokens stored in the `sessions` table.
 */
import { randomBytes } from 'crypto';
import supabase from '../config/supabase.js';

const SESSION_TTL_DAYS = 3650;

export async function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();

  const { error } = await supabase.from('sessions').insert({
    user_id: userId,
    token,
    expires_at: expiresAt,
  });
  if (error) throw new Error(`Failed to create session: ${error.message}`);
  return token;
}

export async function resolveSession(token) {
  if (!token) return null;
  const { data, error } = await supabase
    .from('sessions')
    .select('user_id, expires_at')
    .eq('token', token)
    .single();

  if (error || !data) return null;
  if (new Date(data.expires_at) < new Date()) {
    await supabase.from('sessions').delete().eq('token', token);
    return null;
  }
  return data.user_id;
}

export async function deleteSession(token) {
  await supabase.from('sessions').delete().eq('token', token);
}
