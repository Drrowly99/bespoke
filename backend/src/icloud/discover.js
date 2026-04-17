/**
 * Discovery script — captures the CDN URL fired when the iCloud per-photo
 * download button is clicked. Writes results to discover-results.json.
 *
 * Usage:
 *   node src/icloud/discover.js "https://share.icloud.com/photos/TOKEN"
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const shareUrl = process.argv[2];
if (!shareUrl) {
  console.error('Usage: node src/icloud/discover.js <icloud-share-url>');
  process.exit(1);
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const photoUrl = shareUrl.replace(/\/$/, '') + '/0';
console.log('Navigating to:', photoUrl);

const browser = await chromium.launch({ headless: false });
const context  = await browser.newContext({ userAgent: USER_AGENT });
const page     = await context.newPage();

// Capture responses — store URL/status/headers only (no body to avoid binary corruption in terminal)
const capturedResponses = [];
page.on('response', async (res) => {
  const url = res.url();
  const isNoise = /google-analytics|doubleclick|fonts\.gstatic|\.woff|\.css/.test(url);
  if (isNoise) return;

  const ct = res.headers()['content-type'] || '';

  // JSON/text: capture body. Binary: just record the URL and content-type.
  let body = null;
  let isBinary = false;
  if (ct.includes('application/json') || ct.includes('text/')) {
    try { body = await res.text(); } catch { /* ignore */ }
  } else {
    isBinary = true;
  }

  capturedResponses.push({ url, status: res.status(), contentType: ct, body, isBinary });
});

// Navigate
await page.goto(photoUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
console.log('Page loaded. Waiting for DownloadButton...');

// Poll all frames — the photo viewer lives inside the photos3 iframe
let targetFrame = null;
const deadline = Date.now() + 30_000;
while (!targetFrame && Date.now() < deadline) {
  for (const frame of page.frames()) {
    try {
      const count = await frame.locator('.DownloadButton').count();
      if (count > 0) {
        targetFrame = frame;
        console.log('Found DownloadButton in frame:', frame.url().slice(0, 100));
        break;
      }
    } catch { /* cross-origin, skip */ }
  }
  if (!targetFrame) await page.waitForTimeout(500);
}

if (!targetFrame) {
  console.log('DownloadButton not found after 30s');
  await browser.close();
  process.exit(1);
}

// Do NOT clear — we want everything: page load responses AND click responses
console.log('Clicking DownloadButton...');
await targetFrame.locator('.DownloadButton').first().click();

// Wait for the CDN download request to fire
await page.waitForTimeout(8_000);

// Write to JSON file — avoids binary-in-terminal corruption
const results = {
  clickedAt: new Date().toISOString(),
  frameUrl:  targetFrame.url(),
  responses: capturedResponses.map(r => ({
    url:         r.url,
    status:      r.status,
    contentType: r.contentType,
    isBinary:    r.isBinary,
    body:        r.body ?? null,
  })),
};

writeFileSync('discover-results.json', JSON.stringify(results, null, 2));
console.log('\nResults written to: backend/discover-results.json');
console.log(`Responses captured: ${capturedResponses.length}`);
console.log('\nURL summary:');
capturedResponses.forEach(r =>
  console.log(`  [${r.status}] ${r.isBinary ? '[BINARY] ' : ''}${r.url.slice(0, 120)}`)
);

await browser.close();
