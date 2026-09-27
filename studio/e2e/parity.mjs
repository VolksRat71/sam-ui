// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Parity of the browser SAM 2.1 tiny engine with Python SAM 2.1 tiny, on the
// committed fixtures in e2e/fixtures/parity/ (made by
// tools/make_parity_fixtures.py, without hole fill).
//
//   node e2e/parity.mjs                # both clips, 1024 and 512
//   QUALITIES=1024 CLIPS=twotone node e2e/parity.mjs
//
// It starts its own Vite dev server on PORT (7372), so the models come from
// studio/.models when they are there, and drives headed Google Chrome
// (WebGPU needs a real GPU: headless swiftshader has none) through
// playwright-core. Pass: at 1024, IoU >= 0.95 on every frame of every object
// with hole fill off (as the reference was made), and on twotone only the red
// half after the frame-10 correction. 512 is reported, not gated. The full
// results go to e2e/out/parity.json. CHROME can point at another Chrome.
import {chromium} from 'playwright-core';
import {spawn, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const STUDIO = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT ?? 7372);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CLIPS = (process.env.CLIPS ?? 'squares,twotone').split(',');
const QUALITIES = (process.env.QUALITIES ?? '1024,512').split(',').map(Number);
const FILLS = process.env.FILLS ?? '0,8';
const MIN_IOU = 0.95;
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, {recursive: true});

const vite = spawn(path.join(STUDIO, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: STUDIO,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', d => (viteLog += d));
vite.stderr.on('data', d => (viteLog += d));
const stopVite = () => vite.kill('SIGTERM');
process.on('exit', stopVite);

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${base}/e2e/parity.html`)).ok) break;
  } catch {
    // not up yet
  }
  if (i > 100 || vite.exitCode != null) {
    console.error(`vite did not start on ${PORT}:\n${viteLog}`);
    process.exit(2);
  }
  await new Promise(r => setTimeout(r, 200));
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: false,
  args: ['--enable-unsafe-webgpu', '--window-size=900,700'],
});

/** The Chrome GPU process's physical footprint in MB (macOS `footprint`), or null. */
function gpuFootprintMb() {
  try {
    const ps = execFileSync('ps', ['-axo', 'pid=,command='], {encoding: 'utf8'});
    const line = ps
      .split('\n')
      .find(l => l.includes('--type=gpu-process') && l.includes('playwright_chromiumdev_profile'));
    const pid = line?.trim().split(/\s+/)[0];
    if (pid == null) return null;
    const out = execFileSync('footprint', ['-p', pid], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    const m = out.match(/Footprint:\s+([\d.]+)\s+(KB|MB|GB)/);
    if (m == null) return null;
    return Number(m[1]) * {KB: 1 / 1024, MB: 1, GB: 1024}[m[2]];
  } catch {
    return null;
  }
}

const results = [];
let failed = 0;
for (const quality of QUALITIES) {
  for (const clip of CLIPS) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', m => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${m.type()}] ${m.text()} ${m.location()?.url ?? ''}`);
    });
    page.on('pageerror', e => console.log(`  [pageerror] ${e}`));
    const before = gpuFootprintMb();
    let peak = before ?? 0;
    const sampler = setInterval(() => (peak = Math.max(peak, gpuFootprintMb() ?? 0)), 500);
    await page.goto(`${base}/e2e/parity.html?clip=${clip}&quality=${quality}&fills=${FILLS}`);
    const handle = await page.waitForFunction(() => window.__parity, null, {timeout: 20 * 60_000, polling: 500});
    clearInterval(sampler);
    const got = await handle.jsonValue();
    await context.close();
    if (!got.ok) {
      console.log(`FAIL ${clip} @${quality}: ${got.error}`);
      failed++;
      continue;
    }
    const r = got.result;
    r.gpuProcessFootprintMb = {before, peak: peak || null};
    results.push(r);
    console.log(`${clip} @${quality} (${r.ep}): load ${r.load.ms.toFixed(0)} ms, ${(r.downloadedBytes / 1e6).toFixed(1)} MB`);
    console.log(
      `  click: cold ${r.clicks.coldMs.toFixed(0)} ms, repeat ${r.clicks.repeatMs.toFixed(0)}, new frame ${r.clicks.newFrameWarmMs.toFixed(0)}, repeat ${r.clicks.repeatWarmMs.toFixed(0)}`,
    );
    if (before != null) console.log(`  GPU process footprint: ${before.toFixed(0)} MB before, ${peak.toFixed(0)} MB peak`);
    for (const run of r.runs) {
      const objs = Object.entries(run.objects)
        .map(([id, s]) => `obj ${id} min ${s.min.toFixed(4)} (f${s.minFrame}) mean ${s.mean.toFixed(4)}`)
        .join(', ');
      console.log(`  fill ${run.fillHoleArea}: ${run.msPerFrame.toFixed(0)} ms/frame (median ${run.medianFrameMs.toFixed(0)}), ${objs}`);
      const gated = quality === 1024 && run.fillHoleArea === 0;
      if (gated) {
        const low = Object.entries(run.objects).filter(([, s]) => s.min < MIN_IOU);
        const ok = low.length === 0;
        console.log(`  ${ok ? 'PASS' : 'FAIL'} IoU >= ${MIN_IOU} on every frame`);
        failed += ok ? 0 : 1;
      }
      if (run.twotone != null) {
        const ok = run.twotone.ok;
        console.log(`  ${ok ? 'PASS' : 'FAIL'} twotone keeps only the red half after frame 10 (fill ${run.fillHoleArea})`);
        if (gated) failed += ok ? 0 : 1;
      }
    }
  }
}
await browser.close();
stopVite();
fs.writeFileSync(path.join(OUT, 'parity.json'), JSON.stringify(results, null, 2));
console.log(`${failed === 0 ? 'PASS' : `FAIL (${failed})`}; details in e2e/out/parity.json`);
process.exit(failed === 0 ? 0 : 1);
