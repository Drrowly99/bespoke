/**
 * iCloud share link downloader — hybrid architecture.
 *
 * Phase 1 (Browser, fast):
 *   Navigate to /TOKEN/0. The iCloud viewer immediately fires a records/query
 *   POST to CloudKit. We intercept that outgoing request to capture:
 *     - The exact API URL (includes dynamic build/mastering params)
 *     - All auth headers (cookies, etc.)
 *     - The zoneID from the request body
 *   Browser is closed the moment the request is captured.
 *
 * Phase 2 (Native fetch, no browser):
 *   Strip the single-photo filter Apple adds for /0, set resultsLimit=200, and
 *   loop with continuationMarker until all CPLMaster records are collected.
 *   No DOM, no scrolling, no virtual-list caps.
 */
import { chromium } from 'playwright';
import { fetch } from 'undici';
import { logger } from '../utils/logger.js';

const MAX_FILE_SIZE    = 20 * 1024 * 1024; // 20 MB Google Photos limit
const EXIF_SLICE_BYTES = 1024 * 1024;      // 1 MB for HEIC/JPEG EXIF headers

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve a share URL to a list of asset descriptors.
 *
 * @param {string} shareUrl  e.g. https://share.icloud.com/photos/TOKEN
 * @returns {Promise<Array<{ url, filename, mimeType, size, exifDate, cookies }>>}
 */
export async function resolveICloudAssets(shareUrl) {
  const token = extractShareToken(shareUrl);
  if (!token) throw new Error(`Cannot extract share token from URL: ${shareUrl}`);

  logger.info('Resolving iCloud assets', { shareUrl });

  // ── Phase 1: intercept the CloudKit request fired by /TOKEN/0 ────────────
  let captured = null;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page    = await context.newPage();

    await page.route('**ckdatabasews**records/query**', async (route) => {
      if (!captured) {
        const req = route.request();
        let body = null;
        try { body = req.postDataJSON(); } catch { /* not JSON */ }
        captured = {
          url:     req.url(),
          headers: req.headers(),
          body,
        };
        logger.info('CloudKit request intercepted', {
          zoneName: body?.zoneID?.zoneName,
        });
      }
      // Let the request complete so the page doesn't stall
      await route.continue();
    });

    await page.goto(`https://share.icloud.com/photos/${token}/0`, {
      waitUntil: 'domcontentloaded',
      timeout:   30_000,
    });

    // Wait up to 15 s for the interception
    for (let i = 0; i < 30 && !captured; i++) {
      await page.waitForTimeout(500);
    }
  } finally {
    await browser.close();
  }

  if (!captured) {
    throw new Error('No CloudKit records/query request intercepted — album may be private or expired');
  }

  const zoneID = captured.body?.zoneID;
  if (!zoneID) {
    throw new Error('Could not extract zoneID from intercepted CloudKit request');
  }

  logger.info('Browser closed — entering native fetch pagination', { zoneName: zoneID.zoneName });

  // ── Phase 2: native fetch pagination loop ────────────────────────────────
  // Strip the /0 single-photo filter; keep only direction sort.
  const queryUrl   = captured.url;
  const authHeaders = { ...captured.headers, 'content-type': 'text/plain' };

  const masterRecordsMap = new Map();
  let continuationMarker = null;
  let pageNum = 0;

  while (true) {
    const reqBody = {
      query: {
        recordType: 'CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted',
        filterBy: [{
          fieldName:  'direction',
          comparator: 'EQUALS',
          fieldValue: { value: 'DESCENDING', type: 'STRING' },
        }],
      },
      zoneID,
      resultsLimit: 200,
    };
    if (continuationMarker) reqBody.continuationMarker = continuationMarker;

    const res = await fetch(queryUrl, {
      method:  'POST',
      headers: authHeaders,
      body:    JSON.stringify(reqBody),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`CloudKit page ${pageNum} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data    = await res.json();
    const masters = (data.records || []).filter(r => r.recordType === 'CPLMaster');
    let newCount  = 0;
    for (const m of masters) {
      if (!masterRecordsMap.has(m.recordName)) {
        masterRecordsMap.set(m.recordName, m);
        newCount++;
      }
    }

    logger.info('CloudKit page fetched', {
      page:    pageNum,
      new:     newCount,
      total:   masterRecordsMap.size,
      hasMore: !!data.continuationMarker,
    });

    continuationMarker = data.continuationMarker || null;
    pageNum++;
    if (!continuationMarker) break;
    if (pageNum > 200) throw new Error('Exceeded 200 pages (> 40 000 photos?)');
  }

  const masterRecords = Array.from(masterRecordsMap.values());
  if (!masterRecords.length) {
    throw new Error(`No CPLMaster records found for ${shareUrl}. Ensure the link is public.`);
  }

  const assets = masterRecords.map(extractAsset).filter(Boolean);
  logger.info('iCloud assets resolved', {
    masters: masterRecords.length,
    usable:  assets.length,
    pages:   pageNum,
  });
  return assets;
}

/**
 * Range-fetch the first 1 MB of an asset URL for GPS/EXIF extraction.
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

function extractAsset(record) {
  const f = record.fields;

  const origRes = f.resOriginalRes?.value;
  const medRes  = f.resJPEGMedRes?.value;
  const chosen  = origRes || medRes;
  if (!chosen?.downloadURL) return null;

  const isOrig    = !!origRes;
  const fileToken = isOrig ? (f.resOriginalFileType?.value || 'public.heic') : 'public.jpeg';
  const url       = chosen.downloadURL.replace('${f}', fileToken);

  let filename;
  try {
    const raw = Buffer.from(f.filenameEnc?.value || '', 'base64').toString('utf8');
    filename = raw;
  } catch {
    const ext = isOrig ? (f.resOriginalFileType?.value?.split('.').pop() || 'heic') : 'jpg';
    filename = `photo_${record.recordName}.${ext}`;
  }

  const rawMime  = f.itemType?.value || '';
  const fileType = f.resOriginalFileType?.value || '';
  let mimeType   = 'image/jpeg';
  if (rawMime.includes('heic')) mimeType = 'image/heic';
  else if (rawMime.includes('quicktime') || fileType.includes('quicktime') || filename.toLowerCase().endsWith('.mov')) mimeType = 'video/quicktime';
  else if (rawMime.includes('mpeg4')     || fileType.includes('mpeg4')     || filename.toLowerCase().endsWith('.mp4')) mimeType = 'video/mp4';
  else if (rawMime.includes('jpeg')      || fileType.includes('jpeg'))      mimeType = 'image/jpeg';
  else if (isOrig) mimeType = 'image/jpeg';

  const size     = chosen.size || null;
  const exifDate = f.originalCreationDate?.value
    ? new Date(f.originalCreationDate.value).toISOString()
    : null;

  return {
    url,
    metadataUrl: origRes?.downloadURL?.replace('${f}', f.resOriginalFileType?.value || 'public.heic'),
    filename:    sanitizeFilename(filename),
    mimeType,
    size,
    exifDate,
    cookies: null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function extractShareToken(url) {
  const match = url.match(/\/photos\/[#/]*([A-Za-z0-9_\-]{10,})/);
  return match ? match[1] : null;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 200);
}
