// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Browser acceptance checks for effect clips (the effects assessment's
// acceptance plan, B1-B8 and B11), in the browser-only build:
//
//   npm run build:pages
//   SERVE=dist-pages OUT=/some/dir npm run effects
//
// Headed Chrome on a fresh profile (the browser engine needs WebGPU), started
// here rather than by Playwright so its stderr can be read: Chrome logs "Too
// many active WebGL contexts" there, never to the page console. It opens
// 05_default_juggle.mp4 from the gallery, adds two layers (A the person, with
// clicks on frames 1 and 121, B the ball), tracks them, then:
//   B1  Add effect -> Outline at frame 31: one clip, selected, from the playhead;
//       width and style edit that clip; Add effect again adds a second one
//   B5  removing the later of two overlapping clips (Erase over Glow) shows the one
//       below; Gradient and Erase added both ways round: the later one covers
//   B2  A Outline red 2 %, B Outline blue 4 %: both drawn, and kept through a
//       selection change and a reload
//   B3  a clip on frames 31-60 draws on 31 and 60, not on 30 or 61 (and again
//       after Shift+Alt+Right moves it ten frames)
//   B7  preview vs exported MP4 at the same frames, scaled to 320x180: each
//       frame within TOLERANCE_DB of the capture floor (the same comparison
//       with every layer on Original, nothing drawn over the video)
//   B6  Noisy (animated) on frame 101 is pixel-identical after a wait, a scrub
//       away and back, and play/pause; its export frame is checked by B7
//   RB  slice 3, Replace background on frame 101 (A and B on a transparent Outline, so
//       what is under them shows): inside their masks (a green Erase on each, eroded
//       2 px) the frame is as the plain video, outside (dilated 2 px; 6 px off the
//       capture's edge) the fill: a
//       colour, then a picture picked in the settings (four coloured quadrants, 2x the
//       video, stored scaled down in OPFS by its hash); a key this browser lacks
//       draws the colour, and the settings and the export dialog say so; Reset keeps
//       the picture; a Gradient (red to blue, top to bottom) lies on the red-blue line
//       and runs the right way; feather 1 softens only a few px outside the masks; with
//       Colour pop on later frames, the export matches the preview within B7's tolerance
//   RO  a phone photo: a portrait JPEG stored landscape with EXIF Orientation 6 (made here), picked
//       as the picture, is kept upright at the size Cover needs (1280x2560) and drawn
//       upright in proportion (quadrants and a white band where they belong)
//   CP  Colour pop: outside the masks grey, inside as the plain video (colour kept)
//   SP  Spotlight: darken 0.6 dims everything outside the circle to 0.4 and leaves
//       A as it was; on A and B with different settings it darkens once (0.4, not
//       0.16) and neither dims the other's circle; each of Meta's six styles, saved style-only as earlier builds
//       saved them, draws pixel-identically to the base build (BASE_SERVE, served
//       at /sam-ui-base/ on the same origin, so the same tracks and doc)
//   TT  slice 4, the Title on frame 101 over A and B (on a transparent Outline):
//       In front, magenta text drawn where its position says and over the subjects;
//       a long line at the default size at the right edge stays inside the frame;
//       Behind subjects, the same text outside their masks and the plain video inside
//       (RB's masks), and over a Desaturate below as that drew them; its ink as wide as Inter's at weights 900 and 300 (measured in
//       the page with the same font file), not the fallback sans-serif's; a Fade at
//       the clip's first frame draws nothing, at its entrance's end all of it; the
//       text field takes typed text (shortcut keys too) with its count, does nothing on Enter at its
//       third line, keeps the title while emptied; Top moves it; Reset keeps the text; with a Rise over
//       the clip, the export matches the preview within B7's tolerance
//   SC  Scribble (boiling Outline) on frame 101: identical after a scrub away and
//       back and play/pause, redrawn when boil is on (differs from boil 0, which
//       is itself steady); its export matches the preview within B7's tolerance
//   GL  Glitter on A and Sparkle (multicolour) on B, written as a doc: frame 101 is
//       identical after a scrub away and back, play/pause and a reload (a fresh
//       worker); the sparkles (where it changes the plain video) move between frames
//       101 and 102; the same clips under other ids (other seeds) draw other
//       sparkles; its export matches the preview within B7's tolerance
//   OB  the layer Blur draws on A, its settings carry the tracking caveat, and a
//       larger radius changes it; with the background Blur under it, frames 31 and
//       101 (A in different places) differ as the video does there, and each
//       matches a fresh worker's drawing (a stale pass texture froze both Blurs on
//       the first frame they drew)
//   PH  animated effects run on the clip clock (docs written as split and
//       duplicate leave them, since those operations live on another branch):
//       Noisy's split right half [s, b) at phase s - a equals the unsplit clip on
//       frame s + k; a duplicate [b, 2b - a) at phase 0 restarts, so on frame
//       b + k it differs from the original carried on (with the video's frame
//       index as the clock, the old way, they were identical)
//   B11 every background and layer tile picked in turn, then Erase: the preview
//       matches a reloaded (fresh) worker, the export matches the preview, and
//       Chrome logged no "Too many active WebGL contexts"
//   S2  slice 2: S (timeline focus only) splits a Noisy clip at its middle, every checked frame (the
//       split frame and its neighbours) pixel-identical; Duplicate puts a copy
//       after the right part (phase 0 in the doc), drawn like a fresh Noisy clip
//       there and unlike the right part carried on (the clip clock restarts);
//       Alt+Down passes the nearest clip it overlaps
//       (skipping a non-overlapping Outline), a second press says why it does nothing,
//       Move up puts it back; the one on top measured as B5 does;
//       Cmd-Z restores each, Shift-Cmd-Z redoes it, each selecting the clip the
//       edit selected then (the moved clip, the split's right part, the original)
//   B8  from the end of tracking to here: no segmentation or tracking call
//       reached the video worker, no job started, no job chip showed
//   B4  frames 71-120 of A marked absent (lane actions; B's last frame first, so
//       the viewer keeps its size): the clip keeps its frames, A's effect is gone
//       there and comes back on frame 121 as it was
// Previews are compared as screenshots of the viewer canvas, decoded with
// ffmpeg (as memory.mjs does). Captures, exports, results.json and Chrome's
// stderr go to OUT. Any failed check exits non-zero, and so does any
// GL_INVALID or feedback-loop line in Chrome's stderr over the whole run.
//
// GPU: the caller holds the machine's GPU lock (nothing in the repo takes
// it) until the `setup` line prints: the browser engine runs the model only
// for the clicks and the track before it. The checks after it only draw.
//
// Settings (env): URL (http://127.0.0.1:7488/sam-ui/), SERVE (a build folder
// to serve at URL), BASE_SERVE (a build of the commit before slice 3 with
// VITE_BASE=/sam-ui-base/, for SP's parity; skipped without it), OUT
// (e2e/out/effects), CHROME (its binary), CDP_PORT (9493).
import {execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {newPage} from './browser.mjs';
import {serve} from './static-server.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLIP = path.resolve(HERE, '../../demo/data/gallery/05_default_juggle.mp4');
const URL_ = process.env.URL ?? 'http://127.0.0.1:7488/sam-ui/';
const OUT = process.env.OUT ?? path.join(HERE, 'out', 'effects');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9493);
const FRAMES = 247; // the juggle clip, 24 fps: a new clip is 72 frames
// preview captures: "same" and "different" as the share of pixels off by more than 8 in a channel
const SAME_PCT = 0.05;
const DIFF_PCT = 0.3;
// B7: an export frame may be this far below the capture floor (H.264 smooths thin strokes and noise)
const TOLERANCE_DB = 3;
const PARITY_FRAMES = [10, 60, 100, 180, 240];
const INFERENCE = ['setPoints', 'textPrompt', 'discoverText', 'track', 'clearTrack', 'moveClicks', 'detailRequest', 'restoreVersion', 'undo', 'redo'];
fs.mkdirSync(OUT, {recursive: true});

let failed = 0;
const results = {};
const check = (id, ok, what, data) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${what}`);
  (results[id] ??= []).push({ok, what, ...(data != null && {data})});
  if (!ok) failed++;
};

// pixels: PNG buffers or a video's frames, as rgb24 through ffmpeg
const pngSize = png => [png.readUInt32BE(16), png.readUInt32BE(20)];
// a decode piped a PNG once sat idle for half an hour (ffmpeg never saw its stdin end): time out and try again
const decode = (input, vf, tries = 2) => {
  try {
    return execFileSync('ffmpeg', ['-v', 'error', '-i', Buffer.isBuffer(input) ? 'pipe:0' : input, ...(vf ? ['-vf', vf] : []), '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
      input: Buffer.isBuffer(input) ? input : undefined,
      maxBuffer: 1 << 30,
      timeout: 120000,
    });
  } catch (error) {
    if (tries > 1 && error.code === 'ETIMEDOUT') return decode(input, vf, tries - 1);
    throw error;
  }
};
function compare(a, b) {
  const [x, y] = [decode(a), decode(b)];
  if (x.length !== y.length) throw new Error(`sizes differ: ${pngSize(a)} vs ${pngSize(b)}`);
  return stats(x, y);
}
function stats(x, y) {
  let changed = 0, sum = 0, sq = 0;
  for (let i = 0; i < x.length; i += 3) {
    const d = [Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2])];
    if (Math.max(...d) > 8) changed++;
    sum += d[0] + d[1] + d[2];
    sq += d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
  }
  const mse = sq / x.length;
  const r = n => Math.round(n * 1000) / 1000;
  return {changedPct: r((changed / (x.length / 3)) * 100), mad: r(sum / x.length), psnr: mse === 0 ? Infinity : r(10 * Math.log10(255 ** 2 / mse))};
}
const same = s => s.changedPct <= SAME_PCT;
const differs = s => s.changedPct >= DIFF_PCT;
const countPx = (png, test) => {
  const p = decode(png);
  let n = 0;
  for (let i = 0; i < p.length; i += 3) n += test(p[i], p[i + 1], p[i + 2]) ? 1 : 0;
  return n;
};
const red = png => countPx(png, (r, g, b) => r > 200 && g < 60 && b < 60);
const blue = png => countPx(png, (r, g, b) => b > 200 && r < 60 && g < 90);

const BASE_URL = new URL('../sam-ui-base/', URL_).href;
const server = process.env.SERVE ? await serve(process.env.SERVE, URL_, process.env.BASE_SERVE ? {[new URL(BASE_URL).pathname]: process.env.BASE_SERVE} : {}) : null;
// a fresh profile; Chrome's stderr kept for B11; sRGB output, so a capture's colours are the page's (RB's fills)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-ui-effects-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu', '--enable-logging=stderr', '--force-color-profile=srgb', 'about:blank'], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
chrome.stderr.on('data', d => (stderr += d));
const contextLosses = () => stderr.split('Too many active WebGL contexts').length - 1;
let browser = null;
for (let i = 0; i < 100 && browser == null; i++) {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`).catch(() => null);
  if (browser == null) await new Promise(r => setTimeout(r, 200));
}
const page = await newPage(browser, {width: 1920, height: 1200});
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
// B8: count studio calls the page posts to its workers, and job starts and job chips
await page.context().addInitScript(() => {
  const fx = (window.__fx = {calls: {}, jobs: 0, chips: 0});
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, ...rest) {
    if (m?.action === 'studioCall') fx.calls[m.method] = (fx.calls[m.method] ?? 0) + 1;
    return post.call(this, m, ...rest);
  };
  window.Worker = class extends window.Worker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', e => e.data?.action === 'studioEvent' && e.data.event?.type === 'jobStarted' && fx.jobs++);
    }
  };
  addEventListener('DOMContentLoaded', () =>
    new MutationObserver(() => document.querySelector('.job-chip') && fx.chips++).observe(document.body, {childList: true, subtree: true}),
  );
  try {
    localStorage.setItem('sam-ui-suite:sections-open', JSON.stringify({media: true, effects: true, review: false, info: false}));
    localStorage.setItem('sam-ui-studio:effect-groups-open', JSON.stringify({highlight: true, background: true}));
    localStorage.setItem('sam-ui-studio:demo-banner-dismissed', '1'); // a taller viewer
  } catch {
    // about:blank
  }
});
const counted = {calls: {}, jobs: 0, chips: 0};
const harvest = async () => {
  const fx = await page.evaluate(() => window.__fx);
  for (const [m, n] of Object.entries(fx.calls)) counted.calls[m] = (counted.calls[m] ?? 0) + n;
  counted.jobs += fx.jobs;
  counted.chips += fx.chips;
};

