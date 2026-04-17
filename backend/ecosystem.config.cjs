module.exports = {
  apps: [{
    name: 'bespoke-backend',
    script: 'src/server.js',
    env: {
      NODE_ENV: 'production',
      PORT: 4000,
      GOOGLE_CLIENT_ID: 'YOUR_GOOGLE_ID',
      GOOGLE_CLIENT_SECRET: 'YOUR_GOOGLE_SECRET',
      GOOGLE_REDIRECT_URI: 'https://bespoke.cloud-ip.cc/auth/google/callback',
      SUPABASE_URL: 'YOUR_SUPABASE_URL',
      SUPABASE_SERVICE_ROLE_KEY: 'YOUR_SERVICE_ROLE_KEY',
      TOKEN_ENCRYPTION_KEY: 'YOUR_64_CHAR_HEX_KEY',
      ADMIN_SECRET: 'YOUR_ADMIN_PASSWORD',
      POLL_INTERVAL_MS: 180000
    }
  }]
};
