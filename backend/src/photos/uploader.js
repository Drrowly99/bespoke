/**
 * Google Photos uploader.
 * Uses undici fetch — no axios.
 *
 * Upload design:
 *  1. Sort assets by EXIF date (oldest first).
 *  2. Compress every image to JPEG quality 80 via sharp (≈20% size reduction).
 *  3. Group compressed assets into 50 MB chunks to stay well under Google's
 *     rate limits — files within each chunk upload concurrently, chunks run
 *     sequentially so we never flood the API.
 *  4. batchCreate media items in groups of ≤50 (Google Photos hard limit).
 */
import { fetch } from 'undici';
import { Readable } from 'stream';
import sharp from 'sharp';
import { google } from 'googleapis';
import { buildAuthedClient } from '../auth/google.js';
import { loadTokens, updateAccessToken } from '../auth/tokens.js';
import supabase from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/sleep.js';

const PHOTOS_BASE = 'https://photoslibrary.googleapis.com/v1';
const MAX_FILE_BYTES = 20 * 1024 * 1024;   // 20 MB — Google Photos hard limit per file
const CHUNK_BYTES = 50 * 1024 * 1024;   // 50 MB per upload chunk
const JPEG_QUALITY = 80;                 // 80% quality ≈ 20% smaller file

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Public API ────────────────────────────────────────────────────────────────

export async function uploadToGooglePhotos(userId, { assets, albumName, description, sortBy = 'exif_date', onProgress }) {
  const tokens = await loadTokens(userId);
  if (!tokens) throw new Error('No credentials for user');

  const authClient = buildAuthedClient(tokens.access_token, tokens.refresh_token, tokens.expiry_date);
  const accessToken = await getValidAccessToken(authClient);

  if (authClient._pendingTokenUpdate) {
    await updateAccessToken(userId, authClient._pendingTokenUpdate.access_token, authClient._pendingTokenUpdate.expiry_date);
    delete authClient._pendingTokenUpdate;
  }

  const sorted = sortAssets(assets, sortBy);
  const chunks = chunkBySize(sorted, CHUNK_BYTES);
  const albumId = await createAlbum(accessToken, albumName);

  console.log(`[UPLOAD] ${sorted.length} files → ${chunks.length} chunk(s) ≤50 MB each`);

  const uploadTokens = [];
  let globalIndex = 0;

  // Stage 1 — download + compress + upload bytes, chunk by chunk
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const chunkMB = (chunk.reduce((s, a) => s + (a.size || 0), 0) / 1024 / 1024).toFixed(1);
    console.log(`[UPLOAD] Chunk ${ci + 1}/${chunks.length} — ${chunk.length} files ~${chunkMB} MB`);

    const results = await Promise.all(chunk.map(async (asset) => {
      const idx = ++globalIndex;
      onProgress?.(asset.filename, idx, sorted.length);
      try {
        return await withRetry(() => compressAndUpload(accessToken, asset));
      } catch (err) {
        logger.error('Asset upload failed', { filename: asset.filename, message: err.message });
        return null;
      }
    }));

    uploadTokens.push(...results.filter(Boolean));
  }

  // Stage 2 — batchCreate media items (≤50 per call)
  let uploadedCount = 0;
  for (let i = 0; i < uploadTokens.length; i += 50) {
    const batch = uploadTokens.slice(i, i + 50);
    try {
      const created = await withRetry(() => createMediaItemsBatch(accessToken, albumId, batch, description));
      uploadedCount += created.length;
      console.log(`[UPLOAD] batchCreate ${i / 50 + 1} — ${created.length}/${batch.length} items saved`);
    } catch (err) {
      logger.error('batchCreate failed', { offset: i, message: err.message });
    }
  }

  // ── Step 1: always try to create a public shareable link ───────────────────
  let shareableUrl = null;
  try {
    shareableUrl = await shareAlbum(accessToken, albumId);
    if (shareableUrl) {
      console.log(`[UPLOAD] Public share link created — ${shareableUrl}`);
    } else {
      console.warn(`[UPLOAD] shareAlbum returned no URL — recipients will get a private link`);
    }
  } catch (err) {
    logger.warn('shareAlbum API failed', { message: err.message });
    console.warn(`[UPLOAD] shareAlbum failed (${err.message}) — check that photoslibrary.sharing scope is granted (Reconnect if needed)`);
  }

  // ── Step 2: notify recipients ────────────────────────────────────────────────
  const { data: settings } = await supabase
    .from('user_settings')
    .select('share_emails')
    .eq('user_id', userId)
    .single();

  const recipients = settings?.share_emails || [];

  if (recipients.length > 0) {
    const linkToSend = shareableUrl || `https://photos.google.com/album/${albumId}`;
    console.log(`[UPLOAD] Sending album link to ${recipients.length} recipient(s): ${linkToSend}`);
    try {
      await sendAlbumEmails(authClient, recipients, albumName, linkToSend);
      console.log(`[UPLOAD] Emails sent to: ${recipients.join(', ')}`);
    } catch (err) {
      logger.warn('Email notification failed', { message: err.message });
      console.warn(`[UPLOAD] Email send failed — ${err.message}`);
    }
  }

  const albumUrl = shareableUrl || `https://photos.google.com/album/${albumId}`;
  return { albumId, albumUrl, uploadedCount };
}

