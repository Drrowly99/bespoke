/**
 * iCloud share link downloader — CloudKit records/query approach.
 *
 * Flow:
 *  1. resolveICloudAssets()
 *     Playwright navigates to the share URL. iCloud's JS automatically fires
 *     several POST calls to ckdatabasews.icloud.com/records/query which return
 *     CPLMaster records — one per photo, each containing a signed CDN download
 *     URL. We collect all records via the response listener, no clicks needed.
 *
 *  2. fetchExifSlice()
 *     Range-fetches the first 128KB of a CDN URL for GPS extraction.
 *
 *  3. getAssetReadable()
 *     Streams the full file directly from the CDN URL via undici.
 *     CDN URLs are self-authenticating (token in query string) — no cookies needed.
 */
import { chromium } from 'playwright';
import { fetch } from 'undici';
import { logger } from '../utils/logger.js';

const MAX_FILE_SIZE    = 20 * 1024 * 1024; // 20 MB Google Photos limit
const EXIF_SLICE_BYTES = 1024 * 1024;    // 1 MB — needed for modern HEIC/JPEG headers

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve a share URL to a list of asset descriptors.
 *
 * Uses the "Discovery" pattern:
 * 1. Appends /0 to the URL to go straight to the viewer.
 * 2. Waits for and clicks the "Download" button inside the photo framework frame.
 * 3. This triggers several 'records/query' calls from the iCloud JS.
 * 4. We capture all CPLMaster records returned in those responses.
 *
 * @param {string} shareUrl  e.g. https://share.icloud.com/photos/TOKEN
 * @returns {Promise<Array<{ url, filename, mimeType, size, exifDate, cookies }>>}
 */
export async function resolveICloudAssets(shareUrl) {
  // Canonicalize any iCloud URL format to share.icloud.com/photos/TOKEN
  // Handles: www.icloud.com/photos/#/TOKEN, www.icloud.com/photos/#TOKEN, share.icloud.com/photos/TOKEN
  const token = extractShareToken(shareUrl);
  if (!token) throw new Error(`Cannot extract share token from URL: ${shareUrl}`);
  const photoUrl = `https://share.icloud.com/photos/${token}/0`;
  logger.info('Resolving iCloud assets via Discovery approach', { photoUrl });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page    = await context.newPage();

    const masterRecordsMap = new Map(); // Use Map to deduplicate records by name

    page.on('response', async (res) => {
      const url = res.url();
      if (!url.includes('ckdatabasews.icloud.com') || !url.includes('records/query')) return;
      try {
        const data    = await res.json();
        const masters = (data.records || []).filter(r => r.recordType === 'CPLMaster');
        for (const m of masters) {
          masterRecordsMap.set(m.recordName, m);
        }
      } catch { /* not JSON or already consumed */ }
    });

    // Navigate - domcontentloaded is enough to start looking for the framework
    await page.goto(photoUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Poll frames for the Download button (the indicator that the photos framework is alive)
    let targetFrame = null;
    const deadline  = Date.now() + 30_000;
    while (!targetFrame && Date.now() < deadline) {
      for (const frame of page.frames()) {
        try {
          const count = await frame.locator('.DownloadButton').count();
          if (count > 0) { targetFrame = frame; break; }
        } catch { /* cross-origin frame, skip */ }
      }
      if (!targetFrame) await page.waitForTimeout(1000);
    }

    if (!targetFrame) {
      throw new Error(`Failed to find iCloud Photos framework (DownloadButton) after 30s at ${photoUrl}`);
    }

    logger.info('Photos framework detected, triggering metadata fetch...');
    await targetFrame.locator('.DownloadButton').first().click();

    // Wait for the records/query calls to finish firing (usually 2-5 seconds)
    await page.waitForTimeout(5000);

    const masterRecords = Array.from(masterRecordsMap.values());
    if (masterRecords.length === 0) {
      throw new Error(`No CPLMaster records captured for ${shareUrl}. Please ensure the link is public.`);
    }

    const assets = masterRecords.map(extractAsset).filter(Boolean);
    logger.info('iCloud assets resolved', { total: masterRecords.length, usable: assets.length });
    return assets;
  } finally {
    await browser.close();
  }
}

