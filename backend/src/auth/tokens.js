/**
 * Persist and retrieve encrypted OAuth tokens from Supabase.
 */
import supabase from '../config/supabase.js';
import { encrypt, decrypt } from '../utils/crypto.js';

export async function saveTokens(userId, { access_token, refresh_token, expiry_date }) {
  const row = {
    user_id: userId,
    access_token: encrypt(access_token),
    expiry_date: expiry_date ? new Date(expiry_date).toISOString() : null,
  };
  if (refresh_token) row.refresh_token = encrypt(refresh_token);

  const { error } = await supabase
    .from('user_credentials')
    .upsert(row, { onConflict: 'user_id' });
  if (error) throw new Error(`saveTokens: ${error.message}`);
}

export async function loadTokens(userId) {
  const { data, error } = await supabase
    .from('user_credentials')
    .select('access_token, refresh_token, expiry_date')
    .eq('user_id', userId)
    .single();

  if (error || !data) return null;
  return {
    access_token: decrypt(data.access_token),
    refresh_token: decrypt(data.refresh_token),
    expiry_date: data.expiry_date ? new Date(data.expiry_date).getTime() : null,
  };
}

export async function updateAccessToken(userId, access_token, expiry_date) {
  const { error } = await supabase
    .from('user_credentials')
    .update({
      access_token: encrypt(access_token),
      expiry_date: expiry_date ? new Date(expiry_date).toISOString() : null,
    })
    .eq('user_id', userId);
  if (error) throw new Error(`updateAccessToken: ${error.message}`);
}
