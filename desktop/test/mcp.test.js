// sam-ui (Apache-2.0). New file, not from SAM 2.
// The MCP server (mcp-server.js, mcp-tools.js) against a fake backend: auth,
// JSON-RPC, each tool's endpoint, export names, and held track streams.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// before the server reads it: never the real ~/.sam-ui/token
process.env.SAM_UI_TOKEN_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sam-ui-mcp-')), 'tok');

const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const {test, before, after} = require('node:test');
const {backendClient} = require('../src/ae-roto');
const {createMcpServer, loadOrCreateToken, tokenFile} = require('../src/mcp-server');
const {closingPart, createTools, parseGotoReply, parseView} = require('../src/mcp-tools');

const EXPORT_ROOT = '/Users/someone/Movies/sam-ui';
const OBJECT = {
  objectId: 1, state: 'tracked', engine: 'sam2', frames: [0, 9], nFrames: 10,
  seeds: [{frameIndex: 0, points: [[0.5, 0.25]], labels: [1], text: null}],
  tracks: [{engine: 'sam2', state: 'tracked', frames: [0, 9]}], ranges: [], history: {canUndo: true, canRedo: false},
};
const CAPTURE = {image: Buffer.from('jpeg').toString('base64'), mime_type: 'image/jpeg', width: 768, height: 432,
  legend: {n_frames: 10, fps: 24, frames: [0], objects: [], drawn: []}};

// -- a fake backend that records every request -------------------------------

const seen = [];
let track = null; // the open /track_objects response, for the test to finish

function part(body) {
  const b = Buffer.from(JSON.stringify(body));
  return Buffer.concat([Buffer.from(`--frame\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${b.length}\r\n\r\n`), b]);
}

const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    seen.push({method: req.method, url: req.url, headers: req.headers, body});
    const reply = (status, value) => {
      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(value));
    };
    if (req.url === '/graphql') {
      const q = body.query;
      if (q.includes('videos')) return reply(200, {data: {videos: {edges: [{node: {path: 'gallery/01_dog.mp4', width: 1280, height: 720}}]}}});
      if (q.includes('startSession')) return reply(200, {data: {startSession: {sessionId: 's1', objects: [OBJECT]}}});
      if (q.includes('objectTracks') && body.variables.s === 'gone') return reply(200, {errors: [{message: 'Cannot find session gone; it might have expired'}]});
      if (q.includes('objectTracks')) return reply(200, {data: {objectTracks: [OBJECT]}});
      if (q.includes('addPoints')) return reply(200, {data: {addPoints: {frameIndex: body.variables.i.frameIndex}}});
      if (q.includes('closeSession')) return reply(200, {data: {closeSession: {success: true}}});
      if (q.includes('removeObject')) return reply(200, {data: {removeObject: []}});
      for (const m of ['setObjectRange', 'undoSeeds', 'redoSeeds']) if (q.includes(m)) return reply(200, {data: {[m]: OBJECT}});
      return reply(200, {errors: [{message: 'unknown query'}]});
    }
    if (req.url === '/engines') return reply(200, {engines: [{name: 'sam2', model: 'x', default: true, available: true, reason: null, loaded: true, text: false, text_reason: 'clicks only'}]});
    if (req.url === '/object_names') return reply(200, {names: {1: 'dog'}});
    if (req.url === '/capture') return reply(200, CAPTURE);
    if (req.url === '/text_prompt') return reply(200, {object_id: 1, frame_index: 3, text: 'dog', engine: 'sam3', matched: true, score: 0.9, instances: 1, box: [0, 0, 1, 1], mask: {size: [1, 1], counts: 'x'}});
    if (req.url === '/review_queue') {
      const queue = Array.from({length: 15}, (_, i) => ({object_id: 1, frame: i, start: i, end: i, score: 1 - i / 20, reasons: [], reviewed: false}));
      return reply(200, {engine: 'sam2', compare: 'sam3', objects: {1: {state: 'tracked', n_frames: 10, locations: queue}}, queue});
    }
    if (req.url === '/set_reviewed') return reply(200, {object_id: body.object_id, frame: body.frame, reviewed: true});
    if (req.url === '/cancel_track') {
      track?.end(part({frame_index: -1, results: [], done: false, job_id: 'job-1', error: 'canceled', objects: [1]}));
      return reply(200, {canceled: true});
    }
    if (req.url === '/track_jobs') return reply(200, {jobs: track && !track.writableEnded ? [{job_id: 'job-1', objects: [1], frames_done: 2, n_frames: 10, elapsed_s: 1}] : []});
    if (req.url === '/export' && body.out_dir.endsWith('/taken')) {
      return reply(400, {error: `'${body.out_dir}' already has ['products.json']; tick Replace existing (force) to replace them`});
    }
    if (req.url === '/export') return reply(200, {out_dir: body.out_dir, video: 'abc', products: [{id: 'object_1'}], skipped: {}, n_frames: 10});
    if (req.url === '/track_objects') {
      if (body.engine === 'nope') return reply(400, {error: "unknown engine 'nope'"});
      res.writeHead(200, {'Content-Type': 'multipart/x-savi-stream; boundary=frame', 'Job-Id': 'job-1', 'Objects-Tracked': '1', 'Objects-Bounded': ''});
      res.write(part({frame_index: 0, results: [{object_id: 1, mask: {size: [2, 2], counts: 'a'}}]}));
      res.write(part({frame_index: 1, results: []}));
      track = res;
      return undefined;
    }
    return reply(404, {error: 'no route'});
  });
});

