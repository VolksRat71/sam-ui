// sam-ui (Apache-2.0). New file, not from SAM 2.
// node --test test/update-check.test.js   (no network: every fetch here is fake)
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {describe, test} = require('node:test');

const {
  DAY_MS,
  LATEST_URL,
  autoCheckEnabled,
  checkLatest,
  checkedRecently,
  compareVersions,
  createUpdateChecker,
  fileStore,
  interpretRelease,
  parseVersion,
  releasePageUrl,
} = require('../src/update-check');

const page = tag => `https://github.com/VolksRat71/sam-ui/releases/tag/${tag}`;
const release = (tag, extra = {}) => ({tag_name: tag, html_url: page(tag), name: `sam-ui ${tag}`, draft: false, prerelease: false, ...extra});

/** A fetch that answers once, the way GitHub would; it records what it was asked. */
function fakeFetch(status, body, headers = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({url, init});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {get: k => headers[k.toLowerCase()] ?? null},
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  fn.calls = calls;
  return fn;
}

/** A fetch that never answers until it is aborted. */
const hangingFetch = (_url, {signal}) =>
  new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))));

const memoryStore = (init = {}) => {
  let state = {...init};
  return {read: () => ({...state}), write: s => (state = {...s}), get state() {
    return state;
  }};
};

describe('versions', () => {
  test('parse with or without the v, with a prerelease and build', () => {
    assert.deepStrictEqual(parseVersion('v0.2.0'), {major: 0, minor: 2, patch: 0, pre: []});
    assert.deepStrictEqual(parseVersion('1.10.3-beta.2+sha.abc'), {major: 1, minor: 10, patch: 3, pre: ['beta', '2']});
    for (const bad of ['0.2', 'v01.2.0', 'latest', '', null, 2, '0.2.0-', '0.2.0.1']) assert.strictEqual(parseVersion(bad), null, String(bad));
  });

  test('compare by semver precedence, numerically', () => {
    assert.strictEqual(compareVersions('0.3.0', '0.2.0'), 1);
    assert.strictEqual(compareVersions('v0.2.0', '0.2.0'), 0);
    assert.strictEqual(compareVersions('0.2.0', '0.10.0'), -1);
    assert.strictEqual(compareVersions('1.0.0', '0.99.99'), 1);
    assert.strictEqual(compareVersions('0.3.0-beta.1', '0.3.0'), -1); // a release outranks its prereleases
    assert.strictEqual(compareVersions('0.3.0-beta.2', '0.3.0-beta.10'), -1);
    assert.strictEqual(compareVersions('0.3.0-alpha', '0.3.0-alpha.1'), -1);
    assert.strictEqual(compareVersions('0.3.0-1', '0.3.0-alpha'), -1); // numeric identifiers sort first
    assert.strictEqual(compareVersions('0.3.0+build.9', '0.3.0'), 0);
    assert.throws(() => compareVersions('nope', '0.2.0'), /not a version/);
  });
});

describe('the release link', () => {
  test('only https://github.com/VolksRat71/sam-ui/releases/...', () => {
    assert.strictEqual(releasePageUrl(page('v0.3.0')), page('v0.3.0'));
    assert.strictEqual(releasePageUrl('https://github.com/VolksRat71/sam-ui/releases'), 'https://github.com/VolksRat71/sam-ui/releases');
    for (const bad of [
      'http://github.com/VolksRat71/sam-ui/releases/tag/v0.3.0',
      'https://github.com.evil.io/VolksRat71/sam-ui/releases/tag/v0.3.0',
      'https://evil.io/VolksRat71/sam-ui/releases/tag/v0.3.0',
      'https://github.com/VolksRat71/sam-ui-evil/releases/tag/v0.3.0',
      'https://github.com/VolksRat71/sam-ui/releasesx',
      'https://github.com/VolksRat71/sam-ui/releases/../../../evil/repo',
      'https://github.com/VolksRat71/sam-ui/releases/%2e%2e/%2e%2e/%2e%2e/evil',
      'https://user@github.com/VolksRat71/sam-ui/releases/tag/v0.3.0',
      'https://github.com:8443/VolksRat71/sam-ui/releases/tag/v0.3.0',
      'https://github.com/VolksRat71/sam-ui/issues/9',
      'javascript:alert(1)',
      'not a url',
      undefined,
    ]) {
      assert.strictEqual(releasePageUrl(bad), null, String(bad));
    }
  });
});