// studio helpers (smoke-local.mjs and the effects runs)
const clickAt = async (nx, ny) => {
  const b = await page.$eval('.click-layer', e => {
    const r = e.getBoundingClientRect();
    return {x: r.left, y: r.top, w: r.width, h: r.height};
  });
  await page.mouse.click(b.x + nx * b.w, b.y + ny * b.h);
};
const settle = () => page.waitForFunction(() => !/Updating/.test(document.querySelector('.topbar-status')?.innerText ?? ''), null, {timeout: 180000});
const opened = async () => {
  await page.waitForSelector('.engine-button', {timeout: 60000});
  await page.waitForFunction(() => !document.querySelector('.stage-overlay'), null, {timeout: 60000});
  await page.waitForFunction(() => !/decoding/.test(document.querySelector('.frame-counter')?.innerText ?? ''), null, {timeout: 120000});
  await page.waitForTimeout(1000);
};
const reload = async () => {
  await harvest();
  await page.reload();
  await opened();
  await page.waitForFunction(() => document.querySelectorAll('.swimlane-segment').length >= 2, null, {timeout: 60000});
};
const frame = async () => Number(await page.$eval('.frame-counter strong', e => e.innerText)) - 1;
const seekTo = async n => {
  await page.evaluate(() => document.activeElement?.blur());
  for (let i = 0; i < 600; i++) {
    const f = await frame();
    if (f === n) break;
    await page.keyboard.press(f < n ? 'ArrowRight' : 'ArrowLeft');
    await page.waitForFunction(f => Number(document.querySelector('.frame-counter strong')?.innerText) - 1 !== f, f, {timeout: 2000}).catch(() => {});
  }
  await page.waitForFunction(n => Number(document.querySelector('.frame-counter strong')?.innerText) - 1 === n, n, {timeout: 10000});
  await page.waitForTimeout(700);
};
const cap = async name => {
  const png = await page.locator('.stage-canvas').screenshot();
  fs.writeFileSync(path.join(OUT, `${name}.png`), png);
  return png;
};
const doc = () =>
  page.evaluate(() => {
    const k = Object.keys(localStorage).find(k => k.startsWith('sam-ui-studio:effects:v2:local/'));
    return k == null ? null : JSON.parse(localStorage.getItem(k));
  });
const sel = async i => {
  const row = page.locator('.object-row').nth(i);
  if (!(await row.evaluate(r => r.classList.contains('active')))) await row.locator('.layer-summary').click();
  await page.waitForTimeout(300);
};
// group 0: the selected layer's tiles, 1: the background's
const group = gi => page.locator('.effect-group').nth(gi);
const tile = async (gi, title) => {
  await group(gi).locator('.effect-button', {hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)}).first().click();
  await page.waitForTimeout(500);
};
const addEffect = async (gi, title) => {
  await group(gi).locator('button:has-text("Add effect")').click();
  await tile(gi, title);
};
const clips = () => page.locator('.fx-clip').count();
const clearClips = async () => {
  while ((await clips()) > 0) {
    await page.locator('.fx-clip').first().click();
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(300);
};
const fx = page.locator('.fx-settings');
const setting = async (what, value) => {
  if (['width', 'boil', 'radius'].includes(what)) await fx.locator(`input[type=number][aria-label^="${what[0].toUpperCase()}${what.slice(1)}"]`).fill(value);
  else if (what === 'last') await fx.locator('input[aria-label="Last frame"]').fill(value);
  else if (what === 'style') await fx.getByRole('button', {name: value, exact: true}).click();
  else if (what === 'color') {
    await fx.locator('.fx-follow input').uncheck();
    await fx.locator('input[type=color]').fill(value);
  }
  await page.waitForTimeout(500);
};
const exportVideo = async name => {
  await page.click('.export-menu > button');
  await page.click('.menu-item:has-text("Video with effects")');
  await page.waitForSelector('.modal');
  const [download] = await Promise.all([page.waitForEvent('download', {timeout: 600000}), page.click('.modal button:has-text("Export MP4")')]);
  const file = path.join(OUT, `${name}.mp4`);
  await download.saveAs(file);
  await page.click('.modal button:has-text("Close")').catch(() => {});
  return file;
};
// a doc written as builds save it, then loaded by a fresh page (this build, or the base at BASE_URL)
const clipOn = (target, effect, params, id, start = 0, end = FRAMES) => ({id, target, effect, params, start, end, row: 0, phase: 0});
const putClips = async (clips, url = null) => {
  const key = await page.evaluate(() => Object.keys(localStorage).find(k => k.startsWith('sam-ui-studio:effects:v2:local/')));
  await page.evaluate(([k, c]) => localStorage.setItem(k, JSON.stringify({version: 2, clips: c})), [key, clips]);
  if (url == null) {
    await reload();
  } else {
    await harvest();
    await page.goto(url);
    await opened();
    await page.waitForFunction(() => document.querySelectorAll('.swimlane-segment').length >= 2, null, {timeout: 60000});
  }
};
// full-size pixels of a capture, and masks over them (1 = in)
const pixels = png => {
  const [w, h] = pngSize(png);
  return {d: decode(png), w, h};
};
const where = (img, test) => {
  const m = new Uint8Array(img.w * img.h);
  for (let i = 0; i < m.length; i++) m[i] = test(img.d[3 * i], img.d[3 * i + 1], img.d[3 * i + 2], i % img.w, Math.floor(i / img.w)) ? 1 : 0;
  return m;
};
// grow (dilate) or shrink (erode) a mask by r px (a square), past the frame's edge counting as unchanged
const morph = (m, w, h, r, grow) => {
  const pass = (src, dx, dy) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = grow ? 0 : 1;
        for (let k = -r; k <= r; k++) {
          const [xx, yy] = [x + k * dx, y + k * dy];
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          v = grow ? v | src[yy * w + xx] : v & src[yy * w + xx];
        }
        out[y * w + x] = v;
      }
    return out;
  };
  return pass(pass(m, 1, 0), 0, 1);
};
const not = m => m.map(v => 1 - v);
const and = (a, b) => a.map((v, i) => v & b[i]);
// the share of mask m's pixels (in %) where ok(i) holds
const share = (m, ok) => {
  let n = 0, good = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) (n++, ok(i) && good++);
  return {n, pct: n === 0 ? 0 : Math.round((good / n) * 10000) / 100};
};
const off = (a, b, i) => Math.max(Math.abs(a.d[3 * i] - b.d[3 * i]), Math.abs(a.d[3 * i + 1] - b.d[3 * i + 1]), Math.abs(a.d[3 * i + 2] - b.d[3 * i + 2]));
const offRgb = (a, i, [r, g, b]) => Math.max(Math.abs(a.d[3 * i] - r), Math.abs(a.d[3 * i + 1] - g), Math.abs(a.d[3 * i + 2] - b));
const chroma = (a, i) => Math.max(a.d[3 * i], a.d[3 * i + 1], a.d[3 * i + 2]) - Math.min(a.d[3 * i], a.d[3 * i + 1], a.d[3 * i + 2]);
const luma = (a, i) => 0.3 * a.d[3 * i] + 0.59 * a.d[3 * i + 1] + 0.11 * a.d[3 * i + 2];
const PIXEL_TOL = 12; // a capture's channel may be this far off where the same pixels are drawn (scaling, colour conversion)

// export frames and preview captures at 320x180, the assessment's comparison size
const small = 'scale=320:180';
const exportFrames = (file, frames) => {
  const raw = decode(file, `select=${frames.map(f => `eq(n\\,${f})`).join('+')},${small}`);
  const size = 320 * 180 * 3;
  return frames.map((f, i) => raw.subarray(i * size, (i + 1) * size));
};
const nbFrames = file => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], {encoding: 'utf8'}).trim());

const step = async (id, body) => {
  try {
    await body();
  } catch (error) {
    check(id, false, `threw: ${String(error).split('\n')[0]}`);
    await page.screenshot({path: path.join(OUT, `${id}-error.png`)}).catch(() => {});
  }
};

// ---- setup: open the clip, two layers, track
await page.goto(URL_);
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  for await (const name of root.keys()) await root.removeEntry(name, {recursive: true}).catch(() => {});
});
await page.reload();
await page.waitForSelector('.dropzone', {timeout: 60000});
await page.setInputFiles('.dropzone input[type=file]', CLIP);
await page.waitForFunction(() => document.querySelector('.media-item.selected .media-name')?.title?.startsWith('local/'), null, {timeout: 120000});
await opened();
const box = await page.locator('.stage-canvas').boundingBox();
console.log(`viewer canvas ${Math.round(box.width)}x${Math.round(box.height)} (video 1280x720)`);
// A: the person, on frame 1 (the model downloads on the first click) and frame 121
await clickAt(0.56, 0.32);
await settle();
await clickAt(0.55, 0.62);
await settle();
await seekTo(120);
await clickAt(0.59, 0.38);
await settle();
await clickAt(0.56, 0.62);
await settle();
// B: the ball, on frame 1
await seekTo(0);
await page.click('button:has-text("Add layer")');
await clickAt(0.508, 0.444);
await settle();
await page.waitForFunction(() => document.querySelectorAll('.object-row').length === 2, null, {timeout: 60000});
const t0 = Date.now();
await page.click('.cta');
await page.waitForFunction(() => !document.querySelector('.job-chip') && document.querySelector('.cta')?.innerText === 'Nothing to track', null, {timeout: 600000});
const rows = await page.$$eval('.object-row .layer-summary', rs => rs.map(r => r.innerText.replace(/\n/g, ' ')));
check('setup', rows.length === 2 && rows.every(r => /Tracked/.test(r)), `two layers tracked in ${Math.round((Date.now() - t0) / 1000)} s ${JSON.stringify(rows)}`);
// layer ids in creation order (A first); rows hold their frame lanes
const [aId, bId] = (await page.$$eval('[data-lane]', ls => ls.map(l => Number(l.dataset.lane)))).sort((x, y) => x - y);
const rowOf = id => page.$$eval('.object-row', (rs, id) => rs.findIndex(r => r.querySelector(`[data-lane="${id}"]`) != null), id);
const [A, B] = [await rowOf(aId), await rowOf(bId)];
console.log(`A (person): id ${aId}, row ${A}; B (ball): id ${bId}, row ${B}`);
// B8 starts here: nothing below should segment or track until B4
await page.evaluate(() => Object.assign(window.__fx, {calls: {}, jobs: 0, chips: 0}));

