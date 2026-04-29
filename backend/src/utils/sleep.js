export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Token-bucket rate limiter.
 * Each call to the returned function claims the next available slot and waits
 * if necessary, so concurrent callers are serialised at exactly the given rate.
 *
 * @param {number} requestsPerMinute
 * @returns {() => Promise<void>}
 */
export function createRateLimiter(requestsPerMinute) {
  const intervalMs = (60 * 1000) / requestsPerMinute;
  let nextSlot = 0;
  return async function throttle() {
    const now = Date.now();
    if (nextSlot < now) nextSlot = now;
    const delay = nextSlot - now;
    nextSlot += intervalMs;
    if (delay > 0) await sleep(delay);
  };
}

/**
 * Exponential backoff retry wrapper.
 * @param {() => Promise<any>} fn
 * @param {number} retries
 * @param {number} baseDelayMs
 */
export async function withRetry(fn, retries = 4, baseDelayMs = 1000) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        const status = err?.status || err?.response?.status;
        const delay = baseDelayMs * 2 ** i * (status === 429 ? 2 : 1);
        console.warn(`[retry] attempt ${i + 1} failed, waiting ${delay}ms`, err.message);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}
