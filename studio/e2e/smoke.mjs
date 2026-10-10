// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// End-to-end smoke test of studio in headless Chrome (a fresh profile each
// run), against a running studio and backend:
//
//   python studio/e2e/make_clip.py /some/dir/clip.mp4 $RANDOM   # backend venv
//   CLIP=/some/dir/clip.mp4 STUDIO_URL=http://127.0.0.1:7362 API=http://127.0.0.1:7363 npm run smoke
//
// It uploads the clip, adds three objects and tracks them, gives A Original
// and B Pixelate (C untouched), reloads (objects, tracks and effects come
// back), exports the video (saved as OUT/export.mp4 for ffprobe), and deletes
// the upload. Any failed check exits non-zero. CHROME can point at a Chrome
// binary (default: the macOS app).
//
// SMOKE=local runs the no-server check instead (e2e/smoke-local.mjs, headed
// Chrome for WebGPU, or whichever browser BROWSER names: see e2e/browser.mjs)
// against NO_SERVER_URL, a studio with no backend such as the Pages build
// served under /sam-ui/; SMOKE=both runs the two:
//
//   CLIP=... SMOKE=local NO_SERVER_URL=http://127.0.0.1:7390/sam-ui/ npm run smoke
import {chromium} from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import {runNoServer} from './smoke-local.mjs';

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7362';
const API = process.env.API ?? 'http://127.0.0.1:7363';
const CLIP = process.env.CLIP;
const OUT = process.env.OUT ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'out');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Chrome flags; the default is software WebGL, so Meta's GL effects run headless
const CHROME_ARGS = (process.env.CHROME_ARGS ?? '--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist')
  .split(' ')
  .filter(Boolean);
const EFFECT_A = process.env.EFFECT_A ?? 'Original';
const EFFECT_B = process.env.EFFECT_B ?? 'Pixelate';
if (CLIP == null) {
  console.error('set CLIP to a synthetic clip (see e2e/make_clip.py)');
  process.exit(2);
}
fs.mkdirSync(OUT, {recursive: true});

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const MODE = process.env.SMOKE ?? 'server';
const noServer = () =>
  runNoServer({url: process.env.NO_SERVER_URL ?? 'http://127.0.0.1:7390/sam-ui/', clip: CLIP, out: OUT, check});
if (MODE === 'local') {
  await noServer();
  console.log(failed === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: CHROME_ARGS,
});
const context = await browser.newContext({viewport: {width: 1440, height: 900}, acceptDownloads: true});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

const rows = () => page.$$eval('.object-row', rs => rs.map(r => r.innerText.split('\n').slice(0, 2).join(' ')));
const openName = () => page.$eval('.media-item.selected .media-name', e => e.title.split('/').pop()).catch(() => '(none)');
const idle = () =>
  page.waitForFunction(() => !document.querySelector('.job-chip') && document.querySelector('.cta')?.innerText === 'Nothing to track', null, {
    timeout: 300000,
  });
const clickAt = async (nx, ny) => {
  const b = await page.$eval('.click-layer', e => {
    const r = e.getBoundingClientRect();
    return {x: r.left, y: r.top, w: r.width, h: r.height};
  });
  await page.mouse.click(b.x + nx * b.w, b.y + ny * b.h);
};
const select = i => page.click(`.object-row >> nth=${i}`);
const pickEffect = async title => {
  await page.click(`.effect-grid .effect-button:has-text("${title}") >> nth=0`);
  await page.waitForTimeout(400);
};
const shownEffect = () => page.$eval('.effect-group-title >> nth=0', e => e.innerText.split('\n').pop());

await page.goto(STUDIO);
await page.waitForSelector('.media-item', {timeout: 30000});

// upload: it opens the new video
await page.setInputFiles('.dropzone input[type=file]', CLIP);
await page.waitForFunction(() => !document.querySelector('.dropzone.busy'), null, {timeout: 120000});
const uploaded = await openName();
check(uploaded.endsWith('.mp4') && (await page.$('.media-error')) == null, `upload opens ${uploaded}`);
await page.waitForFunction(() => !document.querySelector('.stage-overlay'), null, {timeout: 60000});
await page.waitForFunction(() => !/decoding/.test(document.querySelector('.frame-counter')?.innerText ?? ''), null, {timeout: 60000});

