// sam-ui (Apache-2.0). New file, not from SAM 2.
// The After Effects round trip's mapping (ae-roto.js): which footage can be
// opened, the checks before an export, and Vector JSON to bridge calls, with
// the frame alignment spelled out. fixtures/media-inventory.sample.json is
// the bridge's contract sample (see ae-bridge.test.js for where it is from).
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');

const roto = require('../src/ae-roto');

const MEDIA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'media-inventory.sample.json'), 'utf8')).result;
const HERO = MEDIA.items[0]; // 1920x1080, 23.976 fps, 300 frames, native
const SOURCE = roto.sourceRecord(HERO, MEDIA.project);

/** A Vector JSON document as studio's state/contours.ts makes it. */
function vectors(name, {frames = SOURCE.frames, w = SOURCE.width, h = SOURCE.height, add = [], sub = []} = {}) {
  return {version: 1, engine: 'sam2', model: 'large', object: {id: 1, name}, fps: 24, w, h, frames, add, sub};
}

/** One slot with `outline` on the frames in `on` (0-based) and null elsewhere. */
function slot(on, outline, frames = SOURCE.frames) {
  return Array.from({length: frames}, (_, i) => (on.includes(i) ? outline(i) : null));
}

const square = i => [[10 * i, 100], [10 * i + 39, 100], [10 * i + 39, 139], [10 * i, 139]];

test('the contract sample: native footage opens; a proxy, an override or a missing file says why', () => {
  const {items} = roto.eligibleMedia(MEDIA);
  assert.deepStrictEqual(items.map(i => i.eligible), [true, false, false]);
  assert.match(items[1].reason, /proxy/);
  assert.match(items[2].reason, /missing/i);
  assert.match(roto.ineligibleReason({...HERO, interpretationOverrides: ['conformFrameRate']}), /Interpret Footage.*conformed frame rate/);
  assert.match(roto.ineligibleReason({...HERO, pixelAspect: 0.9}), /Non-square/);
  assert.match(roto.ineligibleReason({...HERO, path: '/f/clip.mxf'}), /\.mp4 and \.mov/);
  assert.strictEqual(roto.ineligibleReason(HERO), null);
});

test('the source record keeps the AE identity and timing', () => {
  assert.deepStrictEqual(SOURCE, {
    kind: 'afterEffects', aeItemId: 12, aeProjectPath: '/Users/example/Projects/Spot_30s/Spot_30s_v04.aep',
    name: 'A001_C003_hero.mov', path: '/Users/example/Footage/Shoot_0412/A001_C003_hero.mov',
    width: 1920, height: 1080, pixelAspect: 1, frameRate: 23.9760246276855, frames: 300, duration: 12.5125, hasAudio: true,
  });
});

test('before an export: the same item, file, size, rate and frames, or it stops and says what moved', () => {
  const now = item => ({project: MEDIA.project, items: [{...HERO, ...item}]});
  assert.deepStrictEqual(roto.checkSource(SOURCE, MEDIA, {frames: 300, width: 1920, height: 1080}), []);
  assert.match(roto.checkSource(SOURCE, {...MEDIA, project: {path: '/other.aep'}})[0], /not the one this video came from/);
  assert.match(roto.checkSource(SOURCE, {project: MEDIA.project, items: []})[0], /no longer in the After Effects project/);
  assert.match(roto.checkSource(SOURCE, now({path: '/x/other.mov'}))[0], /another file/);
  assert.match(roto.checkSource(SOURCE, now({frames: 299}))[0], /299 frames, not 300/);
  assert.match(roto.checkSource(SOURCE, now({frameRate: 25}))[0], /25 fps/);
  assert.match(roto.checkSource(SOURCE, now({width: 1280, height: 720}))[0], /1280x720/);
  assert.match(roto.checkSource(SOURCE, now({useProxy: true})).join(' '), /proxy/);
  assert.match(roto.checkSource(SOURCE, MEDIA, {frames: 301, width: 1920, height: 1080})[0], /sam-ui decoded 301 frames/);
});

test('frame alignment: an outline on frame N becomes a key at N / fps on that object\'s layer', () => {
  const N = 137;
  const fps = SOURCE.frameRate;
  const plan = roto.planExport({source: SOURCE, objects: [vectors('car'), vectors('dog', {add: [slot([0, N], square)]})]});
  // the dog's layer is the one its rename names
  const rename = plan.steps.find(s => s.op === 'layers' && s.args.command === 'rename' && s.args.name === 'dog');
  const layer = rename.args.layerId.$ref;
  const keySteps = plan.steps.filter(s => s.args.command === 'setPathKeys' && s.args.layerId.$ref === layer);
  const keys = keySteps.flatMap(s => s.args.keys);
  assert.strictEqual(keys.length, SOURCE.frames); // one key per frame: nulls hide the mask in between
  const shown = keys.filter(k => k.vertices != null);
  // Vector JSON index 0 is clip frame 1, which AE shows from time 0; index N from N / fps
  assert.deepStrictEqual(shown.map(k => k.time), [0, N / fps]);
  assert.deepStrictEqual(shown[1].vertices, square(N));
  // and AE maps that time back to frame N (floor(t * fps), the frame it falls in)
  assert.strictEqual(Math.floor(shown[1].time * fps + 1e-9), N);
  assert.ok(keySteps.every(s => s.args.hold === true && s.args.maskName === 'dog 1'));
});

