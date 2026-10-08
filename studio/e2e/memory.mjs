// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Memory over a long track in the browser-only build: headed Chrome (the
// browser engine needs WebGPU), a fresh profile, one object tracked from
// frame 0 to the end of a synthetic clip, Chrome's memory sampled all the
// way, then the masks exported and checked against the clip. macOS only
// (it reads `footprint`).
//
//   VITE_BROWSER_MAX_SECONDS=900 npm run build:pages   # the build must accept the clip
//   CLIP_SECONDS=300 SERVE=dist-pages npm run memory
//
// It makes the clip with ffmpeg if it is not there yet (OUT/clip<CLIP_SECONDS>-720.mp4:
// 1280x720, 24 fps, a 160 px red square moving over a grid), opens it,
// clicks the square on frame 0, tracks, exports the mask videos and scores
// every IOU_EVERY-th mask against the square's red pixels in the clip.
// Every EVERY seconds it writes a row to OUT/memory-clip<CLIP_SECONDS>-720.csv:
//   - chrome_mb: physical footprint (macOS `footprint`, the figure Activity
//     Monitor shows as Memory) of every Chrome process this run started,
//     split into gpu, renderer and other;
//   - vt_mb: VideoToolbox decoder services that appeared after launch
//     (Chrome decodes through them); total_mb = chrome_mb + vt_mb;
//   - js_heap_mb: the page's used JS heap (performance.memory);
//   - uasm_mb: performance.measureUserAgentSpecificMemory(), which needs
//     cross-origin isolation, so it is blank for the Pages build;
//   - pressure: kern.memorystatus_vm_pressure_level (1 normal, 2 warn,
//     4 critical). The run stops at critical.
// OUT/memory-clip<CLIP_SECONDS>-720.json has the summary: frames, time, memory at the
// start, the plateau (median of the second half of tracking), the peak and
// the IoU. It exits non-zero if the track did not finish or the masks went
// wrong.
//
// Settings (env): CLIP_SECONDS (300; not SECONDS, which shells keep for themselves), CLIP (a clip of your own; no IoU then),
// URL (http://127.0.0.1:7999/sam-ui/), SERVE (a build folder to serve at
// URL, e.g. dist-pages), OUT (/private/tmp/sam-ui-memory), EVERY (5 s),
// IOU_EVERY (240 frames), MIN_IOU (0.9), EXPORT (1; 0 skips the export and
// the IoU), MASK (score a mask video exported earlier against the clip,
// with no browser), OPEN_ONLY (1 stops once the clip is open: no model, no WebGPU
// work, for checking the build and the sampler), CLICK (x,y of the click on
// frame 0 as fractions of the frame, for a CLIP of your own), BROWSER and
// CHROME / FIREFOX (see browser.mjs). Outside Chrome the footprint covers the
// browser processes this run started (not WebKit's XPC services), unsplit,
// and js_heap_mb is blank.
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {serve} from './static-server.mjs';
import path from 'node:path';
import {BROWSER, launch, newPage} from './browser.mjs';

const SECONDS = Number(process.env.CLIP_SECONDS ?? 300);
const OUT = process.env.OUT ?? '/private/tmp/sam-ui-memory';
const URL_ = process.env.URL ?? 'http://127.0.0.1:7999/sam-ui/';
const EVERY = Number(process.env.EVERY ?? 5) * 1000;
const IOU_EVERY = Number(process.env.IOU_EVERY ?? 240);
const MIN_IOU = Number(process.env.MIN_IOU ?? 0.9);
const EXPORT = process.env.EXPORT !== '0';
const OPEN_ONLY = process.env.OPEN_ONLY === '1';
const FPS = 24;
// the synthetic clip: the square's top-left corner at time t (ffmpeg expressions)
const SQUARE = {size: 160, x: '400+300*sin(t/3)', y: '280+120*cos(t/4)'};
const SYNTHETIC = process.env.CLIP == null;
const CLIP = process.env.CLIP ?? path.join(OUT, `clip${SECONDS}-720.mp4`);
// the square's centre on frame 0, as a fraction of the 1280x720 frame
const CLICK = process.env.CLICK?.split(',').map(Number) ?? [(400 + SQUARE.size / 2) / 1280, (280 + 120 + SQUARE.size / 2) / 720];
const STEM = path.join(OUT, `memory-${path.basename(CLIP).replace(/\.[^.]+$/, '')}`);

fs.mkdirSync(OUT, {recursive: true});