let app;
let port;
let token;

before(async () => {
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  app = createMcpServer({backend: backendClient({port: fake.address().port}), port: 0, exportRoot: EXPORT_ROOT});
  port = await app.listen();
  token = fs.readFileSync(tokenFile(), 'utf8');
});

after(async () => {
  await app.close();
  fake.closeAllConnections();
  await new Promise(r => fake.close(r));
});

function raw({method = 'POST', url = '/mcp', host = `127.0.0.1:${port}`, auth = `Bearer ${token}`, origin, body = '{}'}) {
  return new Promise(resolve => {
    const headers = [`Host: ${host}`, 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close'];
    if (auth) headers.push(`Authorization: ${auth}`);
    if (origin) headers.push(`Origin: ${origin}`);
    const s = net.connect(port, '127.0.0.1', () => s.write(`${method} ${url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n${body}`));
    let buf = '';
    s.on('data', d => (buf += d));
    s.on('end', () => resolve({status: Number(buf.split(' ')[1]), body: buf.split('\r\n\r\n')[1] ?? ''}));
    s.on('error', () => resolve({status: 0, body: ''}));
  });
}

let nextRpcId = 1;
async function rpc(method, params) {
  const r = await raw({body: JSON.stringify({jsonrpc: '2.0', id: nextRpcId++, method, params})});
  assert.strictEqual(r.status, 200, r.body);
  return JSON.parse(r.body);
}

async function call(name, args) {
  const reply = await rpc('tools/call', {name, arguments: args});
  return reply.result;
}

const textOf = result => JSON.parse(result.content.find(c => c.type === 'text').text);
const last = url => [...seen].reverse().find(s => s.url === url);

// -- transport and auth ------------------------------------------------------

test('the token is 64 hex, 0600 in a 0700 folder, and kept', () => {
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.strictEqual(fs.statSync(tokenFile()).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(tokenFile())).mode & 0o777, 0o700);
  assert.strictEqual(loadOrCreateToken(), token);
});

test('no token or a wrong one is a 401', async () => {
  assert.strictEqual((await raw({auth: null})).status, 401);
  assert.strictEqual((await raw({auth: 'Bearer ' + 'a'.repeat(64)})).status, 401);
  assert.strictEqual((await raw({auth: token})).status, 401); // no "Bearer "
});

