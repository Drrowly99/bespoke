/**
 * Test script — resolves an iCloud share link and downloads all photos
 * to backend/downloads/ using the CloudKit records/query approach.
 *
 * Usage:
 *   node src/icloud/test-download.js "https://share.icloud.com/photos/TOKEN"
 */
import { mkdirSync, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { fetch } from 'undici';
import { resolveICloudAssets, fetchExifSlice } from './downloader.js';
import { extractGeolocation } from './exif.js';

const shareUrl = process.argv[2];
if (!shareUrl) {
  console.error('Usage: node src/icloud/test-download.js <icloud-share-url>');
  process.exit(1);
}

const OUT_DIR = 'downloads';
mkdirSync(OUT_DIR, { recursive: true });

console.log(`\nResolving assets from: ${shareUrl}\n`);
const assets = await resolveICloudAssets(shareUrl);
console.log(`Found ${assets.length} assets. Downloading to ./${OUT_DIR}/\n`);

let ok = 0, failed = 0;

for (const [i, asset] of assets.entries()) {
  const dest = `${OUT_DIR}/${asset.filename}`;
  process.stdout.write(`[${i + 1}/${assets.length}] ${asset.filename} (${kb(asset.size)}) ... `);

  try {
    // 1. Try to get Geolocation from the photo itself (using a slice of the original)
    const metadataUrl = asset.metadataUrl || asset.url;
    const sliceBuffer = await fetchExifSlice(metadataUrl);
    const geo = await extractGeolocation(sliceBuffer);
    const geoStatus = geo ? `📍 ${geo.address.slice(0, 40)}...` : 'No GPS';

    // 2. Download full file
    const res = await fetch(asset.url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    console.log(`✓ [${geoStatus}]`);
    ok++;
  } catch (err) {
    console.log(`✗ ${err.message}`);
    failed++;
  }
}

console.log(`\nDone. ${ok} downloaded, ${failed} failed. Files in ./${OUT_DIR}/`);

function kb(bytes) {
  if (!bytes) return '? KB';
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
