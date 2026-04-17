/**
 * Writes a rolling JSON debug log of every Gmail scan to backend/data/mail_scan_log.json.
 *
 * - Keeps the last 15 message entries (newest first)
 * - Skips messages already in the log (dedup by messageId)
 * - Never throws — write failures are logged but don't crash the pipeline
 */
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../data');
const LOG_FILE = join(DATA_DIR, 'mail_scan_log.json');
const MAX_ENTRIES = 15;

/**
 * @param {Array<{messageId, subject, sender, receivedAt, icloudUrls, caption}>} emails
 */
export async function appendScanLog(emails) {
  if (!emails.length) return;

  try {
    await mkdir(DATA_DIR, { recursive: true });

    let existing = [];
    try {
      const raw = await readFile(LOG_FILE, 'utf8');
      existing = JSON.parse(raw);
      if (!Array.isArray(existing)) existing = [];
    } catch { /* first run or corrupt file — start fresh */ }

    const existingIds = new Set(existing.map((e) => e.messageId));

    const newEntries = emails
      .filter((e) => !existingIds.has(e.messageId))
      .map((e) => ({
        scannedAt:  new Date().toISOString(),
        messageId:  e.messageId,
        subject:    e.subject,
        sender:     e.sender,
        receivedAt: e.receivedAt,
        icloudUrls: e.icloudUrls,
        caption:    e.caption || null,
        urlCount:   e.icloudUrls.length,
      }));

    if (!newEntries.length) return; // nothing new to write

    const merged = [...newEntries, ...existing].slice(0, MAX_ENTRIES);
    await writeFile(LOG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.warn('[scan-log] write failed:', err.message);
  }
}
