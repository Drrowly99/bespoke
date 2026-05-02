import { resolveICloudAssets, fetchExifSlice, extractShareToken } from '../icloud/downloader.js';
import { extractGeolocation, extractExifDate } from '../icloud/exif.js';
import { uploadToGooglePhotos, buildAlbumName, createAlbumForUser } from '../photos/uploader.js';
import { setCurrentItem, setCurrentUpload, incrementDone } from './sync-state.js';
import supabase from '../config/supabase.js';
import { logger } from '../utils/logger.js';

// ── Per-user sequential job lock ──────────────────────────────────────────────
// Ensures only one album processes at a time per user, preventing Google Photos
// rate limit issues when multiple links are submitted simultaneously.
const userJobChain = new Map();

function withUserLock(userId, fn) {
  const prev = userJobChain.get(userId) || Promise.resolve();
  let release;
  const gate = new Promise(r => { release = r; });
  userJobChain.set(userId, prev.then(() => gate));
  return prev.then(() => fn()).finally(() => release());
}

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

  // Reset partial upload failures so they can resume from where they left off.
  // Only rows where an album was already created and at least 1 file was saved —
  // meaning the failure was mid-upload (rate limit, transient error) not a bad link.
  const { data: partial } = await supabase
    .from('processed_emails')
    .update({ status: 'pending' })
    .eq('user_id', userId)
    .eq('status', 'failed')
    .not('google_album_id', 'is', null)
    .gt('uploaded_assets', 0)
    .select('id');

  if (partial?.length) {
    console.log(`[PIPELINE] RESUME — reset ${partial.length} partial-upload failure(s) failed→pending`);
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
    await withUserLock(userId, () => processLink(userId, row.id, {
      subject: row.subject,
      sender: row.sender,
      caption: row.caption,
      body: row.description,
      receivedAt: row.received_at,
      icloudUrl: row.icloud_url,
      linkIndex: row.link_index ?? 0,
      totalLinks: row.total_links ?? 1,
    }));
  }
}

export async function processDirectLink(userId, icloudUrlOrUrls, { albumName = null } = {}) {
  const icloudUrls = Array.isArray(icloudUrlOrUrls) ? icloudUrlOrUrls : [icloudUrlOrUrls];
  const normalizedUrls = icloudUrls.filter(Boolean);
  const shareToken = normalizedUrls.length === 1 ? extractShareToken(normalizedUrls[0]) : null;
  console.log(`[PIPELINE] Direct link — urls=${normalizedUrls.length}${shareToken ? ` token=${shareToken}` : ''}${albumName ? ` | album="${albumName}"` : ''}`);

  const manualMessageId = `manual:${Date.now()}:${normalizedUrls.length}`;
  const messageIcloudUrl = normalizedUrls.join('\n');
  const rowShareToken = normalizedUrls.length === 1 ? shareToken : manualMessageId;

  const { data: queued, error: queueError } = await supabase
    .from('processed_emails')
    .insert({
      user_id: userId,
      message_id: manualMessageId,
      sender: null,
      subject: albumName || 'Manual trigger',
      caption: albumName || null,
      icloud_url: messageIcloudUrl,
      share_token: rowShareToken,
      description: null,
      received_at: new Date().toISOString(),
      link_index: 0,
      total_links: normalizedUrls.length,
      status: 'pending',
    })
    .select('id')
    .single();

  if (queueError) {
    if (queueError.code === '23505') {
      console.log(`[PIPELINE] SKIP — already in DB token=${shareToken ?? normalizedUrls[0] ?? manualMessageId}`);
      return;
    }
    console.error(`[PIPELINE] Queue error — ${queueError.message}`);
    return;
  }

  console.log(`[PIPELINE] QUEUED row=${queued.id}`);
  await withUserLock(userId, () => processLink(userId, queued.id, {
    subject: albumName || 'Manual trigger',
    sender: null,
    caption: albumName || null,
    body: null,
    receivedAt: new Date().toISOString(),
    icloudUrls: normalizedUrls,
    linkIndex: 0,
    totalLinks: normalizedUrls.length,
    albumName,
  }));
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
    await withUserLock(userId, () => processLink(userId, queued.id, {
      messageId, subject, sender, caption, body, receivedAt,
      icloudUrl,
      linkIndex: idx,
      totalLinks: icloudUrls.length,
    }));
  }
}