let ref30, glow, both;
await step('B1', async () => {
  await sel(A);
  await seekTo(30);
  ref30 = await cap('B1-0_ref_f31_no-clips');
  const n0 = await clips();
  await addEffect(0, 'Outline');
  const s1 = await page.locator('.fx-clip.selected').getAttribute('aria-label');
  const d1 = await doc();
  const added = await cap('B1-1_outline-added_f31');
  check('B1', n0 === 0 && (await clips()) === 1, `Add effect -> Outline makes one clip (${n0} -> ${await clips()})`);
  check('B1', /Outline, frames 31–102/.test(s1 ?? '') && d1.clips[0]?.start === 30 && d1.clips[0]?.end === 102, `the new clip is selected and starts at the playhead: "${s1}"`);
  const vis = compare(ref30, added);
  check('B1', differs(vis), 'the outline shows at once', vis);
  const note = await group(0).locator('.fx-command .effect-note').innerText();
  check('B1', /Tiles change Outline, frames 31–102/.test(note), `the dock names the clip it edits: "${note}"`);
  await setting('width', '2');
  const wide = await cap('B1-2_width-2pct_f31');
  const d2 = await doc();
  check('B1', (await clips()) === 1 && d2.clips[0].params.width === 0.02 && differs(compare(added, wide)), `width 2 % edits that clip (width ${d2.clips[0].params.width})`, compare(added, wide));
  await setting('style', 'Glow');
  glow = await cap('B1-3_glow_f31');
  const d3 = await doc();
  check('B1', (await clips()) === 1 && d3.clips[0].params.style === 'Glow' && differs(compare(wide, glow)), `style Glow edits that clip, no new clip (${await clips()} clip)`, compare(wide, glow));
  await addEffect(0, 'Erase');
  both = await cap('B1-4_second-clip-erase_f31');
  const d4 = await doc();
  const s4 = await page.locator('.fx-clip.selected').getAttribute('aria-label');
  check('B1', (await clips()) === 2 && d4.clips.length === 2 && /Erase/.test(s4 ?? ''), `Add effect again adds a second clip, selected (${await clips()} clips: "${s4}")`);
});

await step('B5', async () => {
  // the Erase clip was added last: it draws over the Glow clip
  check('B5', differs(compare(glow, both)), 'the later clip (Erase) shows over the earlier one (Glow)', compare(glow, both));
  await page.locator('.fx-clip.selected').click();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  const revealed = await cap('B5-1_erase-removed_f31');
  const left = (await doc()).clips.map(c => c.effect);
  check('B5', left.length === 1 && left[0] === 'Outline' && same(compare(glow, revealed)), `removing it shows the clip below as before (${left})`, compare(glow, revealed));
  // Glow draws outside the mask and Erase inside, so they commute: the order test
  // uses two fills inside the mask, Gradient and Erase, added both ways round
  await clearClips();
  await addEffect(0, 'Gradient');
  await addEffect(0, 'Erase');
  const gradThenErase = await cap('B5-2_gradient-then-erase_f31');
  await page.locator('.fx-clip:not(.selected)').click(); // the Gradient clip
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  const eraseOnly = await cap('B5-3_erase-only_f31');
  await addEffect(0, 'Gradient');
  const eraseThenGrad = await cap('B5-4_erase-then-gradient_f31');
  const under = compare(eraseOnly, gradThenErase);
  const over = compare(eraseOnly, eraseThenGrad);
  check('B5', differs(over) && under.changedPct < over.changedPct / 4, `the later clip covers the earlier: Gradient under Erase changes ${under.changedPct} % of Erase alone, Gradient over it ${over.changedPct} %`, {under, over});
  await clearClips();
});

await step('B2', async () => {
  await sel(A);
  await seekTo(30);
  await tile(0, 'Outline'); // a layer with no clips: over the whole video
  await setting('color', '#ff0000');
  await setting('width', '2');
  await sel(B);
  await tile(0, 'Outline');
  await setting('color', '#0000ff');
  await setting('width', '4'); // the plan's 6 % is past Outline's 5 % maximum
  const d = await doc();
  const a = d.clips.find(c => c.target.id === aId)?.params;
  const b = d.clips.find(c => c.target.id === bId)?.params;
  check('B2', a?.color === '#ff0000' && a?.width === 0.02 && b?.color === '#0000ff' && b?.width === 0.04, `each layer keeps its own values: A ${JSON.stringify(a)}, B ${JSON.stringify(b)}`);
  const shotB = await cap('B2-1_A-red-2pct_B-blue-4pct_B-selected_f31');
  await sel(A);
  const shotA = await cap('B2-2_A-selected_f31');
  const [r, bl] = [red(shotA), blue(shotA)];
  check('B2', r > 200 && bl > 200, `both outlines drawn in their colours (${r} red px, ${bl} blue px)`);
  check('B2', same(compare(shotB, shotA)), 'switching the selected layer changes nothing', compare(shotB, shotA));
  const before = JSON.stringify(d.clips);
  await reload();
  await seekTo(30);
  await sel(A);
  const shotR = await cap('B2-3_after-reload_f31');
  check('B2', JSON.stringify((await doc()).clips) === before, 'reload keeps the clips byte for byte');
  check('B2', same(compare(shotA, shotR)), 'reload draws the same frame', compare(shotA, shotR));
  await clearClips();
});

const ref = {};
await step('B3', async () => {
  await sel(A);
  for (const f of [29, 30, 59, 60, 39, 40, 69, 70, 100]) {
    await seekTo(f);
    ref[f] = await cap(`B3-0_ref_f${f + 1}_no-clips`);
  }
  await seekTo(30);
  await addEffect(0, 'Outline');
  await setting('width', '2');
  await setting('last', '60');
  const edges = async (lo, hi, tag) => {
    const c = (await doc()).clips[0];
    const got = [];
    for (const f of [lo - 1, lo, hi - 1, hi]) {
      await seekTo(f);
      const s = compare(ref[f], await cap(`B3-${tag}_f${f + 1}_${f < lo || f >= hi ? 'outside' : 'inside'}`));
      got.push({frame: f + 1, inside: f >= lo && f < hi, ...s});
    }
    const ok = c.start === lo && c.end === hi && got.every(g => (g.inside ? differs(g) : same(g)));
    check('B3', ok, `clip [${c.start}, ${c.end}) draws on frames ${lo + 1}-${hi} only: ${got.map(g => `f${g.frame} ${g.changedPct} %`).join(', ')}`, got);
  };
  await edges(30, 60, '1');
  await page.locator('.fx-clip.selected').focus();
  await page.keyboard.press('Shift+Alt+ArrowRight');
  await page.waitForTimeout(500);
  await edges(40, 70, '2_moved-10');
  await clearClips();
});

// B7 floor: every layer on Original, no background clip: the preview is the plain video
const preview = async tag => {
  const shots = [];
  for (const f of PARITY_FRAMES) {
    await seekTo(f);
    shots.push(decode(await cap(`${tag}_preview_f${f + 1}`), small));
  }
  return shots;
};
let floor = null;
await step('B7', async () => {
  for (const r of [A, B]) {
    await sel(r);
    await tile(0, 'Original');
  }
  const shots = await preview('B7-0_plain');
  const file = await exportVideo('B7-0_plain_all-original');
  const psnr = exportFrames(file, PARITY_FRAMES).map((e, i) => stats(shots[i], e).psnr);
  floor = Math.min(...psnr);
  check('B7', nbFrames(file) === FRAMES, `plain export has ${nbFrames(file)} frames; capture floor ${floor} dB (${psnr.join(', ')})`, {psnr});
  await clearClips();
});

let noisy;
await step('B6', async () => {
  await sel(A);
  await tile(0, 'Noisy');
  await seekTo(99);
  await seekTo(100);
  noisy = await cap('B6-1_noisy_f101_seek');
  await page.waitForTimeout(2000);
  const waited = await cap('B6-2_noisy_f101_after-2s');
  await seekTo(60);
  await seekTo(100);
  const scrubbed = await cap('B6-3_noisy_f101_scrub-away-and-back');
  await seekTo(94);
  await page.keyboard.press(' ');
  await page.waitForTimeout(220);
  await page.keyboard.press(' ');
  await page.waitForTimeout(800);
  const stopped = await frame();
  await seekTo(100);
  const played = await cap('B6-4_noisy_f101_play-pause-step');
  check('B6', differs(compare(ref[100], noisy)), 'Noisy draws on frame 101', compare(ref[100], noisy));
  for (const [what, png] of [['after 2 s', waited], ['scrub away and back', scrubbed], [`play/pause (stopped at ${stopped + 1})`, played]]) {
    const s = compare(noisy, png);
    check('B6', s.changedPct === 0, `frame 101 identical ${what}: MAD ${s.mad}`, s);
  }
});

let tolerance = null;
await step('B7', async () => {
  if (floor == null) throw new Error('no capture floor');
  tolerance = floor - TOLERANCE_DB;
  // A keeps Noisy (B6); B Glow, the background Desaturate: GL and 2D effects, all over the whole video
  await sel(B);
  await tile(0, 'Outline');
  await setting('style', 'Glow');
  await tile(1, 'Desaturate');
  const shots = await preview('B7-1_fx');
  const file = await exportVideo('B7-1_fx_A-noisy_B-glow_bg-desaturate');
  const frames = exportFrames(file, PARITY_FRAMES);
  const rows = PARITY_FRAMES.map((f, i) => ({frame: f + 1, ...stats(shots[i], frames[i])}));
  for (const r of rows) check('B7', r.psnr >= tolerance, `f${r.frame}: preview vs export ${r.psnr} dB (MAD ${r.mad}; needs >= ${tolerance} dB)`, r);
  // the comparison can tell frames apart: preview frame 101 against export frame 181
  const shifted = stats(shots[PARITY_FRAMES.indexOf(100)], frames[PARITY_FRAMES.indexOf(180)]);
  check('B7', shifted.psnr < tolerance, `a mismatched frame falls below it (f101 vs export f181: ${shifted.psnr} dB)`, shifted);
  await clearClips();
});

// slice 3: A and B's masks on frame 101 (RB), shared by CP and SP
const F3 = 100;
const [tA, tB, tBG] = [{kind: 'object', id: aId}, {kind: 'object', id: bId}, {kind: 'background'}];
// the layers draw nothing (a transparent Outline): the background clip shows inside their masks too
const clear = () => [clipOn(tA, 'Outline', {style: 'Outline', opacity: 0}, 'oa'), clipOn(tB, 'Outline', {style: 'Outline', opacity: 0}, 'ob')];
let inside = null, outside = null, plain3 = null;
// a picture twice the video's size: four quadrants of colour
const QUADS = [[255, 64, 0], [0, 200, 255], [255, 230, 0], [140, 0, 255]]; // top left, top right, bottom left, bottom right
const PICTURE = path.join(OUT, 'RB-picture_2560x1440_quadrants.png');
{
  const [w, h] = [2560, 1440];
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(QUADS[(y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)], 3 * (y * w + x));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', 'pipe:0', '-frames:v', '1', PICTURE], {input: raw});
}
const quadrant = (img, x, y) => QUADS[(y < img.h / 2 ? 0 : 2) + (x < img.w / 2 ? 0 : 1)];
const nearSeam = (img, x, y) => Math.abs(x - img.w / 2) < 6 || Math.abs(y - img.h / 2) < 6;
const pictureKey = () => doc().then(d => d?.clips.find(c => c.id === 'rb')?.params.image ?? '');
// a stored picture as the browser decodes it (EXIF orientation applied), and whether its bytes hash to its key
const storedPicture = key =>
  page.evaluate(async k => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('sam-ui')).getDirectoryHandle('effect-images');
    const file = await (await dir.getFileHandle(k)).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const bmp = await createImageBitmap(file);
    return {hash, width: bmp.width, height: bmp.height};
  }, key);
