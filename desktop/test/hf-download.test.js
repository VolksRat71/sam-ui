// sam-ui (Apache-2.0). New file, not from SAM 2.
// node --test test/   (the network tests use small public Hugging Face repos)
'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');

const {downloadVerified, planRepoDownload, downloadRepo} = require('../src/hf-download');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'samui-hf-'));

test('a public repo downloads with every file verified by its git blob id', async () => {
  const dir = tmp();
  const got = await downloadRepo('hf-internal-testing/tiny-random-bert', null, dir, {
    files: ['config.json', 'model.safetensors', 'tokenizer.json'],
    required: ['config.json', 'model.safetensors'],
  });
  assert.deepStrictEqual(got, ['config.json', 'model.safetensors', 'tokenizer.json']);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).model_type);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.part')), []);
});

test('an LFS file is verified by its sha256 (following the redirect to the CDN)', async () => {
  const plan = await planRepoDownload('hf-internal-testing/tiny-random-bert', null, {
    files: ['pytorch_model.bin'], required: ['pytorch_model.bin'], pinned: {},
  });
  assert.match(plan[0].expect.sha256, /^[0-9a-f]{64}$/);
  const dest = path.join(tmp(), 'pytorch_model.bin');
  const r = await downloadVerified(plan[0].url, dest, plan[0].expect);
  assert.strictEqual(r.digest, plan[0].expect.sha256);
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex'), plan[0].expect.sha256);
});

test('a checksum mismatch keeps nothing', async () => {
  const [f] = await planRepoDownload('hf-internal-testing/tiny-random-bert', null, {files: ['config.json'], required: ['config.json']});
  const dest = path.join(tmp(), 'config.json');
  await assert.rejects(downloadVerified(f.url, dest, {gitBlobSha1: '0'.repeat(40), size: f.expect.size}), /checksum mismatch/);
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + '.part'));
});

test('a missing required file is refused before any download', async () => {
  await assert.rejects(planRepoDownload('hf-internal-testing/tiny-random-bert', null, {files: ['x'], required: ['model.safetensors', 'nope.json']}), /has no nope\.json/);
});

test('the gated SAM 3 repo without a token says to accept the licence, not a raw error', async () => {
  const plan = planRepoDownload('facebook/sam3', null);
  // the listing is public but masks the LFS hash: the pinned one is used for model.safetensors
  const files = await plan;
  const model = files.find(f => f.path === 'model.safetensors');
  assert.strictEqual(model.expect.sha256, '6d06f0a5f84e435071fe6603e61d0b4cc7b40e0d39d487cfd4d67d8cc11cc14a');
  assert.ok(!files.some(f => f.path === 'sam3.pt'), 'sam3.pt (a pickle) is never downloaded');
  await assert.rejects(downloadVerified(files[0].url, path.join(tmp(), 'c.json'), files[0].expect), /token was refused|accept the licence/);
});

test('non-https URLs are refused', async () => {
  await assert.rejects(downloadVerified('http://huggingface.co/x', path.join(tmp(), 'x'), {sha256: 'a'.repeat(64)}), /non-https/);
});
