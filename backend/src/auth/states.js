/**
 * Short-lived in-memory store for pending OAuth state tokens.
 *
 * Flow:
 *  1. Extension generates a random state, opens /auth/google?state=TOKEN
 *  2. After OAuth succeeds, callback deposits { sessionToken, email } here
 *  3. Extension polls /auth/poll-session?state=TOKEN every 2 s for up to 2 min
 *  4. On first successful poll, record is consumed and deleted
 *
 * Records expire automatically after EXPIRY_MS (5 minutes).
 * In-memory is fine — these are ephemeral, single-use, and short-lived.
 */

const store = new Map(); // state → { sessionToken, email, expiresAt }
const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export function depositSession(state, sessionToken, email) {
  store.set(state, { sessionToken, email, expiresAt: Date.now() + EXPIRY_MS });
  // Auto-clean after expiry so memory doesn't leak
  setTimeout(() => store.delete(state), EXPIRY_MS + 1000);
}

/** Returns { sessionToken, email } and removes the record, or null if not ready/expired. */
export function consumeSession(state) {
  const entry = store.get(state);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(state);
    return null;
  }
  store.delete(state);
  return { sessionToken: entry.sessionToken, email: entry.email };
}
