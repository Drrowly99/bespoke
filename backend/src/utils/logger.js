/**
 * Minimal structured logger — avoids logging sensitive token values.
 */
const SENSITIVE = /token|secret|key|password|authorization/i;

function sanitize(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, SENSITIVE.test(k) ? '[REDACTED]' : v])
  );
}

export const logger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: 'info', msg, ...sanitize(meta), ts: new Date().toISOString() })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: 'warn', msg, ...sanitize(meta), ts: new Date().toISOString() })),
  error: (msg, meta) => console.error(JSON.stringify({ level: 'error', msg, ...sanitize(meta), ts: new Date().toISOString() })),
};
