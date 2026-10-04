// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The update check: is there a newer sam-ui release on GitHub? It only tells:
// a banner in studio links the release page, and nothing is downloaded or
// installed (the build is not signed yet, #8).
//   - at start, at most once a day (the last check and what it found are kept
//     in userData/update-check.json), never holding up the start;
//   - Help > Check for Updates… always checks, and says "up to date" too;
//   - off with SAM_UI_UPDATE_CHECK=0, or "updateCheck": false in settings.json;
//     a dev run (not packaged) checks at start only with SAM_UI_UPDATE_CHECK=1.
// The request runs here, in the main process, never in the page. A failure
// (offline, rate-limited, a strange answer) is one line in logs/app.log.
// Only a https://github.com/VolksRat71/sam-ui/releases/... link is ever opened.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OWNER_REPO = 'VolksRat71/sam-ui';
const LATEST_URL = `https://api.github.com/repos/${OWNER_REPO}/releases/latest`;
const RELEASES_PATH = `/${OWNER_REPO}/releases`;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10000;

// -- versions ----------------------------------------------------------------

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** "v0.2.0" or "0.3.0-beta.1" → {major, minor, patch, pre: [...]}; anything else → null. */
function parseVersion(s) {
  const m = typeof s === 'string' ? SEMVER.exec(s.trim()) : null;
  if (m == null) return null;
  return {major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] == null ? [] : m[4].split('.')};
}

function comparePre(a, b) {
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length); // a release outranks its prereleases
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn && Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1; // numeric identifiers sort first
    if (!an && a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}

/** Semver precedence: -1, 0 or 1. Both must parse. */
function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (x == null || y == null) throw new Error(`not a version: ${x == null ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  return comparePre(x.pre, y.pre);
}

// -- the release page ----------------------------------------------------------

/** The link, normalised, if it is a sam-ui release page on github.com; else null. */
function releasePageUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const ok =
    u.protocol === 'https:' &&
    u.hostname === 'github.com' &&
    u.port === '' &&
    u.username === '' &&
    u.password === '' &&
    (u.pathname === RELEASES_PATH || u.pathname.startsWith(`${RELEASES_PATH}/`));
  return ok ? u.href : null;
}

// -- one check -----------------------------------------------------------------

/**
 * What a /releases/latest answer means for the running version:
 *   {state: 'available', release: {version, tag, name, url}}
 *   {state: 'current', latest}            nothing newer (latest: its version, or null)
 *   {state: 'failed', reason}             an answer that cannot be used
 * A prerelease (flagged, or a -suffix tag) counts only when the app is one.
 */
function interpretRelease(json, currentVersion) {
  const current = parseVersion(currentVersion);
  if (current == null) return {state: 'failed', reason: `the app's version ${JSON.stringify(currentVersion)} is not semver`};
  if (json == null || typeof json !== 'object' || Array.isArray(json)) return {state: 'failed', reason: 'the answer is not a release'};
  if (json.draft === true) return {state: 'current', latest: null};
  const tag = json.tag_name;
  const v = parseVersion(tag);
  if (v == null) return {state: 'failed', reason: `the latest release's tag ${JSON.stringify(tag)} is not a version`};
  const prerelease = json.prerelease === true || v.pre.length > 0;
  if (prerelease && current.pre.length === 0) return {state: 'current', latest: null};
  const version = String(tag).trim().replace(/^v/, '');
  if (compareVersions(v, current) <= 0) return {state: 'current', latest: version};
  const url = releasePageUrl(json.html_url);
  if (url == null) return {state: 'failed', reason: `the release link ${JSON.stringify(json.html_url)} is not a sam-ui release page`};
  const name = typeof json.name === 'string' && json.name.trim() ? json.name.trim().slice(0, 120) : `sam-ui v${version}`;
  return {state: 'available', release: {version, tag: String(tag).trim(), name, url}};
}

