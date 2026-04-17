import { resolveICloudAssets, fetchExifSlice, extractShareToken } from '../icloud/downloader.js';
import { extractGeolocation, extractExifDate } from '../icloud/exif.js';
import { uploadToGooglePhotos, buildAlbumName } from '../photos/uploader.js';
import { setCurrentItem, setCurrentUpload, incrementDone } from './sync-state.js';
import supabase from '../config/supabase.js';
import { logger } from '../utils/logger.js';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called at the start of every poll cycle.
 * 1. Resets rows stuck in 'processing' for > 30 min back to 'pending'
 *    (covers server crashes / OOM kills mid-upload).
 * 2. Processes any 'pending' rows that were never claimed
 *    (covers restarts that happened after INSERT but before processLink ran).
 */
export async function resumePendingLinks(userId) {
  const staleThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: reset } = await supabase
    .from('processed_emails')
    .update({ status: 'pending' })
    .eq('user_id', userId)
    .eq('status', 'processing')
    .lt('created_at', staleThreshold)
    .select('id');

  if (reset?.length) {
    console.log(`[PIPELINE] RESUME — reset ${reset.length} stuck row(s) processing→pending`);
  }

  const { data: pending, error } = await supabase
    .from('processed_emails')
    .select('id, icloud_url, sender, subject, caption, description, received_at, link_index, total_links')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) {
    console.error(`[PIPELINE] Resume query error — ${error.message}`);
    return;
  }

  if (!pending?.length) return;

  console.log(`[PIPELINE] RESUME — ${pending.length} pending row(s) found, processing…`);

  for (const row of pending) {
    await processLink(userId, row.id, {
      subject: row.subject,
      sender: row.sender,
      caption: row.caption,
      body: row.description,
      receivedAt: row.received_at,
      icloudUrl: row.icloud_url,
      linkIndex: row.link_index ?? 0,
      totalLinks: row.total_links ?? 1,
    });
  }
}

export async function processDirectLink(userId, icloudUrl, { albumName = null } = {}) {
  const shareToken = extractShareToken(icloudUrl);
  console.log(`[PIPELINE] Direct link — token=${shareToken ?? 'n/a'}${albumName ? ` | album="${albumName}"` : ''}`);

  const { data: queued, error: queueError } = await supabase
    .from('processed_emails')
    .insert({
      user_id: userId,
      message_id: icloudUrl,
      sender: null,
      subject: albumName || 'Manual trigger',
      caption: albumName || null,
      icloud_url: icloudUrl,
      share_token: shareToken,
      description: null,
      received_at: new Date().toISOString(),
      link_index: 0,
      total_links: 1,
      status: 'pending',
    })
    .select('id')
    .single();

  if (queueError) {
    if (queueError.code === '23505') {
      console.log(`[PIPELINE] SKIP — already in DB token=${shareToken ?? icloudUrl}`);
      return;
    }
    console.error(`[PIPELINE] Queue error — ${queueError.message}`);
    return;
  }

  console.log(`[PIPELINE] QUEUED row=${queued.id}`);
  await processLink(userId, queued.id, {
    subject: albumName || 'Manual trigger',
    sender: null,
    caption: albumName || null,
    body: null,
    receivedAt: new Date().toISOString(),
    icloudUrl,
    linkIndex: 0,
    totalLinks: 1,
  });
}

export async function processEmail(userId, emailData) {
  const { messageId, subject, sender, caption, body, icloudUrls, receivedAt } = emailData;
  console.log(`[PIPELINE] Email — msgId=${messageId} | links=${icloudUrls.length}`);

  for (let idx = 0; idx < icloudUrls.length; idx++) {
    const icloudUrl = icloudUrls[idx];
    const shareToken = extractShareToken(icloudUrl);

    // Insert as 'pending' — unique constraint on (user_id, share_token) prevents re-queuing
    const { data: queued, error: queueError } = await supabase
      .from('processed_emails')
      .insert({
        user_id: userId,
        message_id: messageId,
        sender,
        subject,
        caption,
        icloud_url: icloudUrl,
        share_token: shareToken,
        description: body,
        received_at: receivedAt,
        link_index: idx,
        total_links: icloudUrls.length,
        status: 'pending',
      })
      .select('id')
      .single();

    if (queueError) {
      if (queueError.code === '23505') {
        console.log(`[PIPELINE] SKIP — already in DB token=${shareToken ?? icloudUrl}`);
        continue;
      }
      console.error(`[PIPELINE] Queue error — ${queueError.message}`);
      continue;
    }

    console.log(`[PIPELINE] QUEUED row=${queued.id} token=${shareToken}`);
    await processLink(userId, queued.id, {
      messageId, subject, sender, caption, body, receivedAt,
      icloudUrl,
      linkIndex: idx,
      totalLinks: icloudUrls.length,
    });
  }
}

