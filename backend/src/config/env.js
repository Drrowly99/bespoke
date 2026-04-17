const REQUIRED = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TOKEN_ENCRYPTION_KEY',
  'ADMIN_SECRET',
];

export function validateEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('[env] Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }
  if (process.env.TOKEN_ENCRYPTION_KEY.length !== 64) {
    console.error('[env] TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
    process.exit(1);
  }
}
