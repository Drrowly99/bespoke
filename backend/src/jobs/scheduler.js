/**
 * Polling scheduler — runs the Gmail poll + pipeline for all active users
 * on a configurable interval. Per-user enable/disable is respected.
 */
import supabase from '../config/supabase.js';
import { fetchNewICloudEmails } from '../gmail/poller.js';
import { processEmail, resumePendingLinks } from './pipeline.js';
import { startRun, setFound, endRun } from './sync-state.js';
import { appendScanLog } from '../utils/scan-log.js';
import { logger } from '../utils/logger.js';

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '180000', 10); // 3 min default

let schedulerHandle = null;

export function startPollingScheduler() {
  if (schedulerHandle) return;
  logger.info('Polling scheduler started', { intervalMs: POLL_INTERVAL });
  schedulerHandle = setInterval(runPollCycle, POLL_INTERVAL);
  // Run immediately on startup
  runPollCycle();
}

export function stopPollingScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    logger.info('Polling scheduler stopped');
  }
}

async function runPollCycle() {
  logger.info('Poll cycle starting');
  try {
    // Join with users to skip locked accounts — no polling for locked users
    const { data: activeUsers, error } = await supabase
      .from('user_settings')
      .select('user_id, users!inner(is_locked)')
      .eq('icloud_sync_enabled', true)
      .eq('users.is_locked', false);

    if (error) {
      logger.error('Failed to fetch active users', { message: error.message });
      return;
    }

    for (const { user_id } of (activeUsers || [])) {
      await pollUser(user_id);
    }
  } catch (err) {
    logger.error('Poll cycle error', { message: err.message });
  }
  logger.info('Poll cycle complete');
}

async function pollUser(userId) {
  startRun(userId);
  try {
    // Resume any work that was interrupted (crash, restart, partial upload)
    await resumePendingLinks(userId);

    const emails = await fetchNewICloudEmails(userId);
    logger.info('Emails found for user', { userId, count: emails.length });
    setFound(userId, emails.length);

    // Write debug log — new messages only, last 15, no re-entries
    await appendScanLog(emails);

    for (const email of emails) {
      await processEmail(userId, email);
    }

    if (emails.length > 0) {
      await supabase.from('users').update({ last_sync: new Date().toISOString() }).eq('id', userId);
    }
  } catch (err) {
    logger.error('Error polling user', { userId, message: err.message });
    if (err.message.includes('invalid_grant') || err.message.includes('401')) {
      await supabase
        .from('user_settings')
        .update({ icloud_sync_enabled: false, sync_status: 'token_error' })
        .eq('user_id', userId);
      logger.warn('Paused sync for user due to auth error', { userId });
    }
  } finally {
    endRun(userId);
  }
}

/** Trigger an immediate one-off poll for a single user (used by run-now API). */
export async function pollUserNow(userId) {
  return pollUser(userId);
}
