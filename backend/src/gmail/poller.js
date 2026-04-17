/**
 * Gmail poller — scans for emails containing iCloud share links.
 *
 * Scan window logic (in priority order):
 *  1. If last_message_id exists  → query Gmail for messages AFTER that message's date
 *  2. Else if scan_from_date set → query Gmail for messages on/after that date
 *  3. Else fallback              → today only (never scan all historical mail blind)
 */
import { google } from 'googleapis';
import { buildAuthedClient } from '../auth/google.js';
import { loadTokens, updateAccessToken } from '../auth/tokens.js';
import supabase from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { appendScanLog } from '../utils/scan-log.js';

// Catches both share.icloud.com/photos/ and www.icloud.com/photos/ variants
const ICLOUD_QUERY = '"icloud.com/photos/"';

/**
 * Returns array of { messageId, subject, sender, body, caption, icloudUrls, receivedAt }
 */
export async function fetchNewICloudEmails(userId) {
  const tokens = await loadTokens(userId);
  if (!tokens) throw new Error('No credentials for user');

  const authClient = buildAuthedClient(tokens.access_token, tokens.refresh_token, tokens.expiry_date);
  const gmail = google.gmail({ version: 'v1', auth: authClient });

  // Load user row + settings in parallel
  const [{ data: userRow }, { data: settings }] = await Promise.all([
    supabase.from('users').select('last_message_id').eq('id', userId).single(),
    supabase.from('user_settings').select('scan_from_date, scan_to_date').eq('user_id', userId).single(),
  ]);

  const afterEpoch = await resolveAfterEpoch(gmail, userRow, settings);

  // Build the query — add before: only when the user set an explicit end date.
  // When scan_to_date is set, we also clear last_message_id logic so the window
  // is always [from, to] regardless of what was already processed.
  let q = `${ICLOUD_QUERY} after:${afterEpoch}`;
  if (settings?.scan_to_date) {
    // Gmail before: is exclusive, so add 1 day to include the end date itself
    const toDate = new Date(settings.scan_to_date);
    toDate.setDate(toDate.getDate() + 1);
    const toEpoch = Math.floor(toDate.getTime() / 1000);
    q += ` before:${toEpoch}`;
  }

  console.log(`[Gmail Scan] Query: "${q}"`);

  const listParams = {
    userId: 'me',
    q,
    maxResults: 50,
  };

  let listRes;
  try {
    listRes = await gmail.users.messages.list(listParams);
  } catch (err) {
    if (err.status === 429) {
      logger.warn('Gmail rate limit hit, backing off 30s', { userId });
      await sleep(30_000);
      throw err;
    }
    throw err;
  }

  const messages = listRes.data.messages || [];
  console.log(`[Gmail Scan] Raw message matches from Gmail: ${messages.length}`);
  if (!messages.length) return [];

  // Persist refreshed tokens if googleapis rotated them
  if (authClient._pendingTokenUpdate) {
    const upd = authClient._pendingTokenUpdate;
    await updateAccessToken(userId, upd.access_token, upd.expiry_date);
    delete authClient._pendingTokenUpdate;
  }

  const results = [];
  for (const { id } of messages) {
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const parsed = parseMessage(msg.data);
      if (parsed) {
        // console.log(`[Gmail Scan] Found email from ${parsed.sender}: ${parsed.subject}`, parsed);
        results.push({ messageId: id, ...parsed });
      }
    } catch (err) {
      logger.error('Failed to fetch message', { userId, messageId: id, message: err.message });
    }
  }

  // Advance the pointer to the newest message so next poll starts from here
  if (results.length) {
    await supabase.from('users').update({ last_message_id: messages[0].id }).eq('id', userId);
  }

  // Log for user visibility since they are looking for this
  if (results.length > 0) {
    await appendScanLog(results);
  }

  return results;
}

// ── Scan window resolution ────────────────────────────────────────────────────

