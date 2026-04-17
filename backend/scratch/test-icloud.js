import { resolveICloudAssets } from '../src/icloud/downloader.js';

async function test() {
  const testUrl = 'https://share.icloud.com/photos/placeholder-token';
  console.log('Testing iCloud resolution with browser fallback...');
  try {
    // This should fail to find the webstream data but we want to see it launch the browser
    const assets = await resolveICloudAssets(testUrl);
    console.log('Assets:', assets);
  } catch (err) {
    console.log('Expected error or result:', err.message);
  }
}

test();
