// sam-ui (Apache-2.0). New file, not from SAM 2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {serve} from './static-server.mjs';

const get = (server, pathname) => new Promise((resolve, reject) => {
  http.get({host: '127.0.0.1', port: server.address().port, path: pathname}, res => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => resolve({status: res.statusCode, body}));
  }).on('error', reject);
});

test('the benchmark server confines requests to its build directory', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-ui-static-test-'));
  const root = path.join(dir, 'site');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(dir, 'site-other'));
  fs.writeFileSync(path.join(root, 'index.html'), 'inside');
  fs.writeFileSync(path.join(dir, 'site-other', 'fixture.txt'), 'outside');
  const server = await serve(root, 'http://127.0.0.1:0/sam-ui/');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, {recursive: true});
  });
  assert.deepEqual(await get(server, '/sam-ui/'), {status: 200, body: 'inside'});
  assert.equal((await get(server, '/sam-ui/%2e%2e/site-other/fixture.txt')).status, 403);
  assert.equal((await get(server, '/sam-ui/%ZZ')).status, 400);
  assert.equal((await get(server, '/elsewhere/')).status, 404);
});