test('the comp: native size, rate and duration; the source once at the bottom as a guide; one layer per object, in order', () => {
  const objects = [
    vectors('car', {add: [slot([1], square), slot([2], square)], sub: [slot([1], square)]}),
    vectors('dog', {add: [slot([3], square)]}),
  ];
  const {compName, steps} = roto.planExport({source: SOURCE, objects});
  assert.strictEqual(compName, 'A001_C003_hero roto (sam-ui)');
  assert.deepStrictEqual(steps[0].args, {
    command: 'createComp', name: compName, width: 1920, height: 1080, pixelAspect: 1, frameRate: 23.9760246276855, duration: 12.5125,
  });
  const calls = steps.map(s => `${s.op}.${s.args.command}${s.args.name != null ? ` ${s.args.name}` : ''}${s.args.mode != null ? ` ${s.args.mode}` : ''}`);
  assert.deepStrictEqual(calls, [
    `project.createComp ${compName}`,
    'project.addToComp', 'layers.rename A001_C003_hero (source)', 'layers.organise',
    // AE adds each layer on top: the last object goes in first so the first ends on top
    'project.addToComp', 'layers.rename dog', 'layers.setAudioEnabled',
    'masks.add dog 1 add', 'masks.setPathKeys',
    'project.addToComp', 'layers.rename car', 'layers.setAudioEnabled',
    'masks.add car 1 add', 'masks.setPathKeys', 'masks.add car 2 add', 'masks.setPathKeys',
    // holes below the pieces: an Add below a Subtract would fill the hole back in
    'masks.add car hole 1 subtract', 'masks.setPathKeys',
  ]);
  assert.ok(steps.filter(s => s.args.command === 'addToComp').every(s => s.args.itemId === 12 && s.args.compId.$ref === 'comp'));
  assert.strictEqual(steps[3].args.guideLayer, true);
  // footage with no audio has no audio switch to set
  const silent = roto.planExport({source: {...SOURCE, hasAudio: false}, objects});
  assert.ok(!silent.steps.some(s => s.args.command === 'setAudioEnabled'));
});

test('a long clip is split into calls by time range; a big call goes by keys file', () => {
  const frames = 1300;
  const source = {...SOURCE, frames, duration: frames / SOURCE.frameRate};
  const objects = [vectors('car', {frames, add: [slot([0, 700, 1299], square, frames)]})];
  const plan = roto.planExport({source, objects, chunkFrames: 600});
  const keySteps = plan.steps.filter(s => s.args.command === 'setPathKeys');
  assert.deepStrictEqual(keySteps.map(s => s.args.keys.length), [600, 600, 100]);
  assert.strictEqual(keySteps[1].args.keys[0].time, 600 / SOURCE.frameRate); // contiguous
  assert.ok(keySteps.every(s => s.transport === 'rpc'));
  const big = roto.planExport({source, objects, chunkFrames: 600, inlineLimit: 1000});
  assert.ok(big.steps.filter(s => s.args.command === 'setPathKeys').every(s => s.transport === 'file'));
});

test('outlines that do not match the footage are refused before any call', () => {
  assert.throws(() => roto.planExport({source: SOURCE, objects: [vectors('car', {frames: 299})]}), /299 frames.*300/);
  assert.throws(() => roto.planExport({source: SOURCE, objects: [vectors('car', {w: 1280, h: 720})]}), /1280x720/);
  assert.throws(() => roto.planExport({source: SOURCE, objects: []}), /No object/);
});

/** A fake bridge client: records calls, answers ids. */
function fakeClient({failOn, media = MEDIA} = {}) {
  const calls = [];
  let id = 100;
  const answer = (op, args) => {
    if (failOn != null && failOn(op, args)) throw Object.assign(new Error('No layer with id 7'), {code: 'op-failed'});
    if (op === 'media') return media;
    if (args.command === 'createComp' || args.command === 'addToComp') return {id: ++id};
    return {ok: true};
  };
  return {
    calls,
    listMedia: async () => {
      calls.push({op: 'media'});
      return media;
    },
    rpc: async (op, args) => {
      calls.push({op, args});
      return answer(op, args);
    },
    tool: async (name, args) => {
      calls.push({tool: name, args, file: JSON.parse(fs.readFileSync(args.keysPath, 'utf8'))});
      return answer('masks', args);
    },
  };
}

