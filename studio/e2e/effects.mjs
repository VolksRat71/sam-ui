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
//   B11 every background and layer tile picked in turn, then Erase: the preview
//       matches a reloaded (fresh) worker, the export matches the preview, and
//       Chrome logged no "Too many active WebGL contexts"
//   B8  from the end of tracking to here: no segmentation or tracking call
//       reached the video worker, no job started, no job chip showed
//   B4  frames 71-120 of A marked absent (lane actions; B's last frame first, so
//       the viewer keeps its size): the clip keeps its frames, A's effect is gone
//       there and comes back on frame 121 as it was
// Previews are compared as screenshots of the viewer canvas, decoded with
// ffmpeg (as memory.mjs does). Captures, exports, results.json and Chrome's
// stderr go to OUT. Any failed check exits non-zero.
//
// GPU: the caller holds the machine's GPU lock (nothing in the repo takes
// it) until the `setup` line prints: the browser engine runs the model only
// for the clicks and the track before it. The checks after it only draw.
//
// Settings (env): URL (http://127.0.0.1:7488/sam-ui/), SERVE (a build folder
// to serve at URL), OUT (e2e/out/effects), CHROME (its binary), CDP_PORT (9493).
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
const decode = (input, vf) =>
  execFileSync('ffmpeg', ['-v', 'error', '-i', Buffer.isBuffer(input) ? 'pipe:0' : input, ...(vf ? ['-vf', vf] : []), '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
    input: Buffer.isBuffer(input) ? input : undefined,
    maxBuffer: 1 << 30,
  });
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

const server = process.env.SERVE ? await serve(process.env.SERVE, URL_) : null;
// a fresh profile; Chrome's stderr kept for B11
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-ui-effects-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu', '--enable-logging=stderr', 'about:blank'], {
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
  await group(gi).locator('.effect-button', {hasText: new RegExp(`^${title}`)}).first().click();
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
  if (what === 'width') await fx.locator('input[type=number][aria-label^="Width"]').fill(value);
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
fs.writeFileSync(path.join(OUT, 'chrome-stderr.log'), stderr);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({failed, results, inferenceCalls: counted}, null, 2));
await browser.close().catch(() => {});
chrome.kill();
await new Promise(r => chrome.once('exit', r));
fs.rmSync(profile, {recursive: true, force: true});
server?.close();
console.log(failed === 0 ? 'EFFECTS OK' : `EFFECTS FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