test('a foreign Host or any Origin is a 403, even with the token', async () => {
  assert.strictEqual((await raw({host: 'evil.test'})).status, 403);
  assert.strictEqual((await raw({host: `127.0.0.1:${port + 1}`})).status, 403);
  assert.strictEqual((await raw({origin: `http://127.0.0.1:${port}`})).status, 403);
  assert.strictEqual((await raw({origin: 'null'})).status, 403);
  assert.strictEqual((await raw({host: `localhost:${port}`, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}'})).status, 200);
});

test('GET and DELETE on /mcp are 405, other paths 404, big bodies 413', async () => {
  assert.strictEqual((await raw({method: 'GET', body: ''})).status, 405);
  assert.strictEqual((await raw({method: 'DELETE', body: ''})).status, 405);
  assert.strictEqual((await raw({url: '/rpc'})).status, 404);
  assert.strictEqual((await raw({body: 'x'.repeat(1024 * 1024 + 1)})).status, 413);
});

test('initialize, tools/list, notifications and bad JSON', async () => {
  const init = await rpc('initialize', {protocolVersion: '2025-03-26'});
  assert.strictEqual(init.result.protocolVersion, '2025-03-26');
  assert.strictEqual(init.result.serverInfo.name, 'sam-ui');
  assert.match(init.result.instructions, /sam_capture/);
  const names = (await rpc('tools/list')).result.tools.map(t => t.name);
  assert.deepStrictEqual(names, ['sam_query', 'sam_session', 'sam_edit', 'sam_track', 'sam_review', 'sam_capture', 'sam_export', 'sam_studio']);
  assert.strictEqual((await raw({body: '{"jsonrpc":"2.0","method":"notifications/initialized"}'})).status, 202);
  assert.strictEqual(JSON.parse((await raw({body: '{nope'})).body).error.code, -32700);
  assert.strictEqual((await rpc('nope/nope')).error.code, -32601);
});

// -- tools -> endpoints ------------------------------------------------------

const MAPPING = [
  ['sam_query', {command: 'engines'}, '/engines', null],
  ['sam_query', {command: 'objects', session_id: 's1'}, '/object_names', {session_id: 's1'}],
  ['sam_session', {command: 'close', session_id: 's1'}, '/graphql', {variables: {i: {sessionId: 's1'}}}],
  ['sam_edit', {command: 'text', session_id: 's1', object_id: 1, frame: 3, text: 'dog'}, '/text_prompt',
    {session_id: 's1', object_id: 1, frame_index: 3, text: 'dog'}],
  ['sam_edit', {command: 'range', session_id: 's1', object_id: 1, start: 2, end: 5, state: 'absent'}, '/graphql',
    {variables: {i: {sessionId: 's1', objectId: 1, start: 2, end: 5, state: 'absent'}}}],
  ['sam_edit', {command: 'range', session_id: 's1', object_id: 1, start: 2, end: 5, state: 'clear'}, '/graphql',
    {variables: {i: {sessionId: 's1', objectId: 1, start: 2, end: 5, state: null}}}],
  ['sam_edit', {command: 'undo', session_id: 's1', object_id: 1}, '/graphql', {variables: {i: {sessionId: 's1', objectId: 1}}}],
  ['sam_edit', {command: 'remove', session_id: 's1', object_id: 1}, '/graphql', {variables: {i: {sessionId: 's1', objectId: 1}}}],
  ['sam_review', {command: 'mark', session_id: 's1', object_id: 1, frame: 4, span: [3, 5]}, '/set_reviewed',
    {session_id: 's1', object_id: 1, frame: 4, span: [3, 5]}],
  ['sam_capture', {command: 'frame', session_id: 's1', frame: 7, long_edge: 1024}, '/capture',
    {session_id: 's1', frames: [7], sheet: undefined, long_edge: 1024}],
  ['sam_capture', {command: 'sheet', session_id: 's1', start: 0, end: 9, count: 4, object_ids: [1]}, '/capture',
    {session_id: 's1', sheet: true, start: 0, end: 9, count: 4, object_ids: [1]}],
  ['sam_track', {command: 'status', session_id: 's1'}, '/track_jobs', {session_id: 's1'}],
];

for (const [tool, args, url, body] of MAPPING) {
  test(`${tool} ${args.command} -> ${url}`, async () => {
    const before = seen.length;
    const result = await call(tool, args);
    assert.ok(!result.isError, JSON.stringify(result));
    const got = seen.slice(before).find(s => s.url === url);
    assert.ok(got, `no request to ${url}`);
    if (body) assertSubset(got.body, body);
  });
}

function assertSubset(actual, expected) {
  for (const [k, v] of Object.entries(expected)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) assertSubset(actual?.[k], v);
    else assert.deepStrictEqual(actual?.[k], v, k);
  }
}

test('videos are named by id, with no urls', async () => {
  assert.deepStrictEqual(textOf(await call('sam_query', {command: 'videos'})), [{video_id: 'gallery/01_dog.mp4', width: 1280, height: 720}]);
  assert.doesNotMatch(last('/graphql').body.query, /url|posterPath/i);
});

test('open answers with the session, next_id and a picture of frame 0', async () => {
  const r = await call('sam_session', {command: 'open', video_id: 'gallery/01_dog.mp4'});
  assert.deepStrictEqual(r.content[0], {type: 'image', data: CAPTURE.image, mimeType: 'image/jpeg'});
  const t = textOf(r);
  assert.strictEqual(t.session_id, 's1');
  assert.strictEqual(t.next_id, 2);
  assert.strictEqual(t.objects[0].name, 'dog');
  assert.deepStrictEqual(t.objects[0].seeds, [{frame: 0, points: [[0.5, 0.25, 1]]}]);
  assert.deepStrictEqual(last('/capture').body, {session_id: 's1', frames: [0]});
  assert.deepStrictEqual(last('/graphql').body.variables, {i: {path: 'gallery/01_dog.mp4'}});
});

test('points replace the frame\'s clicks and answer with a capture of that frame', async () => {
  const r = await call('sam_edit', {command: 'points', session_id: 's1', object_id: 2, frame: 4, points: [[0.5, 0.5, 1], [0.1, 0.9, 0]]});
  assert.strictEqual(r.content[0].type, 'image');
  assertSubset(last('/graphql').body.variables.i, {sessionId: 's1', objectId: 2, frameIndex: 4, clearOldPoints: true, points: [[0.5, 0.5], [0.1, 0.9]], labels: [1, 0]});
  assert.deepStrictEqual(last('/capture').body, {session_id: 's1', frames: [4]});
  const quiet = await call('sam_edit', {command: 'points', session_id: 's1', object_id: 2, frame: 4, points: [[0.5, 0.5, 1]], capture: false});
  assert.strictEqual(quiet.content.length, 1);
});

test('bad arguments are refused before the backend sees them', async () => {
  const before = seen.length;
  for (const [tool, args] of [
    ['sam_edit', {command: 'points', session_id: 's1', object_id: 1, frame: 0, points: [[1.5, 0.5, 1]]}],
    ['sam_edit', {command: 'points', session_id: 's1', object_id: 1, frame: 0, points: [[0.5, 0.5, 2]]}],
    ['sam_edit', {command: 'points', session_id: 's1', object_id: -1, frame: 0, points: [[0.5, 0.5, 1]]}],
    ['sam_edit', {command: 'range', session_id: 's1', object_id: 1, start: 5, end: 2, state: 'absent'}],
    ['sam_capture', {command: 'sheet', session_id: 's1', frames: Array(13).fill(0)}],
    ['sam_capture', {command: 'frame', session_id: 's1', frame: 0, engine: '../x'}],
    ['sam_query', {command: 'constructor'}],
    ['sam_query', {command: 'objects'}],
    ['sam_nope', {}],
  ]) {
    const r = await call(tool, args);
    assert.strictEqual(r.isError, true, `${tool} ${JSON.stringify(args)}`);
  }
  assert.strictEqual(seen.length, before);
});

test('text prompts drop the mask; the review queue is cut to its limit', async () => {
  const t = textOf(await call('sam_edit', {command: 'text', session_id: 's1', object_id: 1, frame: 3, text: 'dog', capture: false}));
  assert.strictEqual(t.mask, undefined);
  assert.strictEqual(t.matched, true);
  const q = textOf(await call('sam_review', {command: 'queue', session_id: 's1', limit: 3}));
  assert.strictEqual(q.queue.length, 3);
  assert.strictEqual(q.total, 15);
  assert.deepStrictEqual(q.objects, {1: {state: 'tracked', n_frames: 10, locations: 15}});
});

// -- export ------------------------------------------------------------------

test('export joins a plain name under ~/Movies/sam-ui and never forces', async () => {
  const t = textOf(await call('sam_export', {session_id: 's1', name: 'dog-test', object_ids: [1]}));
  const sent = last('/export').body;
  assert.strictEqual(sent.out_dir, path.join(EXPORT_ROOT, 'dog-test'));
  assert.deepStrictEqual(sent.objects, {1: {}});
  assert.strictEqual(sent.force, undefined);
  assert.strictEqual(t.exported_to, '~/Movies/sam-ui/dog-test');
  assert.strictEqual(t.out_dir, undefined);
  assert.doesNotMatch(JSON.stringify(t), /\/Users\//);
});

test('refusing an existing export names no path and offers no force', async () => {
  const r = await call('sam_export', {session_id: 's1', name: 'taken'});
  assert.strictEqual(r.isError, true);
  assert.strictEqual(r.content[0].text,
    "~/Movies/sam-ui/taken already has ['products.json']. Agents never replace an export: pick a new name.");
});

test('export names that are paths are refused', async () => {
  const before = seen.length;
  for (const name of ['../x', '/abs', 'a/b', '.hidden', '', 'x'.repeat(65), '..', 'a\\b', 7]) {
    const r = await call('sam_export', {session_id: 's1', name, force: true});
    assert.strictEqual(r.isError, true, String(name));
  }
  assert.strictEqual(seen.length, before);
});

// -- track jobs --------------------------------------------------------------

test('track start answers at the headers; wait sees the stream finish', async () => {
  const start = textOf(await call('sam_track', {command: 'start', session_id: 's1', object_ids: [1]}));
  assert.deepStrictEqual(start, {job_id: 'job-1', objects: [1], bounded: []});
  const running = textOf(await call('sam_track', {command: 'wait', session_id: 's1', job_id: 'job-1', timeout_s: 0.05}));
  assert.strictEqual(running.state, 'running');
  assert.strictEqual(running.frames_done, 2);
  setTimeout(() => track.end(part({frame_index: -1, results: [], done: true, job_id: 'job-1', engine: 'sam2', objects: [1], tracked: [1], failed: {}})), 50);
  const done = textOf(await call('sam_track', {command: 'wait', session_id: 's1', job_id: 'job-1', timeout_s: 5}));
  assert.deepStrictEqual(done, {job_id: 'job-1', state: 'done', objects: [1], tracked: [1], failed: {}});
  // held after the stream ended
  assert.strictEqual(textOf(await call('sam_track', {command: 'status', session_id: 's1', job_id: 'job-1'})).state, 'done');
});

test('track cancel ends the stream as canceled', async () => {
  await call('sam_track', {command: 'start', session_id: 's1'});
  assert.deepStrictEqual(textOf(await call('sam_track', {command: 'cancel', session_id: 's1', job_id: 'job-1'})), {canceled: true});
  assert.deepStrictEqual(last('/cancel_track').body, {session_id: 's1', job_id: 'job-1'});
  const r = textOf(await call('sam_track', {command: 'wait', session_id: 's1', job_id: 'job-1', timeout_s: 5}));
  assert.strictEqual(r.state, 'canceled');
});

test('a refused track is an error with the backend\'s reason', async () => {
  const r = await call('sam_track', {command: 'start', session_id: 's1', engine: 'nope'});
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /unknown engine 'nope'/);
});

test('closingPart reads only the last part, and says when there is none', () => {
  const tail = part({frame_index: -1, results: [], done: true, tracked: [1]}).toString('latin1');
  assert.strictEqual(closingPart(tail).done, true);
  assert.deepStrictEqual(closingPart(part({frame_index: 3, results: []}).toString('latin1')), {done: false, error: 'the stream ended without a result'});
  assert.strictEqual(closingPart('').done, false);
});

// -- least privilege ---------------------------------------------------------

test('the backend never sees the link token or an Origin', () => {
  assert.ok(seen.length > 20);
  for (const s of seen) {
    assert.strictEqual(s.headers['x-sam-ui-link-token'], undefined, s.url);
    assert.strictEqual(s.headers.origin, undefined, s.url);
    assert.strictEqual(s.headers.host, `127.0.0.1:${fake.address().port}`);
    assert.notStrictEqual(s.url, '/linked');
  }
});

// -- review follow-up --------------------------------------------------------

test('a deeply nested id is refused, never echoed, and the server stays up', async () => {
  const deep = '['.repeat(200000) + ']'.repeat(200000);
  for (const id of [deep, '{}', 'true']) {
    const r = await raw({body: `{"jsonrpc":"2.0","id":${id},"method":"ping"}`});
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), {jsonrpc: '2.0', id: null, error: {code: -32600, message: 'id must be a string, a number or null'}});
  }
  assert.deepStrictEqual((await rpc('ping')).result, {});
});

