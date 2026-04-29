/**
 * iCloud album probe — Programmatic API Pagination
 *
 * Strategy:
 *  1. Open album grid URL
 *  2. Intercept the first 'records/query' POST request to capture headers and body payload.
 *  3. Abort the Playwright page navigation since we don't need the UI anymore.
 *  4. Programmatically loop and `fetch` the API, passing the `continuationMarker` 
 *     each time until all records are retrieved.
 *  5. Extract and print all assets.
 *
 * Run:
 *   node probe-album.js "https://share.icloud.com/photos/TOKEN"
 */
import { chromium } from 'playwright';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const shareUrl = process.argv[2];
if (!shareUrl) {
  console.error('Usage: node probe-album.js "https://share.icloud.com/photos/TOKEN"');
  process.exit(1);
}

const token = extractShareToken(shareUrl);
if (!token) {
  console.error('Could not extract share token from URL:', shareUrl);
  process.exit(1);
}

const albumGridUrl = `https://share.icloud.com/photos/${token}/0`;

console.log('\n=== PROBE START ===');
console.log('Album target URL:', albumGridUrl);
console.log('Token:', token);

// We use headless: false to avoid bot detection issues on the initial load
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ userAgent: USER_AGENT });
const page = await context.newPage();

let apiRequestUrl = null;
let apiRequestHeaders = null;
let apiRequestBody = null;

// Intercept the request
await page.route('**/*', (route) => {
  const request = route.request();
  const url = request.url();
  
  if (request.method() === 'POST' && url.includes('ckdatabasews') && url.includes('records/query')) {
    const postData = request.postDataJSON();
    const recordType = postData?.query?.recordType || '';
    
    // We only want the query that fetches the actual images/assets, not the album metadata
    if ((recordType.includes('Asset') || recordType.includes('Master')) && !apiRequestUrl) {
      apiRequestUrl = url;
      apiRequestHeaders = request.headers();
      
      // Remove headers that might cause issues with programmatic fetch
      delete apiRequestHeaders['content-length'];
      delete apiRequestHeaders['accept-encoding'];
      
      apiRequestBody = postData;
      
      // If we intercepted a request for a specific image (e.g. from /0), 
      // we must remove the filter so we can paginate through ALL images.
      if (apiRequestBody.query && apiRequestBody.query.filterBy) {
        delete apiRequestBody.query.filterBy;
      }
      
      // Boost the limit to fetch faster
      if (apiRequestBody.resultsLimit) {
        apiRequestBody.resultsLimit = 100;
      }
      
      console.log(`✅ Intercepted target CloudKit API request! (recordType: ${recordType})`);
    }
  }
  route.continue();
});

console.log('\n--- Phase 1: Navigating to capture initial API request ---');
try {
  // We just wait until we capture our required request, no need to fully load if we get it early
  await page.goto(albumGridUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  
  // Wait a little bit for the request to fire
  let attempts = 0;
  while (!apiRequestUrl && attempts < 20) { // Wait up to 10 seconds (20 * 500ms)
    await page.waitForTimeout(500);
    attempts++;
  }
} catch (e) {
  // It might timeout, but as long as we got the request, we are good
}

if (!apiRequestUrl || !apiRequestBody) {
  console.error('❌ Failed to intercept the initial API request. Exiting.');
  await browser.close();
  process.exit(1);
}

// We have the request details, we can close the browser now!
await browser.close();

// ── Phase 2: Programmatic Pagination ─────────────────────────────────────

console.log('\n--- Phase 2: Paginating API programmatically ---');

const masterRecords = new Map();
let continuationMarker = null;
let pageCount = 0;

while (true) {
  pageCount++;
  
  const payload = { ...apiRequestBody };
  if (continuationMarker) {
    payload.continuationMarker = continuationMarker;
  } else {
    delete payload.continuationMarker;
  }

  console.log(`[Page ${pageCount}] Fetching records...`);
  
  const response = await fetch(apiRequestUrl, {
    method: 'POST',
    headers: apiRequestHeaders,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    console.error(`❌ API request failed with status: ${response.status}`);
    const text = await response.text();
    console.error(text);
    break;
  }

  const data = await response.json();
  const records = data.records || [];
  
  const masters = records.filter(r => r.recordType === 'CPLMaster');
  let newCount = 0;

  for (const m of masters) {
    if (!masterRecords.has(m.recordName)) {
      masterRecords.set(m.recordName, m);
      newCount++;
    }
  }

  console.log(`  -> Got ${records.length} total records, ${masters.length} CPLMaster records (+${newCount} new)`);

  if (data.continuationMarker) {
    continuationMarker = data.continuationMarker;
  } else {
    console.log('  -> No continuation marker. Pagination complete.');
    break;
  }
}

// ── Final report ──────────────────────────────────────────────────────────────

const assets = Array.from(masterRecords.values()).map(extractAsset).filter(Boolean);

console.log('\n========== PROBE REPORT ==========');
console.log(`Total CPLMaster records:   ${masterRecords.size}`);
console.log(`Usable assets extracted:   ${assets.length}`);
console.log(`Total API pages fetched:   ${pageCount}`);

console.log('\n--- Asset list ---');
assets.forEach((a, i) => {
  console.log(`[${String(i + 1).padStart(4, '0')}] ${a.filename} | ${a.mimeType} | url=${a.url.slice(0, 80)}...`);
});

console.log('\n=== PROBE DONE ===\n');

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractAsset(record) {
  const f = record?.fields || {};
  const origRes = f.resOriginalRes?.value;
  const medRes  = f.resJPEGMedRes?.value;
  const chosen  = origRes || medRes;
  if (!chosen?.downloadURL) return null;

  const isOrig    = !!origRes;
  const fileToken = isOrig ? (f.resOriginalFileType?.value || 'public.heic') : 'public.jpeg';
  const url       = chosen.downloadURL.replace('${f}', fileToken);

  let filename;
  try {
    filename = Buffer.from(f.filenameEnc?.value || '', 'base64').toString('utf8') || record.recordName;
  } catch {
    const ext = isOrig ? (f.resOriginalFileType?.value?.split('.').pop() || 'heic') : 'jpg';
    filename = `photo_${record.recordName}.${ext}`;
  }

  const rawMime  = f.itemType?.value || '';
  const fileType = f.resOriginalFileType?.value || '';
  let mimeType   = 'image/jpeg';
  if (rawMime.includes('heic')) mimeType = 'image/heic';
  else if (rawMime.includes('quicktime') || fileType.includes('quicktime') || filename.toLowerCase().endsWith('.mov')) mimeType = 'video/quicktime';
  else if (rawMime.includes('mpeg4') || fileType.includes('mpeg4') || filename.toLowerCase().endsWith('.mp4')) mimeType = 'video/mp4';

  return { recordName: record.recordName, filename, mimeType, url };
}

function extractShareToken(url) {
  // Remove trailing slashes and '/0' if present
  let cleanUrl = url.replace(/\/0\/?$/, '').replace(/\/$/, '');
  const parts = cleanUrl.split('/');
  return parts[parts.length - 1] || null;
}