/** GET /releases/latest and interpret it. Never throws: a failure is {state: 'failed', reason}. */
async function checkLatest({currentVersion, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, url = LATEST_URL}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // raced as well as passed as the signal, in case a fetch does not honour it
  const aborted = new Promise((_resolve, reject) => ctrl.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const inTime = p => Promise.race([p, aborted]);
  try {
    let res;
    try {
      res = await inTime(fetch(url, {
        signal: ctrl.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `sam-ui/${currentVersion} (+https://github.com/${OWNER_REPO})`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }));
    } catch (err) {
      return {state: 'failed', reason: ctrl.signal.aborted ? `timed out after ${timeoutMs} ms` : `offline? ${err?.message ?? err}`};
    }
    const header = name => (typeof res.headers?.get === 'function' ? res.headers.get(name) : null);
    if (res.status === 404) return {state: 'current', latest: null}; // no release published yet
    if (res.status === 403 || res.status === 429) {
      const left = header('x-ratelimit-remaining');
      const reset = Number(header('x-ratelimit-reset'));
      if (res.status === 429 || left === '0') {
        const until = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : '';
        return {state: 'failed', reason: `rate-limited by GitHub${until}`};
      }
      return {state: 'failed', reason: 'GitHub refused the request (403)'};
    }
    if (!res.ok) return {state: 'failed', reason: `GitHub answered ${res.status}`};
    let json;
    try {
      json = JSON.parse(await inTime(res.text()));
    } catch {
      return {state: 'failed', reason: ctrl.signal.aborted ? `timed out after ${timeoutMs} ms` : 'the answer is not JSON'};
    }
    return interpretRelease(json, currentVersion);
  } finally {
    clearTimeout(timer);
  }
}

// -- when to check ---------------------------------------------------------------

const OFF = /^(0|off|false|no)$/i;
const ON = /^(1|on|true|yes)$/i;

/** Whether the start-up check runs (the menu item always does). */
function autoCheckEnabled({env = process.env, settings = {}, packaged}) {
  const v = (env.SAM_UI_UPDATE_CHECK ?? '').trim();
  if (OFF.test(v)) return false;
  if (settings?.updateCheck === false) return false;
  return packaged || ON.test(v);
}

/** True when the last successful check is under a day old (a clock that went back counts as stale). */
function checkedRecently(lastCheckedAt, now) {
  return Number.isFinite(lastCheckedAt) && lastCheckedAt <= now && now - lastCheckedAt < DAY_MS;
}

// -- state and log ---------------------------------------------------------------

/** {read, write} over one JSON file; a missing or broken file reads as {}. */
function fileStore(file) {
  return {
    read() {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return v != null && typeof v === 'object' && !Array.isArray(v) ? v : {};
      } catch {
        return {};
      }
    },
    write(state) {
      try {
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, JSON.stringify(state, null, 1));
      } catch {
        // not kept: the next start checks again
      }
    },
  };
}

function fileLogger(file) {
  return line => {
    try {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.appendFileSync(file, `${new Date().toISOString()} update-check: ${line}\n`);
    } catch {
      // nowhere to log; never worth failing over
    }
  };
}

// -- the checker -----------------------------------------------------------------

/**
 * The start-up and menu checks, with the once-a-day rule and the dismissed
 * version. `pending()` is the release the banner shows (or null).
 */
function createUpdateChecker({currentVersion, fetch, store, log = () => {}, now = Date.now, autoCheck = true, timeoutMs}) {
  let pending = null;

  const usable = release => {
    // a release kept in the state file is checked again before it is shown
    if (release == null || typeof release !== 'object') return null;
    const v = parseVersion(release.version);
    const cur = parseVersion(currentVersion);
    const url = releasePageUrl(release.url);
    if (v == null || cur == null || url == null || compareVersions(v, cur) <= 0) return null;
    if (v.pre.length > 0 && cur.pre.length === 0) return null;
    return {version: String(release.version), tag: String(release.tag ?? `v${release.version}`), name: String(release.name ?? ''), url};
  };

  async function fetchAndKeep() {
    const result = await checkLatest({currentVersion, fetch, ...(timeoutMs ? {timeoutMs} : {})});
    if (result.state === 'failed') {
      log(`check failed: ${result.reason}`);
      return result;
    }
    const state = store.read();
    store.write({...state, lastCheckedAt: now(), latest: result.state === 'available' ? result.release : null});
    log(result.state === 'available' ? `${result.release.version} is available (running ${currentVersion})` : `up to date (${currentVersion})`);
    return result;
  }

  return {
    /** At start: at most once a day, quiet, and nothing for a dismissed version. */
    async startup() {
      if (!autoCheck) {
        log('start-up check is off');
        return null;
      }
      const state = store.read();
      let release;
      if (checkedRecently(state.lastCheckedAt, now())) {
        release = usable(state.latest);
      } else {
        const result = await fetchAndKeep();
        release = result.state === 'available' ? result.release : null;
      }
      // A manual check can show and dismiss this release while startup waits.
      if (release != null && release.version === store.read().dismissed) return null;
      if (release != null) pending = release;
      return release;
    },
    /** From the menu: always asks GitHub; shows the banner even for a dismissed version. */
    async now() {
      const result = await fetchAndKeep();
      if (result.state === 'available') pending = result.release;
      else if (result.state === 'current') pending = null;
      return result;
    },
    pending: () => pending,
    /** The banner's close: that version stays quiet at start; a newer one shows again. */
    dismiss(version) {
      if (pending == null || pending.version !== version) return false;
      store.write({...store.read(), dismissed: version});
      pending = null;
      return true;
    },
  };
}

module.exports = {
  LATEST_URL,
  DAY_MS,
  parseVersion,
  compareVersions,
  releasePageUrl,
  interpretRelease,
  checkLatest,
  autoCheckEnabled,
  checkedRecently,
  fileStore,
  fileLogger,
  createUpdateChecker,
};