/**
 * Range-fetch the first 128KB of an asset URL for GPS/EXIF extraction.
 *
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
export async function fetchExifSlice(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Range: `bytes=0-${EXIF_SLICE_BYTES}`,
    },
    redirect: 'follow',
  });
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`EXIF slice fetch returned ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Open a readable stream for a full asset for direct pipe to Google Photos.
 * Returns null if the file exceeds the Google Photos size limit.
 *
 * @param {string} url
 * @param {string} declaredMime
 * @returns {Promise<{ stream: ReadableStream, contentLength: number|null, mimeType: string }|null>}
 */
export async function getAssetReadable(url, declaredMime) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Asset stream returned ${res.status}`);

  const contentLength = parseInt(res.headers.get('content-length') || '0', 10) || null;
  if (contentLength && contentLength > MAX_FILE_SIZE) {
    await res.body?.cancel();
    return null;
  }

  const mimeType =
    res.headers.get('content-type')?.split(';')[0].trim() ||
    declaredMime ||
    'image/jpeg';

  return { stream: res.body, contentLength, mimeType };
}

// ── Record extraction ─────────────────────────────────────────────────────────

/**
 * Extract a usable asset descriptor from a CPLMaster CloudKit record.
 *
 * Prefers resJPEGMedRes (medium JPEG, ~1-2MB) over resOriginalRes (HEIC, larger).
 * Both contain a signed downloadURL with ${f} as a filename placeholder.
 */
function extractAsset(record) {
  const f = record.fields;

  const medRes = f.resJPEGMedRes?.value;
  const origRes = f.resOriginalRes?.value;

  // Prioritize original master record (HEIC/Original JPEG) over medium JPEG
  const chosen = origRes || medRes;
  if (!chosen?.downloadURL) return null;

  const isOrig = !!origRes;
  const fileToken = isOrig ? (f.resOriginalFileType?.value || 'public.heic') : 'public.jpeg';

  // ${f} is Apple's placeholder for the file type string in the CDN URL
  const url = chosen.downloadURL.replace('${f}', fileToken);

  // filenameEnc is base64(utf8 filename)
  let filename;
  try {
    const raw = Buffer.from(f.filenameEnc?.value || '', 'base64').toString('utf8');
    filename = raw;
  } catch {
    const ext = isOrig ? (f.resOriginalFileType?.value?.split('.').pop() || 'heic') : 'jpg';
    filename = `photo_${record.recordName}.${ext}`;
  }

  const rawMime = f.itemType?.value || '';
  const fileType = f.resOriginalFileType?.value || '';
  
  let mimeType = 'image/jpeg'; // fallback
  if (rawMime.includes('heic')) mimeType = 'image/heic';
  else if (rawMime.includes('quicktime') || fileType.includes('quicktime') || filename.toLowerCase().endsWith('.mov')) mimeType = 'video/quicktime';
  else if (rawMime.includes('mpeg4') || fileType.includes('mpeg4') || filename.toLowerCase().endsWith('.mp4')) mimeType = 'video/mp4';
  else if (rawMime.includes('jpeg') || fileType.includes('jpeg')) mimeType = 'image/jpeg';
  else if (isOrig) mimeType = 'image/jpeg'; // default for original if unknown but orig exists

  const size     = chosen.size || null;
  const exifDate = f.originalCreationDate?.value
    ? new Date(f.originalCreationDate.value).toISOString()
    : null;

  return {
    url,
    metadataUrl: origRes?.downloadURL?.replace('${f}', f.resOriginalFileType?.value || 'public.heic'), 
    filename: sanitizeFilename(filename),
    mimeType,
    size,
    exifDate,
    cookies: null, // CDN URLs self-authenticate via query-string tokens
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the bare share token from any iCloud photos URL variant.
 * https://share.icloud.com/photos/TOKEN/0  → TOKEN
 * https://www.icloud.com/photos/#TOKEN     → TOKEN
 */
export function extractShareToken(url) {
  // Handles all known URL variants:
  //   share.icloud.com/photos/TOKEN
  //   share.icloud.com/photos/TOKEN/0
  //   www.icloud.com/photos/#TOKEN
  //   www.icloud.com/photos/#/TOKEN
  const match = url.match(/\/photos\/[#/]*([A-Za-z0-9_\-]{10,})/);
  return match ? match[1] : null;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 200);
}