// pick a picture for the background clip 'rb' in its settings; its new key
const pickPicture = async file => {
  const old = await pictureKey();
  await page.locator('.fx-clip[data-clip="rb"]').click();
  await fx.locator('input[type=file]').setInputFiles(file);
  await page.waitForFunction(old => {
    const k = Object.keys(localStorage).find(k => k.startsWith('sam-ui-studio:effects:v2:local/'));
    const key = JSON.parse(localStorage.getItem(k)).clips.find(c => c.id === 'rb')?.params.image ?? '';
    return /^[0-9a-f]{64}$/.test(key) && key !== old;
  }, old, {timeout: 20000});
  await page.waitForTimeout(1000);
  return pictureKey();
};
// a phone photo: an upright 1600x3200 portrait (the quadrants, a white band at rows 1800-1849, which on
// the video's 1280x720 under Cover lands on frame rows 520-560) stored turned 90 degrees counter-clockwise,
// 3200x1600, with EXIF Orientation 6 (turn it clockwise to show it), as a camera writes it
const PHONE = path.join(OUT, 'RO-picture_portrait-1600x3200_stored-landscape_exif6.jpg');
{
  const [W, H] = [1600, 3200];
  const raw = Buffer.alloc(W * H * 3);
  for (let sy = 0; sy < W; sy++)
    for (let sx = 0; sx < H; sx++) {
      const [ux, uy] = [W - 1 - sy, sx]; // the upright pixel stored here
      raw.set(uy >= 1800 && uy < 1850 ? [255, 255, 255] : QUADS[(uy < H / 2 ? 0 : 2) + (ux < W / 2 ? 0 : 1)], 3 * (sy * H + sx));
    }
  const jpeg = execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${H}x${W}`, '-i', 'pipe:0', '-frames:v', '1', '-q:v', '2', '-f', 'mjpeg', 'pipe:1'], {input: raw, maxBuffer: 1 << 28});
  // APP1 Exif after SOI: a little-endian TIFF header and one IFD entry, Orientation (0x0112, SHORT) = 6
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff]), exif]);
  fs.writeFileSync(PHONE, Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
}

await step('RB', async () => {
  if (tolerance == null) throw new Error('no B7 tolerance');
  await putClips([clipOn(tA, 'EraseForeground', {style: 'Green'}, 'ga'), clipOn(tB, 'EraseForeground', {style: 'Green'}, 'gb')]);
  await sel(A);
  await seekTo(F3);
  const green = pixels(await cap('RB-0_mask-probe_green-erase_f101'));
  const m = where(green, (r, g, b) => g > 200 && r < 90 && b < 90);
  // the capture's outermost rows and columns are part frame, part page
  const framed = where(green, (_r, _g, _b, x, y) => x >= 6 && y >= 6 && x < green.w - 6 && y < green.h - 6);
  inside = and(morph(m, green.w, green.h, 2, false), framed);
  outside = and(not(morph(m, green.w, green.h, 2, true)), framed);
  await putClips([clipOn(tA, 'Cutout', {style: 'Unchanged'}, 'pa'), clipOn(tB, 'Cutout', {style: 'Unchanged'}, 'pb')]);
  await sel(A);
  await seekTo(F3);
  plain3 = pixels(await cap('RB-1_plain_f101'));
  const masked = share(inside, () => true).n;
  check('RB', masked > 2000 && share(outside, () => true).n > masked, `A and B's masks on frame 101: ${masked} px inside (eroded 2 px), ${share(outside, () => true).n} outside (dilated 2 px)`);

  await putClips([clipOn(tBG, 'ReplaceBackground', {style: 'Colour', color: '#ff00ff'}, 'rb'), ...clear()]);
  await sel(A);
  await seekTo(F3);
  const colour = pixels(await cap('RB-2_colour-magenta_f101'));
  const kept = share(inside, i => off(colour, plain3, i) <= PIXEL_TOL);
  const filled = share(outside, i => offRgb(colour, i, [255, 0, 255]) <= PIXEL_TOL);
  // feather 1: the cut softens just outside the masks, nothing inside or further out changes
  await putClips([clipOn(tBG, 'ReplaceBackground', {style: 'Colour', color: '#ff00ff', feather: 1}, 'rb'), ...clear()]);
  await sel(A);
  await seekTo(F3);
  const soft = pixels(await cap('RB-2b_colour-magenta_feather-1_f101'));
  const near = and(morph(m, green.w, green.h, 4, true), outside);
  const far = and(not(morph(m, green.w, green.h, 12, true)), outside);
  const fKept = share(inside, i => off(soft, colour, i) <= PIXEL_TOL);
  const fNear = share(near, i => off(soft, colour, i) > PIXEL_TOL);
  const fFar = share(far, i => off(soft, colour, i) <= PIXEL_TOL);
  check('RB', fKept.pct === 100 && fNear.pct >= 30 && fFar.pct >= 99.5, `feather 1: inside unchanged (${fKept.pct} %), ${fNear.pct} % of the 2-4 px outside the masks softened, beyond 12 px unchanged (${fFar.pct} %)`, {fKept, fNear, fFar});
  // a Gradient, red at the top to blue at the bottom
  await putClips([clipOn(tBG, 'ReplaceBackground', {style: 'Gradient', color: '#ff0000', color2: '#0000ff', angle: 180}, 'rb'), ...clear()]);
  await sel(A);
  await seekTo(F3);
  const grad = pixels(await cap('RB-2c_gradient-red-to-blue_f101'));
  const onLine = share(outside, i => grad.d[3 * i + 1] <= PIXEL_TOL && Math.abs(grad.d[3 * i] + grad.d[3 * i + 2] - 255) <= PIXEL_TOL);
  const band = (from, to) => {
    let [r, b, n] = [0, 0, 0];
    outside.forEach((v, i) => {
      const y = Math.floor(i / grad.w) / grad.h;
      if (v && y >= from && y < to) (r += grad.d[3 * i], b += grad.d[3 * i + 2], n++);
    });
    return [Math.round(r / n), Math.round(b / n)];
  };
  const [top, bottom] = [band(0, 0.1), band(0.9, 1)];
  check('RB', onLine.pct >= 99.5 && top[0] > 200 && bottom[1] > 200, `Gradient: ${onLine.pct} % of the outside on the red-blue line; top band r/b ${top}, bottom band ${bottom}`, {onLine, top, bottom});
  check('RB', kept.pct >= 99.5 && filled.pct >= 99.5, `Colour: subjects as the video inside their masks (${kept.pct} % of ${kept.n} px within ${PIXEL_TOL}), magenta outside (${filled.pct} %)`, {kept, filled});

  await putClips([clipOn(tBG, 'ReplaceBackground', {style: 'Image', color: '#ff00ff'}, 'rb'), ...clear()]);
  await sel(A);
  await seekTo(F3);
  await page.locator('.fx-clip[data-clip="rb"]').click();
  const picker = fx.locator('input[type=file]');
  const name = await picker.evaluate(e => e.labels?.[0]?.innerText ?? '');
  const before = await fx.locator('.fx-param .effect-note').innerText();
  await picker.setInputFiles(PICTURE);
  await page.waitForFunction(() => {
    const k = Object.keys(localStorage).find(k => k.startsWith('sam-ui-studio:effects:v2:local/'));
    return /^[0-9a-f]{64}$/.test(JSON.parse(localStorage.getItem(k)).clips.find(c => c.id === 'rb')?.params.image ?? '');
  }, null, {timeout: 20000});
  await page.waitForTimeout(1000);
  const key = await pictureKey();
  const stored = await storedPicture(key);
  check('RB', name === 'Image' && /colour shows until you choose one/.test(before) && stored.hash === key && stored.width === 1280 && stored.height === 720, `the picker ("${name}") stores the picture by its hash, scaled down to the video: ${stored.width}x${stored.height}, key ${key.slice(0, 12)}... (hash ${stored.hash === key ? 'matches' : 'differs'})`, stored);
  const picture = pixels(await cap('RB-3_image-quadrants_f101'));
  const pkept = share(inside, i => off(picture, plain3, i) <= PIXEL_TOL);
  const placed = share(outside, i => {
    const [x, y] = [i % picture.w, Math.floor(i / picture.w)];
    return nearSeam(picture, x, y) || offRgb(picture, i, quadrant(picture, x, y)) <= PIXEL_TOL;
  });
  check('RB', pkept.pct >= 99.5 && placed.pct >= 99.5, `Image (Cover): subjects as the video (${pkept.pct} % of ${pkept.n} px), each quadrant of the picture in its place outside (${placed.pct} %)`, {kept: pkept, placed});

  // Reset to defaults resets the settings and keeps the picture (content, not a setting)
  await putClips([clipOn(tBG, 'ReplaceBackground', {style: 'Image', color: '#00ff00', feather: 0.5, fit: 'Contain', image: key}, 'rb'), ...clear()]);
  await sel(A);
  await page.locator('.fx-clip[data-clip="rb"]').click();
  await fx.getByRole('button', {name: /^Reset to/}).click();
  await page.waitForTimeout(500);
  const reset = (await doc()).clips.find(c => c.id === 'rb').params;
  check('RB', reset.image === key && reset.feather === 0 && reset.fit === 'Cover' && reset.color === '#2f6fdf' && reset.style === 'Image', `Reset keeps the picture and resets the rest: ${JSON.stringify(reset)}`);

  // a key this browser has no copy of (another browser's doc, or cleared site data)
  await putClips([clipOn(tBG, 'ReplaceBackground', {style: 'Image', color: '#ff00ff', image: 'ab'.repeat(32)}, 'rb'), ...clear()]);
  await sel(A);
  await seekTo(F3);
  await page.locator('.fx-clip[data-clip="rb"]').click();
  const missing = pixels(await cap('RB-4_missing-picture_colour-instead_f101'));
  const said = await fx.locator('.fx-param .effect-note').innerText();
  const fallback = share(outside, i => offRgb(missing, i, [255, 0, 255]) <= PIXEL_TOL);
  check('RB', fallback.pct >= 99.5 && /not stored in this browser/.test(said), `a picture this browser lacks draws the colour (${fallback.pct} % magenta outside); the settings say: "${said}"`, fallback);
  await page.click('.export-menu > button');
  await page.click('.menu-item:has-text("Video with effects")');
  await page.waitForSelector('.modal');
  const warned = await page.locator('.modal .effect-note').innerText().catch(() => '');
  const allowed = await page.locator('.modal button:has-text("Export MP4")').isEnabled();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('RB', /^1 clip uses a picture not stored in this browser or unreadable: it draws its colour instead\.$/.test(warned) && allowed, `the export dialog warns ("${warned}") and still allows the export (${allowed})`);
  const live = await page.$$eval('.effects [role=status], .effects [aria-live]', es => es.map(e => e.innerText).filter(t => /\d/.test(t)));
  check('RB', live.length === 0, `no numbers in the effects panel's live regions (${JSON.stringify(live)})`);

  // export: the picture on frames 1-124, Colour pop from 125 (CP's), against the preview
  const docAll = [clipOn(tBG, 'ReplaceBackground', {style: 'Image', color: '#ff00ff', image: key}, 'rb', 0, 124), clipOn(tBG, 'ColorPop', {style: 'Gray'}, 'cp', 124, FRAMES), ...clear()];
  await putClips(docAll);
  await sel(A);
  const shots = await preview('RB-5_picture-then-colour-pop');
  const file = await exportVideo('RB_picture-then-colour-pop');
  const frames = exportFrames(file, PARITY_FRAMES);
  const rows = PARITY_FRAMES.map((f, i) => ({frame: f + 1, ...stats(shots[i], frames[i])}));
  check('RB', rows.every(r => r.psnr >= tolerance), `export matches the preview (picture f1-124, Colour pop after): ${rows.map(r => `f${r.frame} ${r.psnr} dB`).join(', ')} (needs >= ${tolerance} dB)`, rows);
});

