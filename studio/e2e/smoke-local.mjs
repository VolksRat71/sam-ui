// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The no-server half of `npm run smoke` (NO_SERVER_URL set): studio with no
// backend, e.g. the Pages build served under /sam-ui/. In headed Chrome
// (the browser engine needs WebGPU), with a fresh profile each run, so the
// 512 px model downloads each time (83 MB; with a reused profile Playwright
// lost track of its downloads).
// It opens the clip from disk, adds three objects, tracks them, reloads
// (restored from OPFS), renames an object, exports mask videos, Vector
// JSON and the roto working folder (zips, checked with unzip), and deletes
// the video.
import {chromium} from 'playwright-core';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

export async function runNoServer({url, clip, out, chrome, check}) {
  const browser = await chromium.launch({executablePath: chrome, headless: false, args: ['--enable-unsafe-webgpu']});
  const context = await browser.newContext({viewport: {width: 1440, height: 900}, acceptDownloads: true});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const rows = () => page.$$eval('.object-row .object-title', rs => rs.map(r => r.innerText.replace(/\n/g, ' ')));
  const clickAt = async (nx, ny) => {
    const b = await page.$eval('.click-layer', e => {
      const r = e.getBoundingClientRect();
      return {x: r.left, y: r.top, w: r.width, h: r.height};
    });
    await page.mouse.click(b.x + nx * b.w, b.y + ny * b.h);
  };
  const settle = () =>
    page.waitForFunction(() => !/Updating/.test(document.querySelector('.topbar-status')?.innerText ?? ''), null, {timeout: 180000});
  const idle = () =>
    page.waitForFunction(() => !document.querySelector('.job-chip') && document.querySelector('.cta')?.innerText === 'Nothing to track', null, {
      timeout: 600000,
    });
  const ready = async () => {
    await page.waitForSelector('.engine-button', {timeout: 60000});
    await page.waitForFunction(() => !document.querySelector('.stage-overlay'), null, {timeout: 60000});
    await page.waitForFunction(() => !/decoding/.test(document.querySelector('.frame-counter')?.innerText ?? ''), null, {timeout: 60000});
    await page.waitForTimeout(1000);
  };
  const exportZip = async (item, expectName) => {
    await page.click('.export-menu > button');
    await page.click(`.menu-item:has-text("${item}")`);
    await page.waitForSelector('.modal');
    const field = await page.$eval('.modal .field input', i => i.value);
    const [download] = await Promise.all([page.waitForEvent('download', {timeout: 300000}), page.click('.modal button.primary')]);
    const file = path.join(out, download.suggestedFilename());
    await download.saveAs(file);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const listing = execFileSync('unzip', ['-l', file], {encoding: 'utf8'});
    return {file, field, listing, readme: execFileSync('unzip', ['-p', file, 'README.txt'], {encoding: 'utf8'})};
  };

  await page.goto(url);
  await page.waitForSelector('.dropzone', {timeout: 60000});
  // it shows once the first video's session is up
  const banner = await page.waitForSelector('.demo-banner', {timeout: 60000}).catch(() => null);
  check(banner != null, 'no-server: the demo banner shows');
  const samples = await page.$$eval('.media-name', ns => ns.map(n => n.title));
  check(samples.every(p => p.startsWith('samples/')), `no-server: bundled samples listed (${samples.join(', ') || 'none'})`);

  await page.setInputFiles('.dropzone input[type=file]', clip);
  await page.waitForFunction(() => document.querySelector('.media-item.selected .media-name')?.title?.startsWith('local/'), null, {timeout: 120000});
  await ready();
  const opened = await page.$eval('.media-item.selected .media-name', e => e.innerText);
  check(opened === path.basename(clip), `no-server: the file opens under its own name (${opened})`);
  check((await page.$eval('.engine-button', e => e.innerText)).includes('Browser'), 'no-server: the browser engine is the one on screen');

  // three objects (the model downloads on the first click)
  await clickAt(0.1875, 0.375);
  await settle();
  await page.click('button:has-text("Add object")');
  await clickAt(0.766, 0.729);
  await settle();
  await page.click('button:has-text("Add object")');
  await clickAt(0.781, 0.25);
  await settle();
  await page.waitForFunction(() => document.querySelectorAll('.object-row').length === 3, null, {timeout: 60000});
  await page.click('.cta');
  await idle();
  check((await rows()).every(r => /tracked/i.test(r)), `no-server: track ${JSON.stringify(await rows())}`);

  // reload: objects and tracks come back from OPFS
  await page.reload();
  await ready();
  await page.waitForFunction(() => document.querySelectorAll('.swimlane-segment').length >= 3, null, {timeout: 60000});
  check((await rows()).length === 3 && (await rows()).every(r => /tracked/i.test(r)), `no-server: reload restores from OPFS ${JSON.stringify(await rows())}`);

  // rename, and the name survives a reload
  await page.dblclick('.object-row >> nth=0 >> .object-name-text');
  await page.fill('.object-name-input', 'Red disc');
  await page.keyboard.press('Enter');
  await settle();
  await page.reload();
  await ready();
  const names = await page.$$eval('.object-row .object-name-text', ns => ns.map(n => n.innerText));
  check(names[0] === 'Red disc' && (await rows()).every(r => /tracked/i.test(r)), `no-server: rename persists and leaves tracks (${names.join(', ')})`);

  // exports
  const stem = path.basename(clip).replace(/\.[^.]+$/, '');
  const masks = await exportZip('Mask videos', `${stem}-masks.zip`);
  check(masks.field === `${stem}-masks.zip` && /Red disc\.mp4/.test(masks.listing) && /Object 2\.mp4/.test(masks.listing), `no-server: mask videos ${path.basename(masks.file)}`);
  check(/Browser · SAM 2\.1 tiny/.test(masks.readme) && /sam2\.1_hiera_tiny/.test(masks.readme), 'no-server: README names the engine and model');
  const vectors = await exportZip('Vector JSON', `${stem}-vectors.zip`);
  const vj = JSON.parse(execFileSync('unzip', ['-p', vectors.file, 'Red disc.json'], {encoding: 'utf8'}));
  check(vj.version === 1 && vj.engine === 'browser-sam2' && vj.object?.name === 'Red disc' && vj.add.length > 0, `no-server: vector JSON (${vj.frames} frames, ${vj.add.length} slots)`);
  const roto = await exportZip('PNG sequence', `${stem}-roto.zip`);
  check(
    roto.field === `${stem}-roto.zip` && /products\.json/.test(roto.listing) && /data\/mattes_tracked\/red_disc\/00001\.png/.test(roto.listing),
    'no-server: roto working folder zip',
  );

  // delete the video
  await page.click('.media-row:has(.media-item.selected) .media-remove');
  await page.waitForSelector('.modal');
  await page.click('.modal .button.danger');
  await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 60000});
  await page.waitForTimeout(800);
  const left = await page.$$eval('.media-name', ns => ns.map(n => n.title));
  check(!left.some(p => p.startsWith('local/')), `no-server: delete removes it (${left.join(', ') || 'no videos left'})`);

  const real = errors.filter(e => !/WebGL context|NetworkError|Inter-VariableFont/.test(e));
  check(real.length === 0, `no-server: no page errors${real.length ? `: ${real.slice(0, 3).join(' | ')}` : ''}`);
  await browser.close();
}