test('batches are refused without calling anything', async () => {
  const before = seen.length;
  const one = {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'sam_capture', arguments: {command: 'frame', session_id: 's1', frame: 0}}};
  for (const body of [[one, {...one, id: 2}], []]) {
    const r = await raw({body: JSON.stringify(body)});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.body).error.code, -32600);
  }
  assert.strictEqual(seen.length, before);
});

test('a notification gets no reply and does nothing', async () => {
  const before = seen.length;
  for (const method of ['tools/call', 'initialize', 'ping', 'nope']) {
    const r = await raw({body: JSON.stringify({jsonrpc: '2.0', method, params: {name: 'sam_query', arguments: {command: 'videos'}}})});
    assert.strictEqual(r.status, 202, method);
    assert.strictEqual(r.body, '');
  }
  assert.strictEqual(seen.length, before);
});

test('tool names do not reach Object.prototype', async () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = await call(name, {command: 'videos'});
    assert.strictEqual(r.isError, true, name);
    assert.match(r.content[0].text, /^Unknown tool/);
  }
});

test('the 401 names no absolute path', async () => {
  const r = await raw({auth: null});
  assert.strictEqual(r.status, 401);
  assert.ok(!r.body.includes(path.dirname(tokenFile())));
  assert.match(r.body, /~\/\.sam-ui\/token/);
});