await step('RO', async () => {
  if (inside == null) throw new Error('no masks from RB');
  await putClips([clipOn(tBG, 'ReplaceBackground', {style: 'Image', color: '#ff00ff'}, 'rb'), ...clear()]);
  await sel(A);
  await seekTo(F3);
  const key = await pickPicture(PHONE);
  const stored = await storedPicture(key);
  check('RO', stored.hash === key && stored.width === 1280 && stored.height === 2560, `a 1600x3200 portrait stored landscape (EXIF 6) is kept upright at the size Cover needs: ${stored.width}x${stored.height}`, stored);
  const shot = pixels(await cap('RO-1_phone-photo-exif6_f101'));
  // upright: quadrants split at the frame's centre, a white band across frame rows 520-560 of 720
  const band = share(outside, i => {
    const y = Math.floor(i / shot.w) / shot.h;
    return y < 0.74 || y > 0.76 || offRgb(shot, i, [255, 255, 255]) <= PIXEL_TOL;
  });
  const quads = share(outside, i => {
    const [x, y] = [i % shot.w, Math.floor(i / shot.w)];
    return (y / shot.h > 0.68 && y / shot.h < 0.82) || nearSeam(shot, x, y) || offRgb(shot, i, quadrant(shot, x, y)) <= PIXEL_TOL;
  });
  check('RO', band.pct >= 99.5 && quads.pct >= 99.5, `drawn upright and in proportion: the white band where it belongs (${band.pct} %), each quadrant in place (${quads.pct} %)`, {band, quads});
});

await step('CP', async () => {
  if (inside == null) throw new Error('no masks from RB');
  await putClips([clipOn(tBG, 'ColorPop', {style: 'Gray'}, 'cp'), ...clear()]);
  await sel(A);
  await seekTo(F3);
  const pop = pixels(await cap('CP-1_colour-pop_f101'));
  const grey = share(outside, i => chroma(pop, i) <= PIXEL_TOL);
  const wasColour = share(outside, i => chroma(plain3, i) > 3 * PIXEL_TOL);
  const kept = share(inside, i => off(pop, plain3, i) <= PIXEL_TOL);
  const colourful = share(inside, i => chroma(plain3, i) > 40);
  check('CP', grey.pct >= 99.5 && wasColour.pct >= 5, `outside the subjects grey (${grey.pct} % within ${PIXEL_TOL} of grey; ${wasColour.pct} % of it was coloured)`, {grey, wasColour});
  check('CP', kept.pct >= 99.5 && colourful.pct * colourful.n >= 100 * 100, `inside them as the video, colour kept (${kept.pct} % of ${kept.n} px; ${Math.round((colourful.pct * colourful.n) / 100)} of them strongly coloured)`, {kept, colourful});
});

// slice 4: the Title, over the middle of A and B's masks
const MAGENTA = [255, 0, 255];
const isMagenta = (img, i) => offRgb(img, i, MAGENTA) <= 40;
// the ink's bounding box in a capture: [x0, y0, x1, y1]
const inkBox = (img, test) => {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
  for (let i = 0; i < img.w * img.h; i++) {
    if (!test(img, i)) continue;
    const [x, y] = [i % img.w, Math.floor(i / img.w)];
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  }
  return [x0, y0, x1, y1];
};
const titleShots = {};
await step('TT', async () => {
  if (inside == null || tolerance == null) throw new Error('no masks from RB or no B7 tolerance');
  // the text's centre: the middle of the subjects' masks
  let [sx, sy, n] = [0, 0, 0];
  inside.forEach((v, i) => v && ((sx += i % plain3.w), (sy += Math.floor(i / plain3.w)), n++));
  const [x, y] = [Math.round((sx / n / plain3.w) * 100) / 100, Math.round((sy / n / plain3.h) * 100) / 100];
  const SIZE = 0.25;
  const title = (params, start = 0, end = FRAMES) => clipOn(tBG, 'Title', {text: 'TITLE', size: SIZE, weight: 900, color: '#ff00ff', x, y, animation: 'None', ...params}, 'tt', start, end);
  const shot = async (clips, f, tag) => {
    await putClips(clips);
    await sel(A);
    await seekTo(f);
    return pixels((titleShots[tag] = await cap(tag)));
  };
  const front = await shot([title({placement: 'In front'}), ...clear()], F3, 'TT-1_in-front_f101');
  const behind = await shot([title({}), ...clear()], F3, 'TT-2_behind-subjects_f101');
  const box = inkBox(front, isMagenta);
  const [cx, cy] = [(box[0] + box[2]) / 2 / front.w, (box[1] + box[3]) / 2 / front.h];
  const covered = share(inside, i => isMagenta(front, i));
  check('TT', Math.abs(cx - x) < 0.02 && Math.abs(cy - y) < 0.03 && covered.pct >= 10, `In front: the text is centred at (${cx.toFixed(3)}, ${cy.toFixed(3)}) for (${x}, ${y}), and covers ${covered.pct} % of the subjects' ${covered.n} px`, {box, covered});
  const kept = share(inside, i => off(behind, plain3, i) <= PIXEL_TOL);
  const outText = share(outside, i => isMagenta(front, i));
  const sameOut = share(outside, i => off(behind, front, i) <= PIXEL_TOL);
  check('TT', kept.pct >= 99.5 && sameOut.pct >= 99.5 && outText.pct * outText.n >= 100 * 2000, `Behind subjects: the subjects as the plain video inside their masks (${kept.pct} % of ${kept.n} px), the text outside them as In front draws it (${sameOut.pct} %; ${Math.round((outText.pct * outText.n) / 100)} magenta px there)`, {kept, sameOut, outText});

  // a long line at the default size, placed at the right edge: shrunk and moved in, all of it inside the frame
  const LONG = 'A title far too long to fit across the frame at this size';
  const long = await shot([title({placement: 'In front', text: LONG, size: 0.12, weight: 700, x: 1, y: 0.5}), ...clear()], F3, 'TT-2a_long-line_right-edge_f101');
  const lbox = inkBox(long, isMagenta);
  const edge = Math.round(0.03 * long.h * 0.5); // half the margin, in capture px
  const longInk = share(new Uint8Array(long.w * long.h).fill(1), i => isMagenta(long, i));
  check('TT', lbox[0] >= edge && lbox[2] <= long.w - 1 - edge && lbox[1] >= edge && lbox[3] <= long.h - 1 - edge && longInk.pct * longInk.n >= 100 * 1500, `a long line at the default size stays inside the frame: ink x ${lbox[0]}-${lbox[2]} of ${long.w}, y ${lbox[1]}-${lbox[3]} of ${long.h} (${Math.round((longInk.pct * longInk.n) / 100)} px)`, {box: lbox});

  // a background clip below (Desaturate): the subjects stay as it drew them, not as the raw video
  const grey = await shot([clipOn(tBG, 'Desaturate', {style: 'Gray'}, 'ds'), ...clear()], F3, 'TT-2b_desaturate_f101');
  const over = await shot([clipOn(tBG, 'Desaturate', {style: 'Gray'}, 'ds'), {...title({}), row: 1}, ...clear()], F3, 'TT-2c_title-behind-over-desaturate_f101');
  const keptGrey = share(inside, i => off(over, grey, i) <= PIXEL_TOL);
  const unlikePlain = share(inside, i => off(over, plain3, i) > PIXEL_TOL);
  check('TT', keptGrey.pct >= 99.5 && unlikePlain.pct >= 5, `over Desaturate, the subjects stay grey behind the title (${keptGrey.pct} % as Desaturate alone; ${unlikePlain.pct} % unlike the colour video)`, {keptGrey, unlikePlain});

  // Inter: the ink as wide as the font file gives it in the page, at both ends of the weights
  // ("rattle": 10 % wider than the fallback sans-serif at 900, 7 % narrower at 300)
  const WORD = 'rattle';
  const measured = {};
  for (const weight of [900, 300]) {
    const img = await shot([title({placement: 'In front', text: WORD, weight}), ...clear()], F3, `TT-3_${WORD}_weight-${weight}_f101`);
    const b = inkBox(img, isMagenta);
    measured[weight] = (b[2] - b[0] + 1) * (1280 / img.w);
  }
  const want = await page.evaluate(async ([px, word]) => {
    const face = new FontFace('InterCheck', `url(${new URL('fonts/Inter-VariableFont_opsz,wght.ttf', location.href)})`, {weight: '100 900'});
    document.fonts.add(await face.load());
    const ctx = new OffscreenCanvas(8, 8).getContext('2d');
    const ink = font => {
      ctx.font = font;
      const m = ctx.measureText(word);
      return m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    };
    return Object.fromEntries([900, 300].map(w => [w, {inter: ink(`${w} ${px}px InterCheck`), fallback: ink(`${w} ${px}px sans-serif`)}]));
  }, [SIZE * 720, WORD]);
  const fonts = [900, 300].map(w => ({weight: w, measured: Math.round(measured[w]), inter: Math.round(want[w].inter), fallback: Math.round(want[w].fallback)}));
  check('TT', fonts.every(f => Math.abs(f.measured - f.inter) / f.inter < 0.015 && Math.abs(f.measured - f.fallback) > 2 * Math.abs(f.measured - f.inter)) && fonts[0].measured > fonts[1].measured * 1.05, `drawn in Inter at its weight: "${WORD}" ink ${fonts.map(f => `${f.weight}: ${f.measured} px (Inter ${f.inter}, fallback ${f.fallback})`).join('; ')}`, fonts);

  // a Fade from frame 101 over 1 s (24 frames), in front
  const plainF = await shot([...clear()], F3, 'TT-4_no-title_f101');
  await shot([title({placement: 'In front'}), ...clear()], F3 + 24, 'TT-5_in-front_f125');
  await putClips([title({placement: 'In front', animation: 'Fade', entrance: 1}, F3), ...clear()]);
  await sel(A);
  const fade = {};
  for (const k of [0, 12, 24]) {
    await seekTo(F3 + k);
    fade[k] = pixels((titleShots[`TT-6_fade_t${k}`] = await cap(`TT-6_fade-from-f101_f${F3 + k + 1}`)));
  }
  const all = new Uint8Array(plainF.w * plainF.h).fill(1);
  const start = share(all, i => off(fade[0], plainF, i) <= PIXEL_TOL);
  const end = compare(titleShots['TT-6_fade_t24'], titleShots['TT-5_in-front_f125']);
  const mid = share(all, i => isMagenta(fade[12], i));
  check('TT', start.pct >= 99.9 && end.changedPct === 0 && mid.pct > 0 && !same(compare(titleShots['TT-6_fade_t12'], titleShots['TT-5_in-front_f125'])), `Fade: nothing at the clip's first frame (${start.pct} % as without it), all of it at 1 s (${end.changedPct} % off In front), part way at 0.5 s`, {start, end, mid});

  // the settings: type into the text field, shortcut keys included
  await putClips([title({}), ...clear()]);
  await sel(A);
  await seekTo(F3);
  await page.locator('.fx-clip[data-clip="tt"]').click();
  const field = fx.getByRole('textbox', {name: 'Text', exact: true});
  const frameBefore = await frame();
  const clipsBefore = (await doc()).clips.length;
  await field.fill('');
  await page.waitForTimeout(400);
  const emptied = (await doc()).clips.find(c => c.id === 'tt').params.text;
  await page.keyboard.type('Hello, sofa. Yes\nTwo\nThree\nFour', {delay: 15});
  await page.waitForTimeout(800);
  const typed = (await doc()).clips.find(c => c.id === 'tt').params.text;
  const count = await field.evaluate(e => document.getElementById(e.getAttribute('aria-describedby'))?.innerText ?? '');
  check('TT', emptied === 'TITLE' && typed === 'Hello, sofa. Yes\nTwo\nThreeFour' && (await frame()) === frameBefore && (await doc()).clips.length === clipsBefore && new RegExp(`^${typed.length}/80 characters`).test(count), `the text field: emptied keeps "${emptied}", typing (s, o, f, y, space, Enter) gives ${JSON.stringify(typed)} (Enter on the third line does nothing), frame ${(await frame()) + 1} and ${clipsBefore} clips unchanged (Space did not play); count "${count}"`, {emptied, typed, count});
  await fx.getByRole('button', {name: 'Top', exact: true}).click();
  await page.waitForTimeout(500);
  const top = (await doc()).clips.find(c => c.id === 'tt').params;
  const pressed = await fx.getByRole('button', {name: 'Top', exact: true}).getAttribute('aria-pressed');
  titleShots['TT-7_settings'] = await fx.screenshot();
  fs.writeFileSync(path.join(OUT, 'TT-7_settings-panel.png'), titleShots['TT-7_settings']);
  titleShots['TT-8_typed-top'] = await cap('TT-8_typed_top_f101');
  const live = await page.$$eval('.effects [role=status], .effects [aria-live]', es => es.map(e => e.innerText).filter(t => /\d/.test(t)));
  check('TT', top.x === 0.5 && top.y === 0.15 && pressed === 'true' && live.length === 0, `Top puts it at (${top.x}, ${top.y}), pressed ${pressed}; no numbers in live regions (${JSON.stringify(live)})`);
  await fx.getByRole('button', {name: /^Reset to/}).click();
  await page.waitForTimeout(500);
  const reset = (await doc()).clips.find(c => c.id === 'tt').params;
  check('TT', reset.text === typed && reset.y === 0.5 && reset.size === 0.12, `Reset to defaults keeps the typed text (${JSON.stringify(reset.text)}) and resets the rest (y ${reset.y}, size ${reset.size})`, reset);

  // export, white text rising in over the whole clip, behind the subjects
  await putClips([title({color: '#ffffff', animation: 'Rise', entrance: 3}), ...clear()]);
  await sel(A);
  const shots = await preview('TT-9_rise');
  const file = await exportVideo('TT_title-rise-behind');
  const frames = exportFrames(file, PARITY_FRAMES);
  const rows = PARITY_FRAMES.map((f, i) => ({frame: f + 1, ...stats(shots[i], frames[i])}));
  check('TT', rows.every(r => r.psnr >= tolerance), `export matches the preview (Rise over 3 s, behind the subjects): ${rows.map(r => `f${r.frame} ${r.psnr} dB`).join(', ')} (needs >= ${tolerance} dB)`, rows);
});

