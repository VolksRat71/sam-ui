// sam-ui (Apache-2.0). New file, not from SAM 2.
// The After Effects bridge client against a fake bridge on a local port.
//
// fixtures/media-inventory.sample.json is the bridge's contract sample, copied
// unchanged from VolksRat71/after-effects-mcp-vision
// test/fixtures/media-inventory.sample.json (branch feat/media-inventory,
// commit ab017b2): the full /rpc reply to {"op": "media", "args":
// {"includeIneligible": true}}. Copy it again when that contract changes.
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');

const {AeBridgeError, createAeClient} = require('../src/ae-bridge');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'media-inventory.sample.json'), 'utf8'));

function tokenFile(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'samui-ae-'));
  const file = path.join(dir, 'token');
  if (value != null) fs.writeFileSync(file, value + '\n');
  return file;
}

/** A fake bridge: `handler(req, body)` returns {status, json} (or null to never answer). */
async function fakeBridge(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      seen.push({url: req.url, headers: req.headers, body});
      const out = await handler(req, body);
      if (out == null) return; // hang
      res.writeHead(out.status ?? 200, {'Content-Type': 'application/json'});
      res.end(typeof out.json === 'string' ? out.json : JSON.stringify(out.json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {port: server.address().port, seen, close: () => new Promise(r => server.close(r)), server};
}

const withBridge = async (handler, fn) => {
  const b = await fakeBridge(handler);
  try {
    await fn(b);
  } finally {
    b.server.closeAllConnections();
    await b.close();
  }
};

test('a request carries the bearer token, the pinned Host, and no Origin', async () => {
  await withBridge(
    () => ({json: {ok: true, result: {loadedAt: 1, opCount: 40, aeVersion: '26.0x67'}}}),
    async b => {
      const client = createAeClient({port: b.port, tokenPath: tokenFile('abc123')});
      assert.deepStrictEqual(await client.status(), {state: 'ready', aeVersion: '26.0x67'});
      const {url, headers, body} = b.seen[0];
      assert.strictEqual(url, '/rpc');
      assert.strictEqual(headers.authorization, 'Bearer abc123');
      assert.strictEqual(headers.host, `127.0.0.1:${b.port}`);
      assert.strictEqual(headers.origin, undefined);
      assert.deepStrictEqual(body, {op: 'hostInfo', args: {}});
    },
  );
});

test('the token is read on every request, so a rotated one works at once', async () => {
  const file = tokenFile('one');
  await withBridge(
    () => ({json: {ok: true, result: {}}}),
    async b => {
      const client = createAeClient({port: b.port, tokenPath: file});
      await client.rpc('hostInfo');
      fs.writeFileSync(file, 'two');
      await client.rpc('hostInfo');
      assert.deepStrictEqual(b.seen.map(s => s.headers.authorization), ['Bearer one', 'Bearer two']);
    },
  );
});

test('a 401 re-reads the token once and retries; a second 401 is unauthorized', async () => {
  const file = tokenFile('stale');
  await withBridge(
    req => {
      if (req.headers.authorization === 'Bearer fresh') return {json: {ok: true, result: 'fine'}};
      fs.writeFileSync(file, 'fresh'); // the panel wrote a new token just after we read the old one
      return {status: 401, json: {ok: false, error: {code: 'unauthorized', message: 'bad token'}}};
    },
    async b => {
      const client = createAeClient({port: b.port, tokenPath: file});
      assert.strictEqual(await client.rpc('hostInfo'), 'fine');
      assert.strictEqual(b.seen.length, 2);
    },
  );
  await withBridge(
    () => ({status: 401, json: {ok: false}}),
    async b => {
      const client = createAeClient({port: b.port, tokenPath: tokenFile('wrong')});
      await assert.rejects(client.rpc('hostInfo'), e => e instanceof AeBridgeError && e.code === 'unauthorized');
      assert.strictEqual(b.seen.length, 2);
    },
  );
});

test('a 403 is forbidden, with the bridge\'s reason', async () => {
  await withBridge(
    () => ({status: 403, json: {ok: false, error: {code: 'forbidden_origin', message: 'origin refused'}}}),
    async b => {
      const client = createAeClient({port: b.port, tokenPath: tokenFile('t')});
      await assert.rejects(client.rpc('media'), e => e.code === 'forbidden' && /origin refused/.test(e.message));
    },
  );
});

test('no token file is not-installed, and nothing is sent', async () => {
  await withBridge(
    () => ({json: {ok: true, result: {}}}),
    async b => {
      const client = createAeClient({port: b.port, tokenPath: tokenFile(null)});
      await assert.rejects(client.rpc('media'), e => e.code === 'not-installed' && /token/.test(e.message));
      const s = await client.status();
      assert.strictEqual(s.state, 'not-installed');
      assert.match(s.installUrl, /after-effects-mcp-vision/);
      assert.strictEqual(b.seen.length, 0);
    },
  );
});

test('nothing listening is not-running (After Effects closed)', async () => {
  const b = await fakeBridge(() => null);
  const port = b.port;
  await b.close();
  const client = createAeClient({port, tokenPath: tokenFile('t')});
  await assert.rejects(client.listMedia(), e => e.code === 'not-running' && /Open After Effects/.test(e.message));
  assert.strictEqual((await client.status()).state, 'not-running');
});

test('no answer in time is a timeout', async () => {
  await withBridge(
    () => null,
    async b => {
      const client = createAeClient({port: b.port, tokenPath: tokenFile('t'), timeoutMs: 150});
      await assert.rejects(client.rpc('media'), e => e.code === 'timeout');
    },
  );
});

test('an op the bridge lacks is outdated; a failing op keeps its message', async () => {
  await withBridge(
    (_req, body) =>
      body.op === 'media'
        ? {json: {ok: false, error: {code: 'unknown_op', message: 'No such op: media'}}}
        : {json: {ok: false, error: {code: 'host_error', message: 'No layer with id 9'}}},
    async b => {
      const client = createAeClient({port: b.port, tokenPath: tokenFile('t')});
      await assert.rejects(client.listMedia(), e => e.code === 'outdated');
      await assert.rejects(client.rpc('masks', {command: 'add', layerId: 9}), e => e.code === 'op-failed' && /No layer with id 9/.test(e.message));
    },
  );
});

test('listMedia returns the contract sample as the bridge sends it', async () => {
  await withBridge(
    () => ({json: FIXTURE}),
    async b => {
      const client = createAeClient({port: b.port, tokenPath: tokenFile('t')});
      const media = await client.listMedia();
      assert.deepStrictEqual(b.seen[0].body, {op: 'media', args: {includeIneligible: true}});
      assert.strictEqual(media.project.path, '/Users/example/Projects/Spot_30s/Spot_30s_v04.aep');
      assert.deepStrictEqual(media.items.map(i => i.id), [12, 15, 21]);
      // every field the adapter reads is in the contract
      for (const k of ['id', 'name', 'path', 'width', 'height', 'pixelAspect', 'duration', 'frameRate', 'frames', 'missing', 'useProxy', 'interpretationOverrides', 'hasAudio']) {
        assert.ok(k in media.items[0], k);
      }
    },
  );
});

test('tool() goes through /mcp tools/call and parses its text; isError rejects', async () => {
  await withBridge(
    (_req, body) =>
      body.params.arguments.layerId === 1
        ? {json: {jsonrpc: '2.0', id: body.id, result: {content: [{type: 'text', text: '{"numKeys": 3}'}]}}}
        : {json: {jsonrpc: '2.0', id: body.id, result: {content: [{type: 'text', text: 'keysPath: no file at /x'}], isError: true}}},
    async b => {
      const client = createAeClient({port: b.port, tokenPath: tokenFile('t')});
      assert.deepStrictEqual(await client.tool('ae_masks', {command: 'setPathKeys', layerId: 1}), {numKeys: 3});
      assert.strictEqual(b.seen[0].url, '/mcp');
      assert.strictEqual(b.seen[0].body.method, 'tools/call');
      assert.strictEqual(b.seen[0].body.params.name, 'ae_masks');
      await assert.rejects(client.tool('ae_masks', {layerId: 2}), e => e.code === 'op-failed' && /no file at/.test(e.message));
    },
  );
});
