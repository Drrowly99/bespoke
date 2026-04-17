import { google } from 'googleapis';

export function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl(state) {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    state: state || undefined,
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/photoslibrary.appendonly',
      'https://www.googleapis.com/auth/photoslibrary.sharing',
      'openid',
      'profile',
      'email',
    ],
  });
}

/**
 * Exchange authorization code for tokens.
 * Returns { access_token, refresh_token, expiry_date, id_token }
 */
export async function exchangeCode(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

/**
 * Build an authenticated OAuth2 client from stored (decrypted) tokens.
 * Handles silent refresh automatically via the googleapis library.
 */
export function buildAuthedClient(accessToken, refreshToken, expiryDate) {
  const client = createOAuthClient();
  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiryDate,
  });
  // Persist newly refreshed tokens back to Supabase when they rotate
  client.on('tokens', (tokens) => {
    // Caller must wire up persistence; emitted event carries new access_token
    client._pendingTokenUpdate = tokens;
  });
  return client;
}
