import { resolveICloudAssets } from './src/icloud/downloader.js';
import { extractGeolocation } from './src/icloud/exif.js';
import { fetch } from 'undici';

async function testExif() {
  const url = 'https://share.icloud.com/photos/027hSDCde-ExfSzGaGDm08kPQ';
  console.log('Resolving assets...');
  const assets = await resolveICloudAssets(url);
  const asset = assets[0]; // Take the first one

  console.log(`Testing Asset: ${asset.filename}`);
  console.log(`URL: ${asset.url.slice(0, 100)}...`);

  // 1. Try 128KB slice
  console.log('\n--- 128KB SLICE ---');
  const slice128 = await fetchSlice(asset.url, 128 * 1024);
  const geo128 = await extractGeolocation(slice128);
  console.log('GPS 128KB:', geo128 ? 'FOUND' : 'NOT FOUND', geo128);

  // 2. Try 1MB slice
  console.log('\n--- 1MB SLICE ---');
  const slice1M = await fetchSlice(asset.url, 1024 * 1024);
  const geo1M = await extractGeolocation(slice1M);
  console.log('GPS 1MB:', geo1M ? 'FOUND' : 'NOT FOUND', geo1M);

  // 3. Try FULL FILE (first 5MB if large)
  console.log('\n--- FULL FILE (first 5MB) ---');
  const full = await fetchSlice(asset.url, 5 * 1024 * 1024);
  const geoFull = await extractGeolocation(full);
  console.log('GPS Full:', geoFull ? 'FOUND' : 'NOT FOUND', geoFull);
}

async function fetchSlice(url, bytes) {
  const res = await fetch(url, {
    headers: { 'Range': `bytes=0-${bytes - 1}` }
  });
  return Buffer.from(await res.arrayBuffer());
}

testExif();