describe('interpreting /releases/latest', () => {
  test('newer, same, older', () => {
    assert.deepStrictEqual(interpretRelease(release('v0.3.0'), '0.2.0'), {
      state: 'available',
      release: {version: '0.3.0', tag: 'v0.3.0', name: 'sam-ui v0.3.0', url: page('v0.3.0')},
    });
    assert.deepStrictEqual(interpretRelease(release('v0.2.0'), '0.2.0'), {state: 'current', latest: '0.2.0'});
    assert.deepStrictEqual(interpretRelease(release('v0.1.4'), '0.2.0'), {state: 'current', latest: '0.1.4'});
  });

  test('a prerelease counts only when the app is one', () => {
    assert.strictEqual(interpretRelease(release('v0.3.0', {prerelease: true}), '0.2.0').state, 'current');
    assert.strictEqual(interpretRelease(release('v0.3.0-beta.1'), '0.2.0').state, 'current'); // tagged, not flagged
    assert.strictEqual(interpretRelease(release('v0.3.0-beta.2', {prerelease: true}), '0.3.0-beta.1').state, 'available');
    assert.strictEqual(interpretRelease(release('v0.3.0'), '0.3.0-beta.1').state, 'available'); // and the release after it
  });

  test('a draft, a bad tag, a bad link, a bad app version', () => {
    assert.strictEqual(interpretRelease(release('v0.3.0', {draft: true}), '0.2.0').state, 'current');
    assert.match(interpretRelease(release('nightly'), '0.2.0').reason, /tag "nightly" is not a version/);
    assert.match(interpretRelease(release('v0.3.0', {html_url: 'https://evil.io/x'}), '0.2.0').reason, /not a sam-ui release page/);
    assert.match(interpretRelease(release('v0.3.0'), 'dev').reason, /app's version/);
    assert.strictEqual(interpretRelease([], '0.2.0').state, 'failed');
    assert.strictEqual(interpretRelease(null, '0.2.0').state, 'failed');
  });
});

describe('checkLatest, with a fake fetch', () => {
  test('asks the latest-release endpoint with a User-Agent', async () => {
    const fetch = fakeFetch(200, release('v0.3.0'));
    const r = await checkLatest({currentVersion: '0.2.0', fetch});
    assert.strictEqual(r.state, 'available');
    assert.strictEqual(fetch.calls[0].url, LATEST_URL);
    assert.match(fetch.calls[0].init.headers['User-Agent'], /^sam-ui\/0\.2\.0 /);
    assert.ok(fetch.calls[0].init.signal instanceof AbortSignal);
  });

  test('same and older are up to date', async () => {
    assert.deepStrictEqual(await checkLatest({currentVersion: '0.2.0', fetch: fakeFetch(200, release('v0.2.0'))}), {state: 'current', latest: '0.2.0'});
    assert.deepStrictEqual(await checkLatest({currentVersion: '0.2.0', fetch: fakeFetch(200, release('v0.1.0'))}), {state: 'current', latest: '0.1.0'});
  });

  test('a prerelease is ignored for a release build', async () => {
    const r = await checkLatest({currentVersion: '0.2.0', fetch: fakeFetch(200, release('v0.3.0-rc.1', {prerelease: true}))});
    assert.strictEqual(r.state, 'current');
  });

  test('malformed JSON fails quietly', async () => {
    assert.deepStrictEqual(await checkLatest({currentVersion: '0.2.0', fetch: fakeFetch(200, '<html>oops')}), {
      state: 'failed',
      reason: 'the answer is not JSON',
    });
    assert.strictEqual((await checkLatest({currentVersion: '0.2.0', fetch: fakeFetch(200, {message: 'hi'})})).state, 'failed');
  });

  test('a timeout fails quietly', async () => {
    const t0 = Date.now();
    const r = await checkLatest({currentVersion: '0.2.0', fetch: hangingFetch, timeoutMs: 30});
    assert.deepStrictEqual(r, {state: 'failed', reason: 'timed out after 30 ms'});
    assert.ok(Date.now() - t0 < 2000);
  });

  test('403 rate-limit, 429, a plain 403, a 500, offline', async () => {
    const limited = await checkLatest({
      currentVersion: '0.2.0',
      fetch: fakeFetch(403, {message: 'API rate limit exceeded'}, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000'}),
    });
    assert.deepStrictEqual(limited, {state: 'failed', reason: 'rate-limited by GitHub until 2026-09-21T14:13:20.000Z'});
    assert.match((await checkLatest({currentVersion: '0.2.0', fetch: fakeFetch(429, {})})).reason, /^rate-limited/);
    assert.match((await checkLatest({currentVersion: '0.2.0', fetch: fakeFetch(403, {})})).reason, /refused/);
    assert.match((await checkLatest({currentVersion: '0.2.0', fetch: fakeFetch(500, {})})).reason, /answered 500/);
    const offline = async () => {
      throw new TypeError('fetch failed');
    };
    assert.match((await checkLatest({currentVersion: '0.2.0', fetch: offline})).reason, /^offline\? fetch failed/);
  });

  test('no release yet (404) is up to date', async () => {
    assert.deepStrictEqual(await checkLatest({currentVersion: '0.2.0', fetch: fakeFetch(404, {message: 'Not Found'})}), {state: 'current', latest: null});
  });
});

describe('when to check', () => {
  test('on by default when packaged; off by env or setting; dev needs the env', () => {
    assert.strictEqual(autoCheckEnabled({env: {}, settings: {}, packaged: true}), true);
    for (const v of ['0', 'off', 'FALSE', 'no']) assert.strictEqual(autoCheckEnabled({env: {SAM_UI_UPDATE_CHECK: v}, packaged: true}), false, v);
    assert.strictEqual(autoCheckEnabled({env: {}, settings: {updateCheck: false}, packaged: true}), false);
    assert.strictEqual(autoCheckEnabled({env: {}, settings: {}, packaged: false}), false);
    assert.strictEqual(autoCheckEnabled({env: {SAM_UI_UPDATE_CHECK: '1'}, settings: {}, packaged: false}), true);
  });

  test('once a day; a clock that went back is stale', () => {
    const now = 1_800_000_000_000;
    assert.strictEqual(checkedRecently(now - DAY_MS + 1000, now), true);
    assert.strictEqual(checkedRecently(now - DAY_MS, now), false);
    assert.strictEqual(checkedRecently(now + 60_000, now), false);
    assert.strictEqual(checkedRecently(undefined, now), false);
  });
});

describe('the checker', () => {
  const NOW = 1_800_000_000_000;

  test('start-up: checks, keeps the answer, and shows it', async () => {
    const store = memoryStore();
    const fetch = fakeFetch(200, release('v0.3.0'));
    const c = createUpdateChecker({currentVersion: '0.2.0', fetch, store, now: () => NOW});
    assert.strictEqual((await c.startup()).version, '0.3.0');
    assert.strictEqual(c.pending().url, page('v0.3.0'));
    assert.strictEqual(store.state.lastCheckedAt, NOW);
    assert.strictEqual(store.state.latest.version, '0.3.0');
  });

  test('start-up within a day reuses the last answer without asking GitHub', async () => {
    const store = memoryStore({lastCheckedAt: NOW - 3600_000, latest: {version: '0.3.0', tag: 'v0.3.0', name: 'x', url: page('v0.3.0')}});
    const fetch = fakeFetch(200, release('v9.9.9'));
    const c = createUpdateChecker({currentVersion: '0.2.0', fetch, store, now: () => NOW});
    assert.strictEqual((await c.startup()).version, '0.3.0');
    assert.strictEqual(fetch.calls.length, 0);
  });

  test('a kept answer is checked again: a bad link or an older version is not shown', async () => {
    for (const latest of [{version: '0.3.0', url: 'https://evil.io/'}, {version: '0.1.0', url: page('v0.1.0')}, 'junk']) {
      const c = createUpdateChecker({currentVersion: '0.2.0', fetch: fakeFetch(500, {}), store: memoryStore({lastCheckedAt: NOW - 1, latest}), now: () => NOW});
      assert.strictEqual(await c.startup(), null);
    }
  });

  test('a dismissed version stays quiet at start, a newer one shows, and the menu shows it anyway', async () => {
    const store = memoryStore();
    const c = createUpdateChecker({currentVersion: '0.2.0', fetch: fakeFetch(200, release('v0.3.0')), store, now: () => NOW});
    await c.startup();
    assert.strictEqual(c.dismiss('0.2.9'), false); // not the one shown
    assert.strictEqual(c.dismiss('0.3.0'), true);
    assert.strictEqual(c.pending(), null);
    assert.strictEqual(store.state.dismissed, '0.3.0');

    const later = createUpdateChecker({currentVersion: '0.2.0', fetch: fakeFetch(200, release('v0.3.0')), store, now: () => NOW + DAY_MS});
    assert.strictEqual(await later.startup(), null);
    assert.strictEqual((await later.now()).state, 'available');
    assert.strictEqual(later.pending().version, '0.3.0');

    const newer = createUpdateChecker({currentVersion: '0.2.0', fetch: fakeFetch(200, release('v0.4.0')), store, now: () => NOW + 2 * DAY_MS});
    assert.strictEqual((await newer.startup()).version, '0.4.0');
  });

  test('a failure logs one line, keeps no check time, shows nothing', async () => {
    const lines = [];
    const store = memoryStore();
    const c = createUpdateChecker({currentVersion: '0.2.0', fetch: fakeFetch(403, {}, {'x-ratelimit-remaining': '0'}), store, log: l => lines.push(l), now: () => NOW});
    assert.strictEqual(await c.startup(), null);
    assert.deepStrictEqual(lines, ['check failed: rate-limited by GitHub']);
    assert.strictEqual(store.state.lastCheckedAt, undefined);
  });

  test('off: the start-up check does nothing; the menu still asks', async () => {
    const fetch = fakeFetch(200, release('v0.2.0'));
    const c = createUpdateChecker({currentVersion: '0.2.0', fetch, store: memoryStore(), autoCheck: false, now: () => NOW});
    assert.strictEqual(await c.startup(), null);
    assert.strictEqual(fetch.calls.length, 0);
    assert.deepStrictEqual(await c.now(), {state: 'current', latest: '0.2.0'});
  });
});

test('the state file: a missing or broken one reads as {}', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'samui-upd-'));
  const store = fileStore(path.join(dir, 'sub', 'update-check.json'));
  assert.deepStrictEqual(store.read(), {});
  store.write({lastCheckedAt: 5, dismissed: '0.3.0'});
  assert.deepStrictEqual(store.read(), {lastCheckedAt: 5, dismissed: '0.3.0'});
  fs.writeFileSync(path.join(dir, 'sub', 'update-check.json'), '{nope');
  assert.deepStrictEqual(store.read(), {});
});

test('a fetch that ignores the signal still times out', async () => {
  const deaf = () => new Promise(() => {});
  assert.deepStrictEqual(await checkLatest({currentVersion: '0.2.0', fetch: deaf, timeoutMs: 30}), {state: 'failed', reason: 'timed out after 30 ms'});
});

test('a body that stalls times out', async () => {
  const stall = async () => ({ok: true, status: 200, headers: {get: () => null}, text: () => new Promise(() => {})});
  assert.deepStrictEqual(await checkLatest({currentVersion: '0.2.0', fetch: stall, timeoutMs: 30}), {state: 'failed', reason: 'timed out after 30 ms'});
});