test('a token file or folder open to others, or a link, is replaced, never trusted', () => {
  const saved = process.env.SAM_UI_TOKEN_DIR; // sync from here to the finally: the live server reads this too
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-ui-mcp-perm-'));
  process.env.SAM_UI_TOKEN_DIR = path.join(root, 'tok');
  try {
    const first = loadOrCreateToken();
    fs.chmodSync(tokenFile(), 0o644);
    const second = loadOrCreateToken();
    assert.notStrictEqual(second, first);
    assert.strictEqual(fs.statSync(tokenFile()).mode & 0o777, 0o600);
    fs.chmodSync(path.dirname(tokenFile()), 0o755);
    assert.strictEqual(loadOrCreateToken(), second); // the folder is closed again, the token kept
    assert.strictEqual(fs.statSync(path.dirname(tokenFile())).mode & 0o777, 0o700);
    const elsewhere = path.join(root, 'elsewhere');
    fs.writeFileSync(elsewhere, 'b'.repeat(64), {mode: 0o600});
    fs.rmSync(tokenFile());
    fs.symlinkSync(elsewhere, tokenFile());
    assert.notStrictEqual(loadOrCreateToken(), 'b'.repeat(64));
    assert.ok(!fs.lstatSync(tokenFile()).isSymbolicLink());
    assert.strictEqual(fs.readFileSync(elsewhere, 'utf8'), 'b'.repeat(64)); // the link's target untouched
  } finally {
    process.env.SAM_UI_TOKEN_DIR = saved;
  }
});

test('closing the tools drops held track streams', async () => {
  const start = textOf(await call('sam_track', {command: 'start', session_id: 's1'}));
  assert.strictEqual(start.job_id, 'job-1');
  const dropped = new Promise(r => track.once('close', r));
  app.tools.close();
  await dropped; // the backend sees its reader go, which cancels the job
  track = null; // as the real backend does: a cancelled job leaves /track_jobs
  const r = await call('sam_track', {command: 'status', session_id: 's1', job_id: 'job-1'});
  assert.strictEqual(r.isError, true);
});