await step('SP', async () => {
  if (inside == null) throw new Error('no masks from RB');
  const spot = async (params, tag) => {
    await putClips([clipOn(tA, 'Scope', params, 'sp')]);
    await sel(A);
    await seekTo(F3);
    return pixels(await cap(tag));
  };
  const s0 = await spot({style: 'Colour disc'}, 'SP-1_colour-disc_f101');
  const s1 = await spot({style: 'Colour disc', darken: 0.6}, 'SP-2_colour-disc_darken-0.6_f101');
  const all = new Uint8Array(s0.w * s0.h).fill(1);
  const dimmed = where(s0, (_r, _g, _b, x, y) => off(s0, s1, y * s0.w + x) > 8);
  let [l0, l1] = [0, 0];
  dimmed.forEach((v, i) => v && ((l0 += luma(s0, i)), (l1 += luma(s1, i))));
  const ratio = Math.round((l1 / l0) * 1000) / 1000;
  const changed = share(all, i => dimmed[i] === 1);
  const aKept = share(inside, i => off(s0, s1, i) <= PIXEL_TOL);
  check('SP', changed.pct >= 30 && ratio > 0.36 && ratio < 0.44 && aKept.pct >= 99.5, `darken outside 0.6: ${changed.pct} % of the frame dimmed to ${ratio} of its brightness (0.4 wanted), the subjects inside unchanged (${aKept.pct} %)`, {changed, ratio, aKept});

  // two Spotlights with different settings (two passes): one darkening, and neither dims the other's circle
  const two = async (darken, tag) => {
    await putClips([clipOn(tA, 'Scope', {style: 'Colour disc', darken}, 'sa'), clipOn(tB, 'Scope', {style: 'Colour disc', size: 1.5, darken}, 'sb')]);
    await sel(A);
    await seekTo(F3);
    return pixels(await cap(tag));
  };
  const t0 = await two(0, 'SP-4_A-and-B-discs_f101');
  const t1 = await two(0.6, 'SP-5_A-and-B-discs_darken-0.6_f101');
  const dim2 = where(t0, (_r, _g, _b, x, y) => off(t0, t1, y * t0.w + x) > 8);
  let [m0, m1] = [0, 0];
  dim2.forEach((v, i) => v && ((m0 += luma(t0, i)), (m1 += luma(t1, i))));
  const ratio2 = Math.round((m1 / m0) * 1000) / 1000;
  const discs = where(t0, (_r, _g, _b, x, y) => off(t0, plain3, y * t0.w + x) > 30);
  const discsKept = share(discs, i => off(t0, t1, i) <= PIXEL_TOL);
  check('SP', ratio2 > 0.36 && ratio2 < 0.44 && discsKept.pct >= 99, `two Spotlights, darken 0.6: the outside dimmed once, to ${ratio2} (0.4 wanted, 0.16 if compounded); both circles unchanged (${discsKept.pct} % of ${discsKept.n} px)`, {ratio2, discsKept});

  if (!process.env.BASE_SERVE) {
    console.log('SKIP SP old-style parity: BASE_SERVE not set');
    (results.SP ??= []).push({ok: true, skipped: true, what: 'old-style parity: BASE_SERVE not set'});
    await putClips([]);
    return;
  }
  const styles = ['Colour disc', 'Colour ring', 'White disc', 'White ring', 'Soft disc', 'Soft ring'];
  const rows = [];
  for (const style of styles) {
    const slug = style.toLowerCase().replace(/[^a-z]+/g, '-');
    const clips = [clipOn(tA, 'Scope', {style}, 'sp')];
    await putClips(clips, BASE_URL);
    await sel(A);
    await seekTo(F3);
    const base = await cap(`SP-3_${slug}_base-build_f101`);
    await putClips(clips, URL_);
    await sel(A);
    await seekTo(F3);
    const now = await cap(`SP-3_${slug}_this-build_f101`);
    rows.push({style, drawn: compare(ref[F3], now).changedPct, ...compare(base, now)});
  }
  check('SP', rows.every(r => r.changedPct === 0 && r.drawn > DIFF_PCT), `each old style draws pixel-identically to the base build: ${rows.map(r => `${r.style} ${r.changedPct} % (MAD ${r.mad})`).join(', ')}`, rows);
  await putClips([]);
});

await step('SC', async () => {
  if (tolerance == null) throw new Error('no B7 tolerance');
  await sel(A);
  await seekTo(100);
  await tile(0, 'Outline'); // over the whole video: its clock is the video's
  await setting('style', 'Scribble');
  const boiling = await cap('SC-1_scribble_f101');
  check('SC', differs(compare(ref[100], boiling)), 'Scribble draws on frame 101', compare(ref[100], boiling));
  await seekTo(60);
  await seekTo(100);
  const back = await cap('SC-2_scribble_f101_scrub-away-and-back');
  await seekTo(94);
  await page.keyboard.press(' ');
  await page.waitForTimeout(220);
  await page.keyboard.press(' ');
  await page.waitForTimeout(800);
  await seekTo(100);
  const played = await cap('SC-3_scribble_f101_play-pause');
  for (const [what, png] of [['scrub away and back', back], ['play/pause', played]]) {
    const s = compare(boiling, png);
    check('SC', s.changedPct === 0, `frame 101 identical after ${what}: MAD ${s.mad}`, s);
  }
  await setting('boil', '0');
  const still = await cap('SC-4_scribble_boil-0_f101');
  await seekTo(60);
  await seekTo(100);
  const stillBack = await cap('SC-5_scribble_boil-0_f101_scrub-away-and-back');
  check('SC', !same(compare(boiling, still)) && compare(still, stillBack).changedPct === 0, 'boil 8 redraws the stroke (frame 101 differs from boil 0), boil 0 is steady', {
    boil: compare(boiling, still),
    steady: compare(still, stillBack),
  });
  await setting('boil', '8');
  const shots = await preview('SC-6_scribble');
  const file = await exportVideo('SC_scribble_A');
  const frames = exportFrames(file, PARITY_FRAMES);
  const rows = PARITY_FRAMES.map((f, i) => ({frame: f + 1, ...stats(shots[i], frames[i])}));
  check('SC', rows.every(r => r.psnr >= tolerance), `export matches the preview: ${rows.map(r => `f${r.frame} ${r.psnr} dB`).join(', ')} (needs >= ${tolerance} dB)`, rows);
  await clearClips();
});