function makeClip() {
  if (fs.existsSync(CLIP)) {
    return;
  }
  console.log(`making ${CLIP} (${SECONDS} s)`);
  const sq = `color=c=0xd03020:s=${SQUARE.size}x${SQUARE.size}:d=${SECONDS}:r=${FPS}`;
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x607080:s=1280x720:d=${SECONDS}:r=${FPS}`, '-f', 'lavfi', '-i', sq]
      .concat(['-filter_complex', `[0]drawgrid=w=64:h=64:t=2:c=0x8090a0[bg];[bg][1]overlay=x='${SQUARE.x}':y='${SQUARE.y}':shortest=1,format=yuv420p`])
      .concat(['-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', CLIP]),
    {stdio: 'inherit'},
  );
}


const ps = () =>
  execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {encoding: 'utf8', maxBuffer: 1 << 26})
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return {pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]};
    });
const VT = /VTDecoderXPCService/;
const PROCESS = {chrome: /Google Chrome/, firefox: /Firefox\.app/, webkit: /Playwright\.app/}[BROWSER];
const vtBefore = new Set(ps().filter(p => VT.test(p.cmd)).map(p => p.pid));

/** Physical footprint in MB of Chrome processes started by this run, and the new VideoToolbox services. */
function memory() {
  const all = ps();
  const mine = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) {
      if (!mine.has(p.pid) && mine.has(p.ppid)) {
        mine.add(p.pid);
        grew = true;
      }
    }
  }
  const chrome = all.filter(p => mine.has(p.pid) && PROCESS.test(p.cmd));
  const vt = all.filter(p => VT.test(p.cmd) && !vtBefore.has(p.pid));
  const pids = [...chrome, ...vt].map(p => String(p.pid));
  const mb = {};
  if (pids.length > 0) {
    const json = path.join(OUT, '.footprint.json');
    spawnSync('footprint', ['--noCategories', '-j', json, ...pids], {stdio: 'ignore'});
    try {
      for (const p of JSON.parse(fs.readFileSync(json, 'utf8')).processes) {
        mb[p.pid] = p.footprint / 2 ** 20;
      }
    } catch {
      // a process exited between ps and footprint
    }
  }
  const sum = list => Math.round(list.reduce((s, p) => s + (mb[p.pid] ?? 0), 0));
  const gpu = sum(chrome.filter(p => p.cmd.includes('--type=gpu-process')));
  const renderer = sum(chrome.filter(p => p.cmd.includes('--type=renderer')));
  const chromeMb = sum(chrome);
  const vtMb = sum(vt);
  return {chrome_mb: chromeMb, gpu_mb: gpu, renderer_mb: renderer, other_mb: chromeMb - gpu - renderer, vt_mb: vtMb, total_mb: chromeMb + vtMb};
}

const pressure = () => Number(execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {encoding: 'utf8'}).trim());

makeClip();
const nFrames = Number(
  execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', CLIP], {
    encoding: 'utf8',
  }).trim(),
);
if (process.env.MASK != null) {
  const r = iou(process.env.MASK);
  const v = r.scores.map(x => x.iou);
  console.log(JSON.stringify({sampled: r.frames, expected: r.expected, min: Math.min(...v), mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4)}));
  process.exit(r.frames === r.expected && Math.min(...v) >= MIN_IOU ? 0 : 1);
}
const server = process.env.SERVE != null ? await serve(process.env.SERVE, URL_) : null;

const COLUMNS = ['t_s', 'phase', 'frame', 'of', 'total_mb', 'chrome_mb', 'gpu_mb', 'renderer_mb', 'other_mb', 'vt_mb', 'js_heap_mb', 'uasm_mb', 'pressure'];
const csv = `${STEM}.csv`;
fs.writeFileSync(csv, COLUMNS.join(',') + '\n');
const rows = [];
const t0 = Date.now();
let phase = 'start';
let page = null;
let critical = false;

async function sample() {
  const progress = await page
    ?.$eval('.job-chip .muted', e => e.innerText)
    .catch(() => '');
  const [frame, of] = (progress ?? '').split('/').map(n => (/^\d+$/.test(n?.trim()) ? Number(n) : ''));
  const js = await page
    ?.evaluate(async () => {
      const heap = performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : null;
      let uasm = null;
      if (self.crossOriginIsolated && performance.measureUserAgentSpecificMemory) {
        const r = await Promise.race([performance.measureUserAgentSpecificMemory(), new Promise(ok => setTimeout(ok, 3000))]);
        uasm = r ? r.bytes / 2 ** 20 : null;
      }
      return {heap, uasm};
    })
    .catch(() => null);
  const r = {
    t_s: Math.round((Date.now() - t0) / 1000),
    phase,
    frame: frame ?? '',
    of: of ?? '',
    ...memory(),
    js_heap_mb: js?.heap != null ? Math.round(js.heap) : '',
    uasm_mb: js?.uasm != null ? Math.round(js.uasm) : '',
    pressure: pressure(),
  };
  rows.push(r);
  fs.appendFileSync(csv, COLUMNS.map(c => r[c]).join(',') + '\n');
  if (r.pressure >= 4) {
    critical = true;
  }
  return r;
}

/** Waits for a condition in the page, sampling memory as it goes. */
async function until(what, fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last = 0;
  for (;;) {
    if (await page.evaluate(fn).catch(() => false)) {
      return;
    }
    if (Date.now() - last >= EVERY) {
      last = Date.now();
      const r = await sample();
      console.log(`${r.t_s}s ${r.phase} ${r.frame}${r.of ? '/' + r.of : ''} total ${r.total_mb} MB (gpu ${r.gpu_mb}, renderer ${r.renderer_mb}) heap ${r.js_heap_mb} MB p${r.pressure}`);
      if (critical) {
        throw new Error(`critical memory pressure while ${what}: stopped`);
      }
    }
    if (Date.now() > end) {
      throw new Error(`timed out ${what}`);
    }
    await new Promise(ok => setTimeout(ok, 500));
  }
}

/** Every IOU_EVERY-th frame (and the last) as raw planes, from ffmpeg. */
function frames(file, pixFmt, bytesPerPixel) {
  const pick = `select='not(mod(n\\,${IOU_EVERY}))+eq(n\\,${nFrames - 1})'`;
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `${pick},scale=1280:720,format=${pixFmt}`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], {
    maxBuffer: 1 << 30,
  });
  const size = 1280 * 720 * bytesPerPixel;
  return Array.from({length: out.length / size}, (_, i) => out.subarray(i * size, (i + 1) * size));
}

function iou(maskFile) {
  const masks = frames(maskFile, 'gray', 1);
  const clip = frames(CLIP, 'rgb24', 3);
  const index = [...Array.from({length: Math.ceil(nFrames / IOU_EVERY)}, (_, i) => i * IOU_EVERY)];
  if (index[index.length - 1] !== nFrames - 1) {
    index.push(nFrames - 1);
  }
  const scores = [];
  for (let i = 0; i < Math.min(masks.length, clip.length); i++) {
    let inter = 0;
    let union = 0;
    for (let k = 0; k < 1280 * 720; k++) {
      const truth = clip[i][k * 3] > 150 && clip[i][k * 3 + 1] < 100;
      const got = masks[i][k] > 127;
      inter += truth && got ? 1 : 0;
      union += truth || got ? 1 : 0;
    }
    scores.push({frame: index[i], iou: union > 0 ? +(inter / union).toFixed(4) : 1});
  }
  return {frames: masks.length, expected: index.length, scores};
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/** OPEN_ONLY's early, successful end. */
class Stop extends Error {}

let browser = null;
const summary = {browser: BROWSER, clip: CLIP, seconds: SECONDS, frames: nFrames, url: URL_, started: new Date().toISOString()};
const errors = [];
const consoleErrors = [];
let failed = false;
try {
  console.log(`memory_pressure level ${pressure()} before launch`);
  browser = await launch(['--enable-precise-memory-info']);
  page = await newPage(browser, {width: 1400, height: 860});
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto(URL_);
  await page.waitForSelector('.dropzone', {timeout: 60000});
  phase = 'idle';
  await sample();

  phase = 'opening';
  await page.setInputFiles('.dropzone input[type=file]', CLIP);
  await until('opening the clip', () => document.querySelector('.media-item.selected .media-name')?.title?.startsWith('local/'), 600000);
  await until('reading the clip', () => /\/ [1-9]/.test(document.querySelector('.frame-counter')?.innerText ?? '') && !/decoding/.test(document.querySelector('.frame-counter')?.innerText ?? ''), 900000);
  await page.waitForTimeout(8000);
  phase = 'opened';
  summary.opened = await sample();
  if (OPEN_ONLY) {
    throw new Stop();
  }

  phase = 'clicking';
  const b = await page.$eval('.click-layer', e => {
    const r = e.getBoundingClientRect();
    return {x: r.left, y: r.top, w: r.width, h: r.height};
  });
  await page.mouse.click(b.x + CLICK[0] * b.w, b.y + CLICK[1] * b.h);
  await until('the first mask (the model downloads first)', () => document.querySelectorAll('.swimlane-segment').length >= 1, 600000);
  await page.waitForTimeout(2000);
  phase = 'clicked';
  summary.clicked = await sample();

  phase = 'tracking';
  const tt = Date.now();
  await page.click('.cta');
  // ~0.3 s a frame at 720p; allow 1.5 s
  await until('tracking', () => !document.querySelector('.job-chip') && document.querySelector('.cta')?.innerText === 'Nothing to track', 60000 + nFrames * 1500);
  summary.trackSeconds = Math.round((Date.now() - tt) / 1000);
  summary.secondsPerFrame = +(summary.trackSeconds / nFrames).toFixed(3);
  phase = 'tracked';
  await page.waitForTimeout(3000);
  summary.tracked = await sample();
  const row = await page.$eval('.object-row .layer-summary', e => e.innerText.replace(/\n/g, ' ')).catch(() => '');
  summary.objectRow = row;

  const track = rows.filter(r => r.phase === 'tracking' && r.frame !== '');
  const totals = track.map(r => r.total_mb);
  const half = track.slice(Math.floor(track.length / 2)).map(r => r.total_mb);
  const q = Math.max(1, Math.floor(track.length / 4));
  summary.memoryMb = {
    beforeTrack: summary.clicked.total_mb,
    plateauMedian: median(half),
    secondHalfRange: half.length ? [Math.min(...half), Math.max(...half)] : null,
    peak: totals.length ? Math.max(...totals) : null,
    peakByQuarter: [0, 1, 2, 3].map(i => track.slice(i * q, i === 3 ? undefined : (i + 1) * q).map(r => r.total_mb)).map(xs => (xs.length ? Math.max(...xs) : null)),
    peakJsHeap: Math.max(0, ...rows.map(r => Number(r.js_heap_mb) || 0)),
    peakPressure: Math.max(...rows.map(r => r.pressure)),
  };
  summary.lastProgress = track.length ? `${track[track.length - 1].frame}/${track[track.length - 1].of}` : null;

  if (EXPORT) {
    phase = 'exporting';
    await page.click('.export-menu > button');
    await page.click('.menu-item:has-text("Mask videos")');
    await page.waitForSelector('.modal');
    const done = {v: null, error: null};
    // Observe rejection before clicking: even a failed click closes the page
    // in finally, which rejects any outstanding download wait.
    page.waitForEvent('download', {timeout: 3600000}).then(
      d => { done.v = d; },
      error => { done.error = error; },
    );
    await page.click('.modal button.primary');
    for (let last = 0; done.v == null; ) {
      if (done.error != null) throw done.error;
      if (Date.now() - last >= EVERY) {
        last = Date.now();
        await sample();
        if (critical) {
          throw new Error('critical memory pressure while exporting: stopped');
        }
      }
      await page.waitForTimeout(500);
    }
    const zip = path.join(OUT, done.v.suggestedFilename());
    await done.v.saveAs(zip);
    phase = 'exported';
    summary.exported = await sample();
    const mp4 = execFileSync('unzip', ['-Z1', zip], {encoding: 'utf8'})
      .split('\n')
      .find(n => n.endsWith('.mp4'));
    const maskFile = path.join(OUT, 'mask.mp4');
    fs.writeFileSync(maskFile, execFileSync('unzip', ['-p', zip, mp4], {maxBuffer: 1 << 30}));
    summary.maskFrames = Number(
      execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', maskFile], {encoding: 'utf8'}).trim(),
    );
    if (SYNTHETIC) {
      const r = iou(maskFile);
      const v = r.scores.map(s => s.iou);
      summary.iou = {sampled: r.frames, expected: r.expected, min: Math.min(...v), mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4), scores: r.scores};
      if (r.frames !== r.expected || summary.iou.min < MIN_IOU) {
        failed = true;
      }
    }
    fs.rmSync(zip, {force: true});
  }
  if (summary.maskFrames != null && summary.maskFrames !== nFrames) {
    failed = true;
  }
} catch (e) {
  if (!(e instanceof Stop)) {
    failed = true;
    summary.error = String(e);
    console.error(e);
  }
} finally {
  summary.criticalPressure = critical;
  summary.pageErrors = errors.filter(e => !/WebGL context|NetworkError|access control checks|Inter-VariableFont/.test(e)).slice(0, 5);
  summary.consoleErrors = consoleErrors.slice(0, 10);
  summary.samples = rows.length;
  summary.csv = csv;
  fs.writeFileSync(`${STEM}.json`, JSON.stringify(summary, null, 1));
  await browser?.close().catch(() => {});
  server?.close();
}
const {scores: _scores, ...iouShort} = summary.iou ?? {};
console.log(JSON.stringify({...summary, iou: summary.iou ? iouShort : undefined, opened: undefined, clicked: undefined, tracked: undefined, exported: undefined}, null, 1));
console.log(failed ? 'MEMORY RUN FAILED' : 'MEMORY RUN OK');
process.exit(failed ? 1 : 0);