// ── Internal processing ───────────────────────────────────────────────────────

async function processLink(userId, rowId, { subject, sender, caption, body, receivedAt, icloudUrl, linkIndex, totalLinks }) {
  // Claim the pending row move to 'processing'
  const { error: claimError } = await supabase
    .from('processed_emails')
    .update({ status: 'processing' })
    .eq('id', rowId)
    .eq('status', 'pending');

  if (claimError) {
    console.error(`[PIPELINE] Claim failed row=${rowId} — ${claimError.message}`);
    return;
  }

  const shareToken = extractShareToken(icloudUrl);
  console.log(`[PIPELINE] START row=${rowId} token=${shareToken ?? 'n/a'}`);

  let status = 'processing';
  let googleAlbumUrl = null;
  let geolocationData = null;
  let errorReason = null;
  let totalAssets = 0;
  let uploadedAssets = 0;

  try {
    setCurrentItem(userId, `${sender || 'Unknown'} · ${subject || '(no subject)'}`);

    console.log(`[PIPELINE] Resolving iCloud assets…`);
    const assets = await resolveICloudAssets(icloudUrl);
    totalAssets = assets.length;

    if (!assets.length) {
      errorReason = 'No downloadable assets (link may be expired or empty)';
      status = 'skipped';
      console.log(`[PIPELINE] SKIP — ${errorReason}`);
    } else {
      console.log(`[PIPELINE] ${assets.length} assets found — reading EXIF…`);

      let exifDate = null;
      for (const asset of assets) {
        try {
          const slice = await fetchExifSlice(asset.url);
          // Extract geolocation and taken-date from the same EXIF slice
          if (!geolocationData) {
            const geo = await extractGeolocation(slice);
            if (geo) geolocationData = geo;
          }
          if (!exifDate) {
            exifDate = await extractExifDate(slice);
          }
          if (geolocationData && exifDate) break; // got everything we need
        } catch (err) {
          logger.warn('EXIF slice failed', { filename: asset.filename, message: err.message });
        }
      }

      console.log(`[PIPELINE] Geolocation: ${geolocationData?.address ?? 'none'} | Photo date: ${exifDate ? exifDate.slice(0, 10) : 'none'}`);

      // Load per-user album naming preferences
      const { data: userSettings } = await supabase
        .from('user_settings')
        .select('album_date_source, album_name_pattern')
        .eq('user_id', userId)
        .single();

      const locationHint = caption || subject;
      let albumName = buildAlbumName(receivedAt, geolocationData, locationHint, {
        dateSource: userSettings?.album_date_source || 'received',
        exifDate,
        pattern: userSettings?.album_name_pattern || undefined,
      });
      if (totalLinks > 1) albumName += ` (${linkIndex + 1} of ${totalLinks})`;

      console.log(`[PIPELINE] Uploading ${assets.length} files album="${albumName}"`);

      const { albumUrl, uploadedCount } = await uploadToGooglePhotos(userId, {
        assets,
        albumName,
        description: body,
        sortBy: 'exif_date',
        onProgress: (filename, current, total) => {
          console.log(`[UPLOAD]   ${current}/${total} — ${filename}`);
          setCurrentUpload(userId, filename, current, total);
        },
      });

      uploadedAssets = uploadedCount;
      googleAlbumUrl = albumUrl;

      if (uploadedCount >= assets.length) {
        status = 'completed';
        incrementDone(userId);
        console.log(`[PIPELINE] DONE — ${uploadedCount}/${assets.length} uploaded | ${albumUrl}`);
      } else {
        status = 'failed';
        errorReason = `Partial upload: ${uploadedCount} of ${assets.length} files succeeded`;
        console.warn(`[PIPELINE] PARTIAL — ${uploadedCount}/${assets.length} | ${albumUrl}`);
      }
    }
  } catch (err) {
    errorReason = err.message;
    status = 'failed';
    console.error(`[PIPELINE] ERROR row=${rowId} — ${err.message}`);
    logger.error('Pipeline error', { rowId, message: err.message });
  }

  const propertyLabel = geolocationData?.address
    ? geolocationData.address.split(',').slice(0, 2).join(',').trim()
    : (caption || subject || null);

  const { error: updateError } = await supabase
    .from('processed_emails')
    .update({
      status,
      error_reason: errorReason,
      google_album_url: googleAlbumUrl,
      geolocation: geolocationData,
      property_label: propertyLabel,
      export_ready: status === 'completed',
      total_assets: totalAssets,
      uploaded_assets: uploadedAssets,
    })
    .eq('id', rowId);

  if (updateError) {
    console.error(`[PIPELINE] Update failed row=${rowId} — ${updateError.message}`);
  } else {
    console.log(`[PIPELINE] SAVED row=${rowId} status=${status} assets=${uploadedAssets}/${totalAssets}`);
  }
}
