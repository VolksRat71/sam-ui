// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// A desktop notification when a long job finishes while you are elsewhere.
// Jobs know nothing about it: studio tells main a job ended (app-preload.js,
// `jobs.done`), and this decides. It shows one only when the setting is on
// (sam-ui > Notify When a Track Finishes, "notifyJobDone" in settings.json)
// and the window is not focused. A click brings the window back and hands
// studio the job's objects, and studio jumps to their first unreviewed
// review-queue stop, else the start of the track.
// The page sends ids and one object's name, never the text: main writes that.
// One notification at a time: a new one replaces the last, and jobs ending
// within a few seconds of a shown one are folded into it (not shown again).
'use strict';

const KINDS = new Set(['track']);
const ENGINES = new Set(['sam2', 'sam3', 'browser-sam2']);
const MIN_GAP_MS = 5000;
const MAX_IDS = 256;
const MAX_NAME = 60;

/** The setting: off unless settings.json says "notifyJobDone": true. */
function notifyEnabled(settings) {
  return settings?.notifyJobDone === true;
}

/** The page's {kind, ok, objectIds, name} as main uses it, or null for anything else. */
function parseJobDone(x) {
  if (x == null || typeof x !== 'object' || Array.isArray(x)) return null;
  const {kind, ok, engine, objectIds, name} = x;
  if (!KINDS.has(kind) || !ENGINES.has(engine) || typeof ok !== 'boolean') return null;
  if (!Array.isArray(objectIds) || objectIds.length === 0 || objectIds.length > MAX_IDS) return null;
  if (!objectIds.every(id => Number.isSafeInteger(id) && id >= 0)) return null;
  const label = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NAME) : '';
  return {kind, ok, engine, objectIds: [...objectIds], name: label || `Object ${objectIds[0] + 1}`};
}

/** The notification's words, all chosen here. */
function notificationText({ok, objectIds, name}) {
  const who = objectIds.length > 1 ? `${name} and ${objectIds.length - 1} more` : name;
  return ok
    ? {title: 'Track finished', body: `${who}: ready to review.`}
    : {title: 'Track failed', body: `${who}: the track did not finish.`};
}

/**
 * jobDone(payload) → true when it showed a notification.
 *   Notification  Electron's class (or a fake with on/show/close)
 *   enabled()     the setting, read on every call
 *   getWindow()   the main window, or null once it is gone
 * jobDone.showing() is the notification on screen, or null.
 */
function createJobNotifier({Notification, enabled, getWindow, now = Date.now}) {
  // macOS drops the click of a notification nothing references any more, so
  // the one on screen is kept here until it is clicked, closed or replaced
  let showing = null;
  let shownAt = -Infinity;
  const forget = n => {
    if (showing === n) showing = null;
  };
  function jobDone(payload) {
    const job = parseJobDone(payload);
    const win = getWindow();
    if (job == null || win == null || !enabled() || win.isFocused()) return false;
    if (now() - shownAt < MIN_GAP_MS) return false;
    showing?.close();
    const n = new Notification(notificationText(job));
    showing = n;
    shownAt = now();
    n.on('close', () => forget(n));
    n.on('click', () => {
      forget(n);
      const w = getWindow();
      if (w == null) return;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      w.webContents.send('jobs:open', {kind: job.kind, engine: job.engine, objectIds: job.objectIds});
    });
    n.show();
    return true;
  }
  jobDone.showing = () => showing;
  return jobDone;
}

module.exports = {notifyEnabled, parseJobDone, notificationText, createJobNotifier};