// three objects, tracked
await clickAt(0.1875, 0.375); // A: red disc
await page.waitForTimeout(1500);
await page.click('button:has-text("Add object")');
await clickAt(0.766, 0.729); // B: blue square
await page.waitForTimeout(1500);
await page.click('button:has-text("Add object")');
await clickAt(0.781, 0.25); // C: green disc
await page.waitForFunction(() => document.querySelectorAll('.object-row').length === 3, null, {timeout: 30000});
await page.waitForTimeout(1500);
await page.click('.cta');
await idle();
check((await rows()).every(r => r.includes('TRACKED')), `track: ${JSON.stringify(await rows())}`);

// per-object effects (Nate's sequence): focus A, Original; focus B: A keeps it; B Pixelate
if ((await page.$('.effect-grid')) == null) {
  await page.click('.effect-group-title >> nth=0');
}
await select(0);
await pickEffect(EFFECT_A);
check((await shownEffect()) === EFFECT_A, `A shows ${EFFECT_A}`);
await select(1);
check((await shownEffect()) === 'Overlay', 'B, untouched, shows Overlay');
await pickEffect(EFFECT_B);
await select(0);
check((await shownEffect()) === EFFECT_A, `A is still ${EFFECT_A} after B changed`);
await select(2);
check((await shownEffect()) === 'Overlay', 'C is untouched');

// reload: objects, tracks and effects come back
await page.reload();
await page.waitForSelector('.object-row', {timeout: 60000});
await page.waitForFunction(() => document.querySelectorAll('.swimlane-segment').length >= 3, null, {timeout: 60000});
check((await rows()).length === 3 && (await rows()).every(r => r.includes('TRACKED')), 'reload restores objects and tracks');
if ((await page.$('.effect-grid')) == null) {
  await page.click('.effect-group-title >> nth=0');
}
await select(0);
const a = await shownEffect();
await select(1);
const b = await shownEffect();
check(a === EFFECT_A && b === EFFECT_B, `reload keeps effects (A ${a}, B ${b})`);
await page.screenshot({path: path.join(OUT, 'preview.png')});

// export: an MP4 with each object's own effect
await page.waitForFunction(() => !/decoding/.test(document.querySelector('.frame-counter')?.innerText ?? ''), null, {timeout: 60000});
await page.click('.export-menu > button');
await page.click('.menu-item:has-text("Video with effects")');
await page.waitForSelector('.modal');
const [download] = await Promise.all([page.waitForEvent('download', {timeout: 180000}), page.click('.modal button:has-text("Export MP4")')]);
const file = path.join(OUT, 'export.mp4');
await download.saveAs(file);
check(fs.statSync(file).size > 10000, `export saved ${file} (${fs.statSync(file).size} bytes)`);
const exportError = await page.$eval('.modal .media-error', e => e.innerText).catch(() => null);
// it plays in Chrome's <video>: loads, has the clip's length, reaches the end
const played = await page.evaluate(async b64 => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const video = document.createElement('video');
  video.muted = true;
  video.src = URL.createObjectURL(new Blob([bytes], {type: 'video/mp4'}));
  await new Promise((ok, bad) => {
    video.onloadedmetadata = ok;
    video.onerror = () => bad(new Error(`video error ${video.error?.code}`));
  });
  const duration = video.duration;
  await video.play();
  await new Promise(ok => (video.onended = ok));
  return {duration, ended: video.ended, width: video.videoWidth, height: video.videoHeight};
}, fs.readFileSync(file).toString('base64'));
check(played.ended && played.duration > 0, `export plays in <video>: ${JSON.stringify(played)}`);
check(exportError == null, `export without error${exportError ? `: ${exportError}` : ''}`);
await page.click('.modal button:has-text("Close")');

// delete the upload (it is open: its session closes first)
await page.click('.media-row:has(.media-item.selected) .media-remove');
await page.waitForSelector('.modal');
await page.click('.modal .button.danger');
await page.waitForFunction(() => !document.querySelector('.modal') || document.querySelector('.modal .media-error'), null, {timeout: 60000});
const refusal = await page.$eval('.modal .media-error', e => e.innerText).catch(() => null);
const vids = await (
  await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({query: '{ videos { edges { node { path } } } }'}),
  })
).json();
const listed = vids.data.videos.edges.some(e => e.node.path.endsWith(uploaded));
check(refusal == null && !listed, `delete removes ${uploaded}${refusal ? ` (refused: ${refusal})` : ''}`);

const real = errors.filter(e => !/WebGL context|NetworkError/.test(e));
check(real.length === 0, `no page errors${real.length ? `: ${real.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
if (MODE === 'both') {
  await noServer();
}
console.log(failed === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
