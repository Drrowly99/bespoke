/**
 * EXIF / GPS extraction using exifr.
 * Falls back gracefully if metadata is stripped.
 */
import exifr from 'exifr';
const { parse: parseExif } = exifr;
import { fetch } from 'undici';
import supabase from '../config/supabase.js';
import { logger } from '../utils/logger.js';

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = process.env.GEOCODING_USER_AGENT || 'icloud-backup/1.0';

/**
 * Extract GPS from an image buffer (can be a partial/Range-fetched slice).
 * Returns { latitude, longitude, address } or null if no GPS data found.
 */
export async function extractGeolocation(buffer) {
  try {
    const exif = await parseExif(buffer, { gps: true, tiff: false, firstChunkSize: buffer.length });
    if (!exif?.latitude || !exif?.longitude) return null;

    const { latitude, longitude } = exif;
    const address = await reverseGeocode(latitude, longitude);
    return { latitude, longitude, address };
  } catch (err) {
    logger.warn('EXIF extraction failed', { message: err.message });
    return null;
  }
}

/**
 * Extract the date the photo was taken from EXIF metadata.
 * Returns an ISO 8601 string (e.g. "2024-07-15T10:32:00.000Z") or null.
 * Tries DateTimeOriginal → CreateDate → DateTime in order.
 */
export async function extractExifDate(buffer) {
  try {
    const exif = await parseExif(buffer, {
      tiff: true,
      pick: ['DateTimeOriginal', 'CreateDate', 'DateTime'],
      firstChunkSize: buffer.length,
    });
    if (!exif) return null;

    const raw = exif.DateTimeOriginal || exif.CreateDate || exif.DateTime;
    if (!raw) return null;

    // exifr returns JS Date objects for these fields
    if (raw instanceof Date && !isNaN(raw.getTime())) return raw.toISOString();

    // Some parsers return "YYYY:MM:DD HH:MM:SS" strings — normalise to ISO
    const iso = String(raw).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch (err) {
    logger.warn('EXIF date extraction failed', { message: err.message });
    return null;
  }
}

async function reverseGeocode(latitude, longitude) {
  // Check cache first
  const cached = await getGeocodeCache(latitude, longitude);
  if (cached) return cached;

  try {
    const url = `${NOMINATIM_BASE}?lat=${latitude}&lon=${longitude}&format=json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
    const data = await res.json();
    const address = data.display_name || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;

    await setGeocodeCache(latitude, longitude, data);
    return address;
  } catch (err) {
    logger.warn('Reverse geocoding failed', { message: err.message });
    return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
  }
}

async function getGeocodeCache(lat, lon) {
  const { data } = await supabase
    .from('geocoding_cache')
    .select('address_json')
    .eq('latitude', lat.toFixed(6))
    .eq('longitude', lon.toFixed(6))
    .single();
  return data?.address_json?.display_name || null;
}

async function setGeocodeCache(lat, lon, addressJson) {
  await supabase.from('geocoding_cache').upsert(
    { latitude: lat.toFixed(6), longitude: lon.toFixed(6), address_json: addressJson },
    { onConflict: 'latitude,longitude' }
  );
}
