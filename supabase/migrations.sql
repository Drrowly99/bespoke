-- iCloud → Google Photos Auto-Backup System

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id        TEXT UNIQUE NOT NULL,
  email            TEXT NOT NULL,
  connected_at     TIMESTAMPTZ DEFAULT NOW(),
  last_sync        TIMESTAMPTZ,
  last_message_id  TEXT,         -- last Gmail message ID processed (prevents re-polling)
  is_locked        BOOLEAN DEFAULT FALSE,
  locked_at        TIMESTAMPTZ,
  locked_reason    TEXT,         -- admin-only
  locked_by        TEXT          -- admin email/identifier
);

CREATE INDEX IF NOT EXISTS idx_users_locked ON users(is_locked) WHERE is_locked = TRUE;

-- ── OAuth tokens (encrypted at rest) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  access_token  TEXT NOT NULL,   -- AES-256-GCM encrypted
  refresh_token TEXT NOT NULL,   -- AES-256-GCM encrypted
  expiry_date   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Sessions ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

-- ── Per-user settings ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  icloud_sync_enabled  BOOLEAN DEFAULT FALSE,
  sync_status          TEXT DEFAULT 'idle',  -- idle | active | paused | token_error
  scan_from_date       DATE DEFAULT NULL,
  scan_to_date         DATE DEFAULT NULL,    -- UI treats blank as today's date unless overridden
  share_emails         JSONB DEFAULT '[]',  -- email addresses to notify after each album upload
  album_date_source    TEXT DEFAULT 'received',  -- 'received' | 'exif' — which date to use in album name
  album_name_pattern   TEXT DEFAULT 'Auto Backup - {date} - {location}',  -- template tokens: {date} {location}
  album_name_include_share_token BOOLEAN DEFAULT FALSE,  -- include the iCloud share token in the album name
  album_name_share_token_position TEXT DEFAULT 'suffix',  -- 'prefix' | 'suffix'
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ── Processed emails audit log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS processed_emails (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  message_id       TEXT NOT NULL,            -- Gmail message ID
  sender           TEXT,
  subject          TEXT,
  caption          TEXT,                     -- human note from iCloud share email
  icloud_url       TEXT,
  share_token      TEXT,                     -- bare token from URL for dedup
  google_album_id  TEXT,
  google_album_url TEXT,
  geolocation      JSONB,                    -- { latitude, longitude, address }
  property_label   TEXT,                     -- geocoded address or email subject
  description      TEXT,
  status           TEXT DEFAULT 'pending',   -- pending | processing | completed | skipped | failed
  error_reason     TEXT,
  export_ready     BOOLEAN DEFAULT FALSE,
  received_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  link_index       INTEGER DEFAULT 0,        -- index within a multi-link email
  total_links      INTEGER DEFAULT 1,        -- total iCloud links in the source email
  total_assets     INTEGER,                  -- number of files in the iCloud share
  uploaded_assets  INTEGER,                  -- number of files successfully uploaded
  asset_manifest   JSONB,                    -- resolved iCloud asset descriptors
  upload_manifest  JSONB,                    -- per-file upload/save status
  -- One row per (user, email, link)
  UNIQUE(user_id, message_id, icloud_url)
);

CREATE INDEX IF NOT EXISTS idx_processed_emails_user
  ON processed_emails(user_id, created_at DESC);

-- Dedup on share token — same album never processed twice regardless of URL format
CREATE UNIQUE INDEX IF NOT EXISTS idx_processed_emails_share_token
  ON processed_emails(user_id, share_token)
  WHERE share_token IS NOT NULL;

-- ── Geocoding cache ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS geocoding_cache (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  latitude     DECIMAL(9,6) NOT NULL,
  longitude    DECIMAL(9,6) NOT NULL,
  address_json JSONB NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(latitude, longitude)
);
CREATE INDEX IF NOT EXISTS idx_geo_coords ON geocoding_cache(latitude, longitude);

-- ── Row Level Security (enable but allow service role bypass) ─────────────────
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credentials   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_emails   ENABLE ROW LEVEL SECURITY;
ALTER TABLE geocoding_cache    ENABLE ROW LEVEL SECURITY;

-- Service role has full access (backend uses service role key).
-- No public policies — all access is via the backend service role only.

-- ── Incremental ALTER statements (run these against an existing live DB) ───────
-- Skip if applying this file fresh to a new database (CREATE TABLE above already
-- includes all columns). Only needed when upgrading a database created from an
-- older version of this file.

-- ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS caption TEXT;
-- ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS property_label TEXT;
-- ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS share_token TEXT;
-- ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS link_index INTEGER DEFAULT 0;
-- ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS total_links INTEGER DEFAULT 1;
-- ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS total_assets INTEGER;
-- ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS uploaded_assets INTEGER;
-- ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS google_album_id TEXT;
-- ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS asset_manifest JSONB;
-- ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS upload_manifest JSONB;
-- ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS scan_from_date DATE DEFAULT CURRENT_DATE;
-- ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS scan_to_date DATE DEFAULT NULL;
-- ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS share_emails JSONB DEFAULT '[]';
-- ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS album_date_source TEXT DEFAULT 'received';
-- ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS album_name_pattern TEXT DEFAULT 'Auto Backup - {date} - {location}';
-- ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS album_name_include_share_token BOOLEAN DEFAULT FALSE;
-- ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS album_name_share_token_position TEXT DEFAULT 'suffix';
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_reason TEXT;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_by TEXT;
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_processed_emails_share_token ON processed_emails(user_id, share_token) WHERE share_token IS NOT NULL;
-- NOTIFY pgrst, 'reload schema';