await step('GL', async () => {
  if (tolerance == null) throw new Error('no B7 tolerance');
  const sparkles = (ida, idb) => [clipOn(tA, 'Glitter', {style: 'Glitter'}, ida), clipOn(tB, 'Glitter', {style: 'Sparkle', colours: 'Multicolour'}, idb)];
  await putClips(clear());
  const plain = {};
  for (const f of [100, 101]) {
    await seekTo(f);
    plain[f] = await cap(`GL-0_plain_f${f + 1}`);
  }
  await putClips(sparkles('ga', 'gb'));
  await seekTo(100);
  const g = await cap('GL-1_glitter-A_sparkle-B_f101');
  check('GL', differs(compare(plain[100], g)), 'Glitter draws on frame 101', compare(plain[100], g));
  await seekTo(101);
  const next = await cap('GL-2_glitter_f102');
  await seekTo(60);
  await seekTo(100);
  const back = await cap('GL-3_glitter_f101_scrub-away-and-back');
  await seekTo(94);
  await page.keyboard.press(' ');
  await page.waitForTimeout(220);
  await page.keyboard.press(' ');
  await page.waitForTimeout(800);
  await seekTo(100);
  const played = await cap('GL-4_glitter_f101_play-pause');
  await reload();
  await seekTo(100);
  const fresh = await cap('GL-5_glitter_f101_fresh-worker');
  for (const [what, png] of [['scrub away and back', back], ['play/pause', played], ['a reload (fresh worker)', fresh]]) {
    const s = compare(g, png);
    check('GL', s.changedPct === 0, `frame 101 identical after ${what}: MAD ${s.mad}`, s);
  }
  // the sparkles: pixels Glitter moved off the plain video by more than 24, on frames 101 and 102
  const drawn = (png, base) => {
    const [x, y] = [pixels(png), pixels(base)];
    return where(x, (r, gg, b, px, py) => offRgb(y, py * y.w + px, [r, gg, b]) > 24);
  };
  const [m0, m1] = [drawn(g, plain[100]), drawn(next, plain[101])];
  const shared = share(m0, i => m1[i] === 1);
  check('GL', shared.n > 0 && shared.pct < 70, `the sparkles move and twinkle: ${shared.pct} % of frame 101's sparkle pixels (${shared.n}) are sparkle pixels on frame 102`, shared);
  await putClips(sparkles('ga2', 'gb2'));
  await seekTo(100);
  const reseeded = await cap('GL-6_other-clip-ids_f101');
  check('GL', !same(compare(g, reseeded)), `the same clips under other ids draw other sparkles: ${compare(g, reseeded).changedPct} % of pixels differ`, compare(g, reseeded));
  await putClips(sparkles('ga', 'gb'));
  const shots = await preview('GL-7_glitter');
  const file = await exportVideo('GL_glitter-A_sparkle-B');
  const frames = exportFrames(file, PARITY_FRAMES);
  const rows = PARITY_FRAMES.map((f, i) => ({frame: f + 1, ...stats(shots[i], frames[i])}));
  check('GL', rows.every(r => r.psnr >= tolerance), `export matches the preview: ${rows.map(r => `f${r.frame} ${r.psnr} dB`).join(', ')} (needs >= ${tolerance} dB)`, rows);
  await putClips([]);
});

await step('OB', async () => {
  await sel(A);
  await seekTo(100);
  await tile(0, 'Blur');
  const blurred = await cap('OB-1_layer-blur_f101');
  check('OB', differs(compare(ref[100], blurred)), 'the layer Blur draws on A', compare(ref[100], blurred));
  const note = await fx.locator('.effect-note').innerText();
  check('OB', /if tracking misses a frame, the subject shows/.test(note), `its settings say tracking can fail: "${note}"`);
  await setting('radius', '4');
  const wide = await cap('OB-2_layer-blur_radius-4pct_f101');
  const d = (await doc()).clips[0];
  check('OB', d.effect === 'BlurMask' && d.params.radius === 0.04 && differs(compare(blurred, wide)), `radius 4 % blurs it more (radius ${d.params.radius})`, compare(blurred, wide));
  // both Blurs (two passes each) on two frames where A stands in different places
  await tile(1, 'Blur');
  const two = {};
  for (const f of [30, 100]) {
    await seekTo(f);
    two[f] = await cap(`OB-3_background-and-layer-blur_f${f + 1}`);
  }
  const apart = compare(two[30], two[100]);
  const video = compare(ref[30], ref[100]);
  check('OB', differs(apart) && apart.changedPct >= video.changedPct / 4, `background and layer Blur draw frames 31 and 101 apart: ${apart.changedPct} % of pixels differ (the video: ${video.changedPct} %)`, {apart, video});
  await reload();
  await sel(A);
  const fresh = [];
  for (const f of [100, 30]) {
    await seekTo(f);
    fresh.push({frame: f + 1, ...compare(two[f], await cap(`OB-4_fresh-worker_f${f + 1}`))});
  }
  check('OB', fresh.every(same), `a fresh worker draws each frame the same: ${fresh.map(x => `f${x.frame} ${x.changedPct} %`).join(', ')}`, fresh);
  await clearClips();
});

await step('PH', async () => {
  await clearClips();
  const key = await page.evaluate(() => Object.keys(localStorage).find(k => k.startsWith('sam-ui-studio:effects:v2:local/')));
  const put = async clips => {
    await page.evaluate(([k, c]) => localStorage.setItem(k, JSON.stringify({version: 2, clips: c})), [key, clips]);
    await reload();
    await sel(A);
  };
  const noisy = (id, start, end, phase) => ({id, target: {kind: 'object', id: aId}, effect: 'NoisyMask', params: {style: 'Noise'}, start, end, row: 0, phase});
  const [a, s, b, k] = [40, 60, 80, 9]; // s + k = 69: B3 has the frame without clips
  await put([noisy('u', a, b, 0)]);
  await seekTo(s + k);
  const unsplit = await cap(`PH-1_noisy-${a + 1}-${b}_f${s + k + 1}`);
  await put([noisy('l', a, s, 0), noisy('r', s, b, s - a)]);
  await seekTo(s + k);
  const right = await cap(`PH-2_split-at-${s + 1}_right-half_f${s + k + 1}`);
  const cont = compare(unsplit, right);
  check('PH', differs(compare(ref[s + k], unsplit)), `Noisy draws on frame ${s + k + 1}`, compare(ref[s + k], unsplit));
  check('PH', cont.changedPct === 0, `a split's right half continues the clip: frame ${s + k + 1} identical (MAD ${cont.mad})`, cont);
  await put([noisy('u', a, 2 * b - a, 0)]);
  await seekTo(b + k);
  const carried = await cap(`PH-3_noisy-${a + 1}-${2 * b - a}_f${b + k + 1}`);
  await put([noisy('u', a, b, 0), noisy('d', b, 2 * b - a, 0)]);
  await seekTo(b + k);
  const dup = await cap(`PH-4_duplicate-${b + 1}-${2 * b - a}_phase-0_f${b + k + 1}`);
  const restart = compare(carried, dup);
  check('PH', !same(restart), `a duplicate at phase 0 restarts: frame ${b + k + 1} differs from the original carried on (${restart.changedPct} % of pixels)`, restart);
  await clearClips();
});

await step('B11', async () => {
  await seekTo(100);
  const losses0 = contextLosses();
  const bgTiles = (await group(1).locator('.effect-button > span:first-of-type').allInnerTexts()).map(t => t.trim());
  for (const t of bgTiles) await tile(1, t);
  let layerTiles = [];
  for (const r of [A, B]) {
    await sel(r);
    layerTiles = (await group(0).locator('.effect-button > span:first-of-type').allInnerTexts()).map(t => t.trim());
    for (const t of layerTiles) await tile(0, t);
  }
  await sel(A);
  await tile(0, 'Erase');
  const cycled = await cap('B11-1_after-cycling_A-erase_f101');
  const d = (await doc()).clips.map(c => `${c.target.kind === 'object' ? `obj${c.target.id}` : 'bg'}:${c.effect}`);
  check('B11', differs(compare(ref[100], cycled)), `picked ${bgTiles.length} background and 2x${layerTiles.length} layer tiles, then Erase: it draws (${d.join(', ')})`, compare(ref[100], cycled));
  const file = await exportVideo('B11_export_after-cycling');
  const s = stats(decode(cycled, small), exportFrames(file, [100])[0]);
  check('B11', tolerance != null && s.psnr >= tolerance, `export frame 101 matches the preview: ${s.psnr} dB (needs >= ${tolerance})`, s);
  await reload();
  await seekTo(100);
  await sel(A);
  const fresh = await cap('B11-2_after-reload_f101');
  check('B11', same(compare(cycled, fresh)), 'the preview after cycling matches a fresh worker drawing the same clips', compare(cycled, fresh));
  check('B11', contextLosses() - losses0 === 0, `no "Too many active WebGL contexts" while cycling and exporting (${contextLosses() - losses0})`);
});

// slice 2: split, duplicate, stack order; and Cmd-Z after each
const note = () => page.locator('.fx-note').innerText();
const undo = async (redo = false) => {
  await page.keyboard.press(redo ? 'Meta+Shift+z' : 'Meta+z');
  await page.waitForTimeout(600);
};
const identical = s => s.changedPct === 0;
let parts = null;
await step('S2', async () => {
  await clearClips();
  await sel(A);
  await seekTo(60);
  await addEffect(0, 'Noisy'); // [60, 132), selected
  const frames = [60, 95, 96, 97, 131];
  const whole = {};
  for (const f of frames) {
    await seekTo(f);
    whole[f] = await cap(`S2-split-0_noisy-whole_f${f + 1}`);
  }
  const d0 = await doc();
  await seekTo(96);
  await page.keyboard.press('s'); // focus outside the timeline: S does nothing
  await page.waitForTimeout(400);
  check('S2', JSON.stringify((await doc()).clips) === JSON.stringify(d0.clips), 'S with focus outside the timeline leaves the clip alone');
  await page.locator('.fx-clip.selected').focus();
  await page.keyboard.press('s');
  await page.waitForTimeout(600);
  const d1 = await doc();
  const [l, r] = d1.clips;
  const w = d0.clips[0];
  const label = await page.locator('.fx-clip.selected').getAttribute('aria-label');
  const said = await note();
  check('S2', d1.clips.length === 2 && l.start === 60 && l.end === 96 && l.phase === 0 && r.start === 96 && r.end === 132 && r.phase === 36 && r.id !== l.id && [l, r].every(c => c.row === w.row && c.effect === 'NoisyMask' && JSON.stringify(c.params) === JSON.stringify(w.params)), `S at frame 97 splits [60, 132) into ${d1.clips.map(c => `[${c.start}, ${c.end}) phase ${c.phase}`).join(' and ')}`, d1.clips);
  check('S2', /frames 97–132/.test(label ?? '') && /split in two/.test(said) && !/frames? \d/.test(said), `the part from the playhead is selected ("${label}"); announced without frame numbers: "${said}"`);
  const rows = [];
  for (const f of frames) {
    await seekTo(f);
    rows.push({frame: f + 1, ...compare(whole[f], await cap(`S2-split-1_split_f${f + 1}`))});
  }
  check('S2', rows.every(identical), `split: every checked frame pixel-identical to the whole clip (${rows.map(x => `f${x.frame} ${x.changedPct} %`).join(', ')})`, rows);
  await undo();
  const back = [];
  for (const f of [95, 96]) {
    await seekTo(f);
    back.push(compare(whole[f], await cap(`S2-split-2_undone_f${f + 1}`)));
  }
  check('S2', JSON.stringify((await doc()).clips) === JSON.stringify(d0.clips) && back.every(identical), 'Cmd-Z puts the whole clip back exactly', back);
  await undo(true);
  const reLabel = await page.locator('.fx-clip.selected').getAttribute('aria-label');
  check('S2', JSON.stringify((await doc()).clips) === JSON.stringify(d1.clips) && /frames 97–132/.test(reLabel ?? ''), `Shift-Cmd-Z splits it again, the right part selected as the split left it ("${reLabel}")`);
  parts = d1.clips;
});