// ── Internal processing ───────────────────────────────────────────────────────

async function processLink(userId, rowId, { subject, sender, caption, body, receivedAt, icloudUrl = null, icloudUrls = null, linkIndex = 0, totalLinks = 1, albumName = null } = {}) {
  // Claim the pending row — move to 'processing'
  const { error: claimError } = await supabase
    .from('processed_emails')
    .update({ status: 'processing' })
    .eq('id', rowId)
    .eq('status', 'pending')
    .select('id')
    .single();

  if (claimError) {
    console.error(`[PIPELINE] Claim failed row=${rowId} — ${claimError.message}`);
    return;
  }

  // Read any progress saved by a previous attempt (album ID, already-uploaded files)
  const { data: savedRow } = await supabase
    .from('processed_emails')
    .select('google_album_id, upload_manifest, asset_manifest')
    .eq('id', rowId)
    .single();

  const sourceUrls = (icloudUrls?.length
    ? icloudUrls
    : String(icloudUrl || '')
        .split(/[\n\r]+/)
        .map(u => u.trim())
        .filter(Boolean)
  ).filter(Boolean);
  const shareToken = extractShareToken(icloudUrl || sourceUrls[0] || '');
  console.log(`[PIPELINE] START row=${rowId} token=${shareToken ?? 'n/a'}`);

  // Resume state from previous attempt
  let googleAlbumId  = savedRow?.google_album_id  || null;
  let savedManifest  = savedRow?.upload_manifest  || [];
  const alreadyDone  = new Set(savedManifest.filter(e => e.status === 'saved').map(e => e.filename));
  if (alreadyDone.size) {
    console.log(`[PIPELINE] RESUME — ${alreadyDone.size} files already saved, continuing from there`);
  }

  let status = 'processing';
  let googleAlbumUrl = null;
  let geolocationData = null;
  let errorReason = null;
  let totalAssets = 0;
  let uploadedAssets = alreadyDone.size; // count already-saved files toward total
  let assetManifest = savedRow?.asset_manifest || null;
  let uploadManifest = savedManifest;

  try {
    setCurrentItem(userId, `${sender || 'Unknown'} · ${subject || '(no subject)'}`);

    console.log(`[PIPELINE] Resolving iCloud assets…`);
    const resolvedAssets = [];
    for (const url of sourceUrls) {
      const assets = await resolveICloudAssets(url);
      resolvedAssets.push(...assets);
    }

    const assetMap = new Map();
    for (const asset of resolvedAssets) {
      const key = asset.url || asset.filename;
      if (!assetMap.has(key)) assetMap.set(key, asset);
    }

    const assets = Array.from(assetMap.values());
    totalAssets = assets.length;
    assetManifest = assets;

    if (!assets.length) {
      errorReason = 'No downloadable assets (link may be expired or empty)';
      status = 'skipped';
      console.log(`[PIPELINE] SKIP — ${errorReason}`);
    } else {
      console.log(`[PIPELINE] ${assets.length} assets found — reading EXIF…`);

      let exifDate = null;
      let exifChecked = 0;
      for (const asset of assets) {
        if (exifChecked >= 5) break; // only probe the first 5 images
        const isImage = asset.mimeType?.startsWith('image/');
        if (!isImage) continue;
        exifChecked++;
        try {
          const slice = await fetchExifSlice(asset.url);
          if (!geolocationData) {
            const geo = await extractGeolocation(slice);
            if (geo) geolocationData = geo;
          }
          if (!exifDate) {
            exifDate = await extractExifDate(slice);
          }
          if (geolocationData && exifDate) break;
        } catch (err) {
          logger.warn('EXIF slice failed', { filename: asset.filename, message: err.message });
        }
      }

      console.log(`[PIPELINE] Geolocation: ${geolocationData?.address ?? 'none'} | Photo date: ${exifDate ? exifDate.slice(0, 10) : 'none'}`);

      const { data: userSettings } = await supabase
        .from('user_settings')
        .select('album_date_source, album_name_pattern, album_name_include_share_token, album_name_share_token_position')
        .eq('user_id', userId)
        .single();

      const locationHint = caption || subject;
      let resolvedAlbumName = albumName || buildAlbumName(receivedAt, geolocationData, locationHint, {
        dateSource: userSettings?.album_date_source || 'received',
        exifDate,
        pattern: userSettings?.album_name_pattern || undefined,
        shareToken,
        includeShareToken: userSettings?.album_name_include_share_token ?? false,
        shareTokenPosition: userSettings?.album_name_share_token_position || 'suffix',
      });
      if (!albumName && totalLinks > 1) resolvedAlbumName += ` (${linkIndex + 1} of ${totalLinks})`;

      // Pre-create the album and persist its ID BEFORE uploading anything.
      // This way a crash mid-upload still knows which album to resume into.
      if (!googleAlbumId) {
        googleAlbumId = await createAlbumForUser(userId, resolvedAlbumName);
        await supabase
          .from('processed_emails')
          .update({ google_album_id: googleAlbumId })
          .eq('id', rowId);
        console.log(`[PIPELINE] Album ready id=${googleAlbumId} name="${resolvedAlbumName}"`);
      } else {
        console.log(`[PIPELINE] Reusing album id=${googleAlbumId} name="${resolvedAlbumName}"`);
      }

      console.log(`[PIPELINE] Uploading ${assets.length - alreadyDone.size} of ${assets.length} files (${alreadyDone.size} already done)`);

      const { albumUrl, uploadedCount, uploadManifest: uploadLog } = await uploadToGooglePhotos(userId, {
        assets,
        albumId:       googleAlbumId,
        skipFilenames: alreadyDone.size > 0 ? alreadyDone : null,
        description:   body,
        sortBy:        'exif_date',
        onProgress: (filename, current, total) => {
          console.log(`[UPLOAD]   ${current}/${total} — ${filename}`);
          setCurrentUpload(userId, filename, current, total);
        },
        // Save progress to DB after every 50-item batchCreate batch
        onBatchSaved: async (savedEntries) => {
          // Merge new entries with any entries already saved from prior runs
          const merged = [
            ...savedManifest.filter(e => e.status === 'saved'),
            ...savedEntries,
          ];
          uploadManifest = merged;
          uploadedAssets = merged.length;
          await supabase
            .from('processed_emails')
            .update({ upload_manifest: merged, uploaded_assets: merged.length })
            .eq('id', rowId);
          console.log(`[PIPELINE] Progress saved — ${merged.length}/${totalAssets} files done`);
        },
      });

      uploadedAssets = uploadedCount + alreadyDone.size;
      googleAlbumUrl = albumUrl;
      uploadManifest = uploadLog;

      if (uploadedAssets >= totalAssets) {
        status = 'completed';
        incrementDone(userId);
        console.log(`[PIPELINE] DONE — ${uploadedAssets}/${totalAssets} uploaded | ${albumUrl}`);
      } else {
        status = 'failed';
        errorReason = `Partial upload: ${uploadedAssets} of ${totalAssets} files succeeded`;
        console.warn(`[PIPELINE] PARTIAL — ${uploadedAssets}/${totalAssets} | ${albumUrl}`);
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
      google_album_id:  googleAlbumId,
      geolocation: geolocationData,
      property_label: propertyLabel,
      export_ready: status === 'completed',
      total_assets: totalAssets,
      uploaded_assets: uploadedAssets,
      asset_manifest: assetManifest,
      upload_manifest: uploadManifest,
    })
    .eq('id', rowId);

  if (updateError) {
    console.error(`[PIPELINE] Update failed row=${rowId} — ${updateError.message}`);
  } else {
    console.log(`[PIPELINE] SAVED row=${rowId} status=${status} assets=${uploadedAssets}/${totalAssets}`);
  }
}