/**
 * Build the Google Photos album name.
 *
 * @param {string} receivedDate   ISO date the email arrived (always available)
 * @param {object|null} geolocation { address, latitude, longitude }
 * @param {string|null} emailSubject fallback location hint when no GPS
 * @param {object} opts
 *   dateSource  'received' | 'exif'   — which date to put in {date}
 *   exifDate    ISO string of the taken date from EXIF (may be null)
 *   pattern     Template string with {date} and {location} tokens.
 *               Default: "Auto Backup - {date} - {location}"
 */
export function buildAlbumName(receivedDate, geolocation, emailSubject, {
  dateSource = 'received',
  exifDate = null,
  pattern = 'Auto Backup - {date} - {location}',
} = {}) {
  const effectiveDate = (dateSource === 'exif' && exifDate) ? exifDate : receivedDate;
  const dateStr = new Date(effectiveDate).toISOString().slice(0, 10);

  let location = '';
  if (geolocation?.address) {
    const parts = geolocation.address.split(',').map((s) => s.trim()).filter(Boolean);
    location = parts.slice(0, 2).join(', ');
  } else if (emailSubject) {
    const cleaned = emailSubject
      .replace(/^[-\s]*forwarded message[-\s]*/i, '')
      .replace(/^[-\s]+|[-\s]+$/g, '')
      .replace(/[^\w\s\-]/g, '')
      .trim()
      .slice(0, 50);
    location = cleaned;
  }

  let name = (pattern || 'Auto Backup - {date} - {location}')
    .replace('{date}', dateStr)
    .replace('{location}', location);

  // Clean up orphaned separators when location is empty
  // e.g. "Auto Backup - 2024-07-15 - " → "Auto Backup - 2024-07-15"
  name = name.replace(/[\s\-–|,]+$/, '').replace(/\s{2,}/g, ' ').trim();

  return name || `Auto Backup - ${dateStr}`;
}

// ── Compression + upload ──────────────────────────────────────────────────────

async function compressAndUpload(accessToken, asset) {
  // Fetch raw bytes from iCloud CDN
  const res = await fetch(asset.url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`iCloud fetch failed ${res.status}`);

  const contentLength = parseInt(res.headers.get('content-length') || '0', 10) || null;
  if (contentLength && contentLength > MAX_FILE_BYTES) {
    await res.body?.cancel();
    logger.warn('Asset skipped — exceeds 20 MB limit', { filename: asset.filename, contentLength });
    return null;
  }

  const raw = Buffer.from(await res.arrayBuffer());

  // Compress to JPEG at quality 80 (≈20% size reduction, good visual quality)
  let compressed = raw;
  let filename = asset.filename.replace(/\.(heic|heif|png|webp)$/i, '.jpg');
  try {
    compressed = await sharp(raw).jpeg({ quality: JPEG_QUALITY, mozjpeg: false }).toBuffer();
    console.log(`[COMPRESS] ${asset.filename} ${kb(raw)} - ${kb(compressed)} KB`);
  } catch (err) {
    logger.warn('Compression skipped', { filename: asset.filename, message: err.message });
    filename = asset.filename; // keep original extension if sharp failed
  }

  const stream = Readable.toWeb(Readable.from(compressed));
  return uploadRawBytes(accessToken, stream, compressed.length, filename, 'image/jpeg');
}