test('runPlan resolves ids, sends big keys through a file, and deletes a half-built comp on failure', async () => {
  const objects = [vectors('car', {add: [slot([4], square)]})];
  const plan = roto.planExport({source: SOURCE, objects, inlineLimit: 1000});
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samui-roto-'));
  const client = fakeClient();
  const out = await roto.runPlan(plan, client, {tmpDir});
  assert.deepStrictEqual(out, {compId: 101, compName: plan.compName, layers: 1, masks: 1, keys: 300});
  const rename = client.calls.find(c => c.args?.name === 'car');
  assert.deepStrictEqual([rename.args.compId, rename.args.layerId], [101, 103]);
  const viaFile = client.calls.find(c => c.tool === 'ae_masks');
  assert.strictEqual(viaFile.args.keys, undefined);
  assert.strictEqual(viaFile.args.layerId, 103);
  assert.strictEqual(viaFile.file.length, 300);
  assert.deepStrictEqual(viaFile.file[4], {time: 4 / SOURCE.frameRate, vertices: square(4)});

  const failing = fakeClient({failOn: (op, a) => op === 'masks' && a.command === 'add'});
  await assert.rejects(roto.runPlan(roto.planExport({source: SOURCE, objects}), failing), e =>
    /stopped \(mask car 1\).*No layer with id 7.*half-built comp was deleted/.test(e.message),
  );
  assert.deepStrictEqual(failing.calls.at(-1), {op: 'project', args: {command: 'deleteItem', itemId: 101}});
});

test('an export that no longer matches writes nothing; one that does builds the comp', async () => {
  const record = {source: SOURCE, missing: false, changed: false};
  const backend = {sourceOf: async () => record};
  const objects = [vectors('car', {add: [slot([0], square)]})];
  const moved = fakeClient({media: {project: MEDIA.project, items: [{...HERO, frames: 301}]}});
  await assert.rejects(
    roto.exportToAe({client: moved, backend, videoPath: 'linked/x.mov', objects, studio: {frames: 300, width: 1920, height: 1080}}),
    e => e.code === 'mismatch' && /Nothing was written/.test(e.message) && /301 frames/.test(e.message),
  );
  assert.deepStrictEqual(moved.calls, [{op: 'media'}]); // listed, never written
  await assert.rejects(roto.exportToAe({client: fakeClient(), backend: {sourceOf: async () => ({...record, changed: true})}, videoPath: 'x', objects}), /changed on disk/);
  await assert.rejects(roto.exportToAe({client: fakeClient(), backend: {sourceOf: async () => null}, videoPath: 'uploads/x.mp4', objects}), /not opened from After Effects/);
  const ok = fakeClient();
  const out = await roto.exportToAe({client: ok, backend, videoPath: 'linked/x.mov', objects, studio: {frames: 300, width: 1920, height: 1080}});
  assert.strictEqual(out.compName, 'A001_C003_hero roto (sam-ui)');
});

test('openFromAe links only eligible footage, with its source record, re-listed in the main process', async () => {
  const linked = [];
  const backend = {link: async (file, source) => (linked.push({file, source}), {path: 'linked/abc.mov'})};
  await assert.rejects(roto.openFromAe({client: fakeClient(), backend, itemId: 15}), e => e.code === 'ineligible' && /proxy/.test(e.message));
  await assert.rejects(roto.openFromAe({client: fakeClient(), backend, itemId: 99}), /no longer in the After Effects project/);
  assert.strictEqual(linked.length, 0);
  assert.deepStrictEqual(await roto.openFromAe({client: fakeClient(), backend, itemId: 12}), {path: 'linked/abc.mov'});
  assert.deepStrictEqual(linked, [{file: HERO.path, source: SOURCE}]);
});

test('the backend client sends the link token and no Origin, and reads refusals', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({url: req.url, headers: req.headers, body});
      if (req.url.startsWith('/linked-source')) {
        res.writeHead(404);
        return res.end('<html>not found</html>');
      }
      const {source} = JSON.parse(body);
      res.writeHead(source.frames === 1 ? 422 : 200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(source.frames === 1 ? {error: 'frame count: After Effects has 1, the file has 30'} : {path: 'linked/a.mov'}));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const b = roto.backendClient({port: server.address().port, token: 'tok'});
    assert.deepStrictEqual(await b.link('/f/a.mov', {frames: 30}), {path: 'linked/a.mov'});
    assert.strictEqual(seen[0].headers['x-sam-ui-link-token'], 'tok');
    assert.strictEqual(seen[0].headers.origin, undefined);
    await assert.rejects(b.link('/f/a.mov', {frames: 1}), e => e.code === 'mismatch' && /frame count/.test(e.message));
    assert.strictEqual(await b.sourceOf('uploads/x.mp4'), null);
    assert.strictEqual(seen.at(-1).url, '/linked-source?path=uploads%2Fx.mp4');
  } finally {
    server.close();
  }
});
