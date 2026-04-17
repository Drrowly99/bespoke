/**
 * In-memory per-user sync state tracker.
 * Lets the progress API report what is happening right now.
 *
 * State shape:
 *  { running, phase, startedAt, found, done, currentItem, lastRunAt, lastRunFound, lastRunDone }
 *
 * Phases: 'scanning' → finding emails | 'processing' → uploading | 'idle'
 */

const states = new Map();

function get(userId) {
  return states.get(userId) || {
    running: false, phase: 'idle',
    startedAt: null, found: 0, done: 0, currentItem: null,
    lastRunAt: null, lastRunFound: 0, lastRunDone: 0,
  };
}

export function startRun(userId) {
  const prev = get(userId);
  states.set(userId, {
    ...prev,
    running: true, phase: 'scanning',
    startedAt: Date.now(), found: 0, done: 0, currentItem: null,
  });
}

export function setFound(userId, count) {
  const s = get(userId);
  states.set(userId, { ...s, found: count, phase: count > 0 ? 'processing' : s.phase });
}

export function setCurrentItem(userId, label) {
  const s = get(userId);
  states.set(userId, { ...s, currentItem: label, phase: 'processing', uploadCurrent: 0, uploadTotal: 0 });
}

export function setCurrentUpload(userId, filename, current, total) {
  const s = get(userId);
  states.set(userId, {
    ...s,
    currentItem:   `${filename} (${current}/${total})`,
    uploadCurrent: current,
    uploadTotal:   total,
  });
}

export function incrementDone(userId) {
  const s = get(userId);
  states.set(userId, { ...s, done: s.done + 1 });
}

export function endRun(userId) {
  const s = get(userId);
  states.set(userId, {
    ...s,
    running: false, phase: 'idle', currentItem: null,
    lastRunAt: Date.now(),
    lastRunFound: s.found,
    lastRunDone: s.done,
  });
}

export function getState(userId) {
  return get(userId);
}