async function uploadRawBytes(accessToken, stream, contentLength, filename, mimeType) {
  const res = await fetch(`${PHOTOS_BASE}/uploads`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(contentLength),
      'X-Goog-Upload-Content-Type': mimeType,
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': encodeURIComponent(filename),
    },
    body: stream,
    duplex: 'half',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upload failed ${res.status}: ${text}`);
  }
  return res.text(); // uploadToken
}

// ── Chunking ──────────────────────────────────────────────────────────────────

function chunkBySize(assets, maxBytes) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;

  for (const asset of assets) {
    // Use declared size; estimate 80% after compression if known
    const estimatedSize = asset.size ? Math.round(asset.size * 0.8) : 2 * 1024 * 1024;

    if (currentBytes + estimatedSize > maxBytes && current.length > 0) {
      chunks.push(current);
      current = [asset];
      currentBytes = estimatedSize;
    } else {
      current.push(asset);
      currentBytes += estimatedSize;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ── Sorting ───────────────────────────────────────────────────────────────────

function sortAssets(assets, sortBy) {
  if (sortBy === 'none' || assets.length <= 1) return assets;

  const copy = [...assets];

  if (sortBy === 'filename') {
    copy.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' }));
    return copy;
  }

  copy.sort((a, b) => {
    const da = a.exifDate ? new Date(a.exifDate).getTime() : Infinity;
    const db = b.exifDate ? new Date(b.exifDate).getTime() : Infinity;
    if (da !== db) return da - db;
    return a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' });
  });

  return copy;
}

// ── Album + batchCreate ───────────────────────────────────────────────────────

async function createAlbum(accessToken, title) {
  const res = await fetch(`${PHOTOS_BASE}/albums`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ album: { title } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createAlbum failed ${res.status}: ${text}`);
  }
  return (await res.json()).id;
}

async function createMediaItemsBatch(accessToken, albumId, tokens, description) {
  const res = await fetch(`${PHOTOS_BASE}/mediaItems:batchCreate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      albumId,
      newMediaItems: tokens.map(token => ({
        description: description?.slice(0, 1000) || '',
        simpleMediaItem: { uploadToken: token },
      })),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`batchCreate failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  const results = (data.newMediaItemResults || []).filter(r => r.status?.message === 'Success' || !r.status?.message);

  if (results.length < tokens.length) {
    logger.warn('Some batch items failed', { failed: tokens.length - results.length });
  }
  return results;
}

async function getValidAccessToken(authClient) {
  const { token } = await authClient.getAccessToken();
  return token;
}

// ── Album sharing + email notification ───────────────────────────────────────

async function shareAlbum(accessToken, albumId) {
  const res = await fetch(`${PHOTOS_BASE}/albums/${albumId}:share`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sharedAlbumOptions: { isCollaborative: false, isCommentable: false } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`shareAlbum failed ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.shareInfo?.shareableUrl || null;
}

async function sendAlbumEmails(authClient, recipients, albumName, albumUrl) {
  const gmail = google.gmail({ version: 'v1', auth: authClient });

  for (const to of recipients) {
    const subject = `Photos backed up: ${albumName}`;
    const body = [
      `Your iCloud photos have been backed up to Google Photos.`,
      ``,
      `Album: ${albumName}`,
      `View:  ${albumUrl}`,
      ``,
      `— iCloud Backup`,
    ].join('\n');

    const raw = [
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body,
    ].join('\r\n');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(raw).toString('base64url') },
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function kb(buf) {
  return Math.round(buf.length / 1024);
}