await step('S2', async () => {
  if (parts == null) throw new Error('no split clips');
  const [, r] = parts;
  await seekTo(140);
  const plain = await cap('S2-dup-0_no-clip_f141');
  const d0 = await doc();
  await page.locator(`.fx-clip[data-clip="${r.id}"]`).click();
  await fx.getByRole('button', {name: 'Duplicate', exact: true}).click();
  await page.waitForTimeout(600);
  const d1 = await doc();
  const copy = d1.clips.at(-1);
  const label = await page.locator('.fx-clip.selected').getAttribute('aria-label');
  const said = await note();
  check('S2', d1.clips.length === 3 && copy.id !== r.id && copy.start === 132 && copy.end === 168 && copy.phase === 0 && copy.row === r.row && copy.effect === 'NoisyMask', `Duplicate puts the copy right after the original, phase 0: [${copy.start}, ${copy.end}) phase ${copy.phase} row ${copy.row}`, copy);
  check('S2', /frames 133–168/.test(label ?? '') && /duplicated right after/.test(said) && !/frames? \d/.test(said), `the copy is selected ("${label}"): "${said}"`);
  const dup = await cap('S2-dup-1_copy_f141');
  check('S2', differs(compare(plain, dup)), 'the copy draws', compare(plain, dup));
  await undo();
  const undone = await cap('S2-dup-2_undone_f141');
  const afterUndo = await page.locator('.fx-clip.selected').getAttribute('data-clip');
  check('S2', JSON.stringify((await doc()).clips) === JSON.stringify(d0.clips) && identical(compare(plain, undone)) && afterUndo === r.id, `Cmd-Z removes the copy exactly and selects the original (${afterUndo})`, compare(plain, undone));
  await undo(true);
  const redone = await cap('S2-dup-3_redone_f141');
  check('S2', JSON.stringify((await doc()).clips) === JSON.stringify(d1.clips) && identical(compare(dup, redone)), 'Shift-Cmd-Z puts it back', compare(dup, redone));
  await undo();
  // references at frame 141: a fresh Noisy clip from frame 133 (phase 0), and the right part carried on to frame 168
  await seekTo(132);
  await addEffect(0, 'Noisy');
  await seekTo(140);
  const fresh = await cap('S2-dup-4_fresh-noisy-from-f133_f141');
  await page.locator('.fx-clip.selected').click();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(400);
  await page.locator(`.fx-clip[data-clip="${r.id}"]`).click();
  await setting('last', '168');
  await seekTo(140);
  const carried = await cap('S2-dup-5_right-part-carried-on_f141');
  check('S2', same(compare(dup, fresh)), 'the copy looks like a fresh Noisy clip there (its animation from the start)', compare(dup, fresh));
  const vsCarried = compare(dup, carried);
  check('S2', !same(vsCarried), `the copy restarts the animation: frame 141 differs from the right part carried on (${vsCarried.changedPct} % of pixels)`, vsCarried);
  await clearClips();
});

await step('S2', async () => {
  await sel(A);
  await seekTo(30);
  await addEffect(0, 'Gradient'); // [30, 102), row 0
  await seekTo(150);
  await addEffect(0, 'Outline'); // [150, 222), row 1: overlaps neither of the others
  await seekTo(30);
  await addEffect(0, 'Erase'); // [30, 102), row 2: on top
  const eraseOver = await cap('S2-order-0_erase-over-gradient_f31');
  const d0 = await doc();
  const erase = d0.clips.find(c => c.effect === 'EraseForeground');
  // the tiles' effects: Erase is EraseForeground, Gradient VibrantMask
  const names = {EraseForeground: 'Erase', VibrantMask: 'Gradient', Outline: 'Outline'};
  const rowsOf = d => Object.fromEntries(d.clips.map(c => [names[c.effect], c.row]));
  await page.locator(`.fx-clip[data-clip="${erase.id}"]`).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForTimeout(600);
  const d1 = await doc();
  const gradientOver = await cap('S2-order-1_alt-down_gradient-over-erase_f31');
  const said = await note();
  const r1 = rowsOf(d1);
  check('S2', r1.Erase === 0 && r1.Gradient === 1 && r1.Outline === 2 && differs(compare(eraseOver, gradientOver)), `one Alt+Down skips the Outline clip it doesn't overlap and puts Erase under Gradient (${JSON.stringify(rowsOf(d0))} -> ${JSON.stringify(r1)}); the frame changes ${compare(eraseOver, gradientOver).changedPct} %`, compare(eraseOver, gradientOver));
  check('S2', /moved down: now drawn under Gradient/.test(said) && !/frames? \d/.test(said), `announced: "${said}"`);
  await page.keyboard.press('Alt+ArrowDown'); // nothing under it on its frames now
  await page.waitForTimeout(600);
  const stay = await note();
  const downOff = await fx.getByRole('button', {name: 'Move down', exact: true}).isDisabled();
  check('S2', JSON.stringify((await doc()).clips) === JSON.stringify(d1.clips) && /not moved: no clip under it/.test(stay) && downOff, `with no overlapping clip below, Alt+Down changes nothing and says so ("${stay}"); Move down is disabled: ${downOff}`);
  await undo();
  const undone = await cap('S2-order-2_undone_f31');
  const undoSel = await page.locator('.fx-clip.selected').getAttribute('data-clip');
  check('S2', JSON.stringify((await doc()).clips) === JSON.stringify(d0.clips) && identical(compare(eraseOver, undone)) && undoSel === erase.id, `Cmd-Z restores the order exactly, Erase still selected (${undoSel})`, compare(eraseOver, undone));
  await undo(true);
  const redoSel = await page.locator('.fx-clip.selected').getAttribute('data-clip');
  check('S2', JSON.stringify((await doc()).clips) === JSON.stringify(d1.clips) && identical(compare(gradientOver, await cap('S2-order-3_redone_f31'))) && redoSel === erase.id, `Shift-Cmd-Z swaps them again, Erase still selected (${redoSel})`);
  await page.locator(`.fx-clip[data-clip="${erase.id}"]`).click();
  await fx.getByRole('button', {name: 'Move up', exact: true}).click();
  await page.waitForTimeout(600);
  const up = await cap('S2-order-4_move-up_f31');
  const r2 = rowsOf(await doc());
  check('S2', r2.Erase > r2.Gradient && identical(compare(eraseOver, up)), `Move up in the settings puts Erase back over Gradient (${JSON.stringify(r2)})`, compare(eraseOver, up));
  // which one is on top, as B5 measures it (Gradient's LUT is random per setup, so no rebuilt reference):
  // with Erase on top Gradient barely shows against Erase alone; moved over it, it does
  const gradient = d0.clips.find(c => c.effect === 'VibrantMask');
  await page.locator(`.fx-clip[data-clip="${gradient.id}"]`).click();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  const eraseOnly = await cap('S2-order-5_erase-only_f31');
  const under = compare(eraseOnly, eraseOver);
  const over = compare(eraseOnly, gradientOver);
  check('S2', differs(over) && under.changedPct < over.changedPct / 4, `the swap changes which one is drawn on top: Gradient under Erase changes ${under.changedPct} % of Erase alone, moved over it ${over.changedPct} %`, {under, over});
  await clearClips();
});

await step('B8', async () => {
  await harvest();
  const inference = Object.fromEntries(Object.entries(counted.calls).filter(([m]) => INFERENCE.includes(m)));
  check('B8', (counted.calls.setEffectDoc ?? 0) > 0, `the worker log saw the clip edits (${counted.calls.setEffectDoc ?? 0} setEffectDoc calls)`, counted.calls);
  check('B8', Object.keys(inference).length === 0 && counted.jobs === 0 && counted.chips === 0, `no segmentation or tracking while editing clips: calls ${JSON.stringify(inference)}, jobs ${counted.jobs}, job chip seen ${counted.chips}x`);
});

await step('B4', async () => {
  await clearClips();
  await sel(A);
  await tile(0, 'Noisy');
  // an absent mark makes a layer stale, and the "changed layer" strip above the
  // viewer shrinks it: mark B's last frame absent first, so every capture has the strip
  const markAbsent = async (id, f) => {
    await seekTo(f);
    await page.locator(`[data-lane="${id}"] .lane-actions button`).click();
    await page.click('.lane-action-menu button:has-text("Mark absent")');
    await page.waitForFunction(id => document.querySelectorAll(`[data-lane="${id}"] .swimlane-absent`).length > 0, id, {timeout: 20000});
    await page.waitForTimeout(800);
  };
  await markAbsent(bId, FRAMES - 1);
  await sel(B);
  const pre = {};
  for (const f of [50, 80, 120]) {
    await seekTo(f);
    pre[f] = await cap(`B4-0_noisy_f${f + 1}_before-absent`);
  }
  const before = (await doc()).clips[0];
  await markAbsent(aId, 70);
  const absent = await page.$$eval(`[data-lane="${aId}"] .swimlane-absent`, es => es.map(e => e.getAttribute('aria-label')));
  const after = (await doc()).clips[0];
  check('B4', after.start === before.start && after.end === before.end, `the clip keeps its frames [${after.start}, ${after.end}) with A absent: ${absent.join('; ')}`);
  const post = {};
  for (const f of [50, 80, 120]) {
    await seekTo(f);
    post[f] = await cap(`B4-1_noisy_f${f + 1}_after-absent`);
  }
  const [s50, s80, s120] = [50, 80, 120].map(f => compare(pre[f], post[f]));
  check('B4', same(s50) && differs(s80), `Noisy unchanged before the span (f51 ${s50.changedPct} %), gone inside it (f81 ${s80.changedPct} %)`, {s50, s80});
  check('B4', s120.changedPct === 0, `on its return (f121) Noisy is as it was, not restarted (MAD ${s120.mad})`, s120);
  await sel(A);
  // the same clip as a red Outline: none of it inside the span
  await tile(0, 'Outline');
  await setting('color', '#ff0000');
  await setting('width', '2');
  const reds = {};
  for (const f of [50, 80, 120]) {
    await seekTo(f);
    reds[f] = red(await cap(`B4-2_red-outline_f${f + 1}`));
  }
  check('B4', reds[50] > 200 && reds[120] > 200 && reds[80] < reds[50] * 0.05, `outline red px: f51 ${reds[50]}, f81 (absent) ${reds[80]}, f121 ${reds[120]}`, reds);
});

const real = errors.filter(e => !/NetworkError|access control checks/.test(e));
check('page', real.length === 0, `no page errors${real.length ? `: ${real.slice(0, 3).join(' | ')}` : ''}`);
check('B11', contextLosses() === 0, `Chrome stderr has no "Too many active WebGL contexts" over the whole run (${contextLosses()})`);
const glErrors = stderr.split('\n').filter(l => /GL_INVALID|Feedback loop/.test(l));
check('GL', glErrors.length === 0, `Chrome stderr has no GL errors over the whole run (${glErrors.length}${glErrors.length ? `: ${glErrors[0].slice(-140)}` : ''})`);
fs.writeFileSync(path.join(OUT, 'chrome-stderr.log'), stderr);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({failed, results, inferenceCalls: counted}, null, 2));
await browser.close().catch(() => {});
chrome.kill();
await new Promise(r => chrome.once('exit', r));
fs.rmSync(profile, {recursive: true, force: true});
server?.close();
console.log(failed === 0 ? 'EFFECTS OK' : `EFFECTS FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