test('deleting the token file revokes the token, and "null" never passes', async () => {
  const saved = fs.readFileSync(tokenFile(), 'utf8');
  fs.rmSync(tokenFile());
  try {
    assert.strictEqual((await raw({})).status, 401);
    assert.strictEqual((await raw({auth: 'Bearer null'})).status, 401);
  } finally {
    fs.writeFileSync(tokenFile(), saved, {mode: 0o600});
  }
  assert.notStrictEqual((await raw({})).status, 401);
});

// -- studio awareness (issue #73) ---------------------------------------------

const VIEW = {
  open: true, video_id: 'gallery/01_dog.mp4', session_id: 'studio-1', frame: 7, n_frames: 10, playing: false,
  active_object: 1, engine: 'sam2', hidden_objects: [], colors: {1: '#ff00ff'}, next_object_id: 5,
};

/** Tools over the fake backend with a studio whose view the test sets, and the changes it was told. */
function studioTools(view = VIEW) {
  const s = {view, events: []};
  s.tools = createTools({backend: backendClient({port: fake.address().port}), exportRoot: EXPORT_ROOT,
    studio: {view: () => parseView(s.view)}, onChange: e => s.events.push(e), now: () => 1000});
  s.call = async (name, args) => s.tools.callTool(name, args);
  return s;
}

test('parseView keeps a good report and drops a bad one whole', () => {
  assert.deepStrictEqual(parseView(VIEW), {...VIEW});
  assert.deepStrictEqual(parseView({open: false, video_id: 'x'}), {open: false});
  const bad = [
    null, 'open', [VIEW], {}, {open: 'yes'},
    {...VIEW, frame: 10}, {...VIEW, frame: -1}, {...VIEW, frame: 1.5}, {...VIEW, n_frames: 2 ** 60},
    {...VIEW, video_id: ''}, {...VIEW, video_id: 'a\nb'}, {...VIEW, video_id: 'x'.repeat(513)}, {...VIEW, video_id: 7},
    {...VIEW, session_id: '../s'}, {...VIEW, session_id: 'x'.repeat(129)},
    {...VIEW, engine: 'SAM 2'}, {...VIEW, active_object: -1}, {...VIEW, active_object: '1'}, {...VIEW, playing: 0},
    {...VIEW, hidden_objects: [1, -2]}, {...VIEW, hidden_objects: Array(1001).fill(1)}, {...VIEW, hidden_objects: 'all'},
    {...VIEW, colors: {1: 'red'}}, {...VIEW, colors: {x: '#ff00ff'}}, {...VIEW, colors: ['#ff00ff']},
    {...VIEW, colors: JSON.parse('{"__proto__": "#ff00ff"}')},
    {...VIEW, colors: Object.fromEntries(Array.from({length: 1001}, (_, i) => [i, '#000000']))},
    {...VIEW, next_object_id: null}, {...VIEW, pad: 'x'.repeat(64 * 1024)},
  ];
  for (const v of bad) assert.strictEqual(parseView(v), null, JSON.stringify(v)?.slice(0, 80));
  const cyclic = {...VIEW};
  cyclic.self = cyclic;
  assert.strictEqual(parseView(cyclic), null);
  assert.strictEqual(parseView({...VIEW, extra: 1}).extra, undefined); // only known keys are copied
});

test('sam_studio state: closed on its own, the view with the layer\'s name in the app', async () => {
  assert.deepStrictEqual(textOf(await call('sam_studio', {command: 'state'})), {open: false});
  const s = studioTools();
  const t = textOf(await s.call('sam_studio', {command: 'state'}));
  assert.deepStrictEqual(t.active_object, {id: 1, name: 'dog'});
  assert.strictEqual(t.frame, 7);
  assert.strictEqual(t.session_id, 'studio-1');
  s.view = {open: false};
  assert.deepStrictEqual(textOf(await s.call('sam_studio', {command: 'state'})), {open: false});
  s.view = {...VIEW, frame: 99}; // a report that failed its checks counts as none
  assert.deepStrictEqual(textOf(await s.call('sam_studio', {command: 'state'})), {open: false});
});

test('open on studio\'s video shares its session, pictures the person\'s frame, and close leaves it open', async () => {
  const s = studioTools();
  const before = seen.length;
  const t = textOf(await s.call('sam_session', {command: 'open', video_id: 'gallery/01_dog.mp4'}));
  assert.strictEqual(t.session_id, 'studio-1');
  assert.strictEqual(t.shared, true);
  assert.strictEqual(t.studio_frame, 7);
  assert.strictEqual(t.next_id, 5); // studio's next id beats the server's 2
  assert.ok(!seen.slice(before).some(q => q.url === '/graphql' && q.body.query.includes('startSession')));
  assert.deepStrictEqual(last('/capture').body, {session_id: 'studio-1', frames: [7], colors: {1: '#ff00ff'}});
  const closing = seen.length;
  assert.deepStrictEqual(textOf(await s.call('sam_session', {command: 'close', session_id: 'studio-1'})), {closed: false, shared: true});
  assert.strictEqual(seen.length, closing);
  // another video: a session of its own, and a close that closes it
  const own = textOf(await s.call('sam_session', {command: 'open', video_id: 'gallery/02_cat.mp4'}));
  assert.strictEqual(own.shared, false);
  assert.strictEqual(own.session_id, 's1');
  assert.strictEqual(own.next_id, 2);
  assert.deepStrictEqual(textOf(await s.call('sam_session', {command: 'close', session_id: 's1'})), {closed: true});
});