async function resolveAfterEpoch(gmail, userRow, settings) {
  // Priority 1: advance from last processed message
  if (userRow?.last_message_id) {
    const ts = await getEpochFromMessageId(gmail, userRow.last_message_id);
    if (ts) return ts;
  }

  // Priority 2: user-configured scan_from_date
  if (settings?.scan_from_date) {
    return Math.floor(new Date(settings.scan_from_date).getTime() / 1000);
  }

  // Priority 3: 30 days ago (safe default — covers recent emails without full history scan)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  thirtyDaysAgo.setHours(0, 0, 0, 0);
  return Math.floor(thirtyDaysAgo.getTime() / 1000);
}

async function getEpochFromMessageId(gmail, messageId) {
  try {
    const msg = await gmail.users.messages.get({
      userId: 'me', id: messageId,
      format: 'metadata', metadataHeaders: ['Date'],
    });
    const dateVal = msg.data.payload?.headers?.find((h) => h.name === 'Date')?.value;
    if (dateVal) return Math.floor(new Date(dateVal).getTime() / 1000);
  } catch { /* ignore — fall through to scan_from_date */ }
  return null;
}

// ── Message parsing ───────────────────────────────────────────────────────────

function parseMessage(msgData) {
  const headers = msgData.payload?.headers || [];
  const subject = header(headers, 'subject') || '(no subject)';
  const sender = header(headers, 'from') || '';
  const dateVal = header(headers, 'date');
  const receivedAt = dateVal ? new Date(dateVal).toISOString() : new Date().toISOString();

  const plainText = extractBody(msgData.payload, 'text/plain');
  const htmlText = extractBody(msgData.payload, 'text/html');
  const bodyText = plainText || htmlText;

  const icloudUrls = extractICloudUrls(bodyText);
  if (!icloudUrls.length) return null;

  // Caption: the human-written message Apple puts before the share link
  // e.g. "Hey, check out 123 Main St photos!\nhttps://share.icloud.com/..."
  const caption = extractCaption(bodyText, icloudUrls[0]);

  // Body: everything that is NOT an iCloud URL (for album description)
  const body = truncate(stripICloudUrls(bodyText), 500);

  return { subject, sender, caption, body, icloudUrls, receivedAt };
}

function header(headers, name) {
  return headers.find((h) => h.name.toLowerCase() === name)?.value || null;
}

function extractBody(payload, preferredMime) {
  if (!payload) return '';
  if (payload.mimeType === preferredMime && payload.body?.data) {
    const raw = Buffer.from(payload.body.data, 'base64').toString('utf8');
    return preferredMime === 'text/html' ? raw.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ') : raw;
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBody(part, preferredMime);
      if (text) return text;
    }
  }
  return '';
}

/**
 * Extract ALL iCloud share URLs.
 * Token after /photos/ is alphanumeric + dash/underscore only.
 * Trims trailing punctuation email clients add (.,:;!) and deduplicates.
 */
function extractICloudUrls(text) {
  // Matches both share.icloud.com/photos/ and www.icloud.com/photos/
  const raw = [...text.matchAll(/https?:\/\/(?:share|www)\.icloud\.com\/photos\/[\w\-]+/g)];
  const cleaned = raw.map((m) => m[0].replace(/[.,;:!?)>\]]+$/, ''));
  return [...new Set(cleaned)];
}

/**
 * Extract the caption: meaningful text that appears before the first iCloud link.
 * Strips Apple's generic boilerplate lines.
 */
function extractCaption(text, firstUrl) {
  const urlIndex = text.indexOf(firstUrl);
  const before = urlIndex > 0 ? text.slice(0, urlIndex) : '';
  const BOILERPLATE = [
    /shared .* with you/i,
    /icloud photos/i,
    /apple inc/i,
    /view in.*photos/i,
    /^\s*$/,
  ];
  const lines = before
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !BOILERPLATE.some((re) => re.test(l)));
  return lines.join(' ').slice(0, 300) || null;
}

function stripICloudUrls(text) {
  return text.replace(/https?:\/\/share\.icloud\.com\/photos\/[\w\-]+/g, '').replace(/\s{2,}/g, ' ').trim();
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '…' : str;
}