test('a shared session the person closed says so', async () => {
  const s = studioTools({...VIEW, session_id: 'gone'});
  await s.call('sam_session', {command: 'open', video_id: 'gallery/01_dog.mp4'});
  const r = await s.call('sam_query', {command: 'objects', session_id: 'gone'});
  assert.strictEqual(r.isError, true);
  assert.strictEqual(r.content[0].text, 'The person closed this video in studio. sam_session open it again.');
});

const CHANGES = [
  [{command: 'points', object_id: 2, frame: 4, points: [[0.5, 0.5, 1]], capture: false}, 'sam_edit', {kind: 'points', object_ids: [2], frame: 4}],
  [{command: 'text', object_id: 1, frame: 3, text: 'dog', capture: false}, 'sam_edit', {kind: 'text', object_ids: [1], frame: 3}],
  [{command: 'range', object_id: 1, start: 2, end: 5, state: 'absent'}, 'sam_edit', {kind: 'range', object_ids: [1], frame: 2, end: 5, state: 'absent'}],
  [{command: 'undo', object_id: 1}, 'sam_edit', {kind: 'undo', object_ids: [1]}],
  [{command: 'redo', object_id: 1}, 'sam_edit', {kind: 'redo', object_ids: [1]}],
  [{command: 'remove', object_id: 1}, 'sam_edit', {kind: 'remove', object_ids: [1]}],
  [{command: 'mark', object_id: 1, frame: 4}, 'sam_review', {kind: 'review', object_ids: [1], frame: 4, state: 'reviewed'}],
  [{command: 'mark', object_id: 1, frame: 4, reviewed: false}, 'sam_review', {kind: 'review', object_ids: [1], frame: 4, state: 'unreviewed'}],
  [{name: 'dog-73', object_ids: [1]}, 'sam_export', {kind: 'export', object_ids: [1], name: 'dog-73'}],
];

for (const [args, tool, want] of CHANGES) {
  test(`${tool} ${args.command ?? ''} tells studio ${want.kind}`, async () => {
    const s = studioTools();
    const r = await s.call(tool, {session_id: 'studio-1', ...args});
    assert.ok(!r.isError, JSON.stringify(r));
    assert.deepStrictEqual(s.events, [{video_id: 'gallery/01_dog.mp4', ...want, at: 1000}]);
  });
}

test('reads, refusals and unknown sessions tell studio nothing', async () => {
  const s = studioTools();
  for (const [tool, args] of [
    ['sam_query', {command: 'objects', session_id: 'studio-1'}],
    ['sam_capture', {command: 'frame', session_id: 'studio-1'}],
    ['sam_review', {command: 'queue', session_id: 'studio-1'}],
    ['sam_track', {command: 'status', session_id: 'studio-1'}],
    ['sam_studio', {command: 'state'}],
    ['sam_edit', {command: 'points', session_id: 'studio-1', object_id: 1, frame: 0, points: [[2, 0.5, 1]]}],
    ['sam_track', {command: 'start', session_id: 'studio-1', engine: 'nope'}],
    ['sam_edit', {command: 'remove', session_id: 'from-another-launch', object_id: 1}],
  ]) await s.call(tool, args);
  assert.deepStrictEqual(s.events, []);
});

test('a session opened here is told under its video', async () => {
  const s = studioTools({open: false});
  await s.call('sam_session', {command: 'open', video_id: 'gallery/03_blocks.mp4'});
  await s.call('sam_edit', {command: 'undo', session_id: 's1', object_id: 1});
  assert.deepStrictEqual(s.events, [{video_id: 'gallery/03_blocks.mp4', kind: 'undo', object_ids: [1], at: 1000}]);
});

test('a track tells its start with the job, and its end once the stream closes', async () => {
  const s = studioTools();
  await s.call('sam_track', {command: 'start', session_id: 'studio-1', object_ids: [1]});
  assert.deepStrictEqual(s.events, [{video_id: 'gallery/01_dog.mp4', kind: 'track_start', object_ids: [1], job_id: 'job-1', at: 1000}]);
  s.view = {open: false}; // the person moves off: the end is still told under the job's video
  track.end(part({frame_index: -1, results: [], done: true, job_id: 'job-1', engine: 'sam2', objects: [1], tracked: [1], failed: {}}));
  await s.call('sam_track', {command: 'wait', session_id: 'studio-1', job_id: 'job-1', timeout_s: 5});
  assert.deepStrictEqual(s.events[1], {video_id: 'gallery/01_dog.mp4', kind: 'track_done', object_ids: [1], job_id: 'job-1', state: 'done', at: 1000});
  s.view = VIEW;
  await s.call('sam_track', {command: 'start', session_id: 'studio-1'});
  await s.call('sam_track', {command: 'cancel', session_id: 'studio-1', job_id: 'job-1'});
  await s.call('sam_track', {command: 'wait', session_id: 'studio-1', job_id: 'job-1', timeout_s: 5});
  assert.deepStrictEqual(s.events.slice(2).map(e => e.kind), ['track_start', 'track_cancel']); // no second word for the cancel
  s.tools.close();
});

test('capture on studio\'s session takes the person\'s frame, colours, engine and hidden layers; args win', async () => {
  const s = studioTools({...VIEW, engine: 'sam3', hidden_objects: [1]});
  const r = await s.call('sam_capture', {command: 'frame', session_id: 'studio-1'});
  assert.deepStrictEqual(last('/capture').body, {session_id: 'studio-1', object_ids: [], engine: 'sam3', colors: {1: '#ff00ff'}, frames: [7]});
  assert.deepStrictEqual(textOf(r).hidden, [1]);
  await s.call('sam_capture', {command: 'frame', session_id: 'studio-1', frame: 2, object_ids: [1], engine: 'sam2'});
  assert.deepStrictEqual(last('/capture').body, {session_id: 'studio-1', object_ids: [1], engine: 'sam2', colors: {1: '#ff00ff'}, frames: [2]});
  await s.call('sam_capture', {command: 'sheet', session_id: 'studio-1', frames: [0, 1]});
  assert.deepStrictEqual(last('/capture').body, {session_id: 'studio-1', object_ids: [], engine: 'sam3', colors: {1: '#ff00ff'}, sheet: true, frames: [0, 1]});
  s.view = {...VIEW, engine: 'browser-sam2'}; // the page's own engine: the backend's default instead
  await s.call('sam_capture', {command: 'frame', session_id: 'studio-1'});
  assert.strictEqual(last('/capture').body.engine, undefined);
  const elsewhere = await s.call('sam_capture', {command: 'frame', session_id: 's9'});
  assert.strictEqual(elsewhere.isError, true);
  assert.match(elsewhere.content[0].text, /^frame must be given: studio is not on this video/);
});

test('sam_studio goto asks studio to move and passes on its answer', async () => {
  const s = studioTools();
  const asked = [];
  let answer = {moved: true, extra: 'x'};
  s.tools = createTools({backend: backendClient({port: fake.address().port}),
    studio: {view: () => parseView(s.view), goto: async req => (asked.push(req), answer)}});
  assert.deepStrictEqual(textOf(await s.call('sam_studio', {command: 'goto', frame: 3, object_id: 1})), {moved: true});
  assert.deepStrictEqual(asked, [{video_id: 'gallery/01_dog.mp4', frame: 3, object_id: 1}]);
  answer = {moved: false, reason: 'the person is playing the clip'};
  assert.deepStrictEqual(textOf(await s.call('sam_studio', {command: 'goto', frame: 3})), answer);
  answer = 'whatever';
  assert.deepStrictEqual(textOf(await s.call('sam_studio', {command: 'goto', object_id: 1})), {moved: false, reason: 'studio did not answer'});
  for (const args of [{}, {frame: 10}, {frame: -1}, {object_id: 'a'}]) {
    assert.strictEqual((await s.call('sam_studio', {command: 'goto', ...args})).isError, true, JSON.stringify(args));
  }
  assert.strictEqual(asked.length, 3);
  s.view = {open: false};
  assert.match((await s.call('sam_studio', {command: 'goto', frame: 0})).content[0].text, /no video open/);
});

test('parseGotoReply keeps a short plain reason only', () => {
  assert.deepStrictEqual(parseGotoReply({moved: false, reason: 'busy'}), {moved: false, reason: 'busy'});
  assert.deepStrictEqual(parseGotoReply({moved: false, reason: 'a\nb'}), {moved: false, reason: 'studio did not move'});
  assert.deepStrictEqual(parseGotoReply({moved: 'yes'}), {moved: false, reason: 'studio did not answer'});
  assert.deepStrictEqual(parseGotoReply(null), {moved: false, reason: 'studio did not answer'});
});

test('next_id is past studio\'s own next id on its video', async () => {
  const s = studioTools();
  assert.strictEqual(textOf(await s.call('sam_query', {command: 'objects', session_id: 'studio-1'})).next_id, 5);
  s.view = {...VIEW, next_object_id: 0};
  assert.strictEqual(textOf(await s.call('sam_query', {command: 'objects', session_id: 'studio-1'})).next_id, 2);
});
