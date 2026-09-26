// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Verified downloads, used for the SAM 2.1 checkpoint and for SAM 3's weights
// from Hugging Face (a gated repo: the user accepts Meta's SAM License there and
// brings their own token). Nothing is kept unless its hash matches:
//   - LFS files (model.safetensors): sha256, from the Hub's tree listing, or a
//     pinned value when the listing masks it;
//   - small files (config, tokenizer): the git blob sha1 the Hub lists.
// The token goes only to huggingface.co: a redirect to another host (the CDN
// that serves the bytes) is followed without it. It is never written anywhere.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const HUB = 'https://huggingface.co';
const HUB_HOST = 'huggingface.co';

// What transformers needs from facebook/sam3. sam3.pt (Meta's own format) is a
// pickle and is not needed, so it is never downloaded.
const SAM3_FILES = [
  'config.json', 'model.safetensors', 'processor_config.json', 'special_tokens_map.json',
  'tokenizer.json', 'tokenizer_config.json', 'merges.txt', 'vocab.json', 'LICENSE', 'README.md',
];
const SAM3_REQUIRED = ['config.json', 'model.safetensors', 'processor_config.json'];
// The model.safetensors sam-ui was tested with (facebook/sam3, 2026-09). Used
// when the Hub's listing hides a gated file's sha256.
const SAM3_PINNED_SHA256 = {'model.safetensors': '6d06f0a5f84e435071fe6603e61d0b4cc7b40e0d39d487cfd4d67d8cc11cc14a'};

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

/** GET a URL; follow redirects, sending `headers` only while on huggingface.co. */
function request(url, headers, onResponse, onError, hops = 0) {
  const u = new URL(url);
  if (u.protocol !== 'https:') return onError(new Error(`refusing a non-https URL: ${url}`));
  if (hops > 8) return onError(new Error('too many redirects'));
  const onHub = u.hostname === HUB_HOST || u.hostname.endsWith('.' + HUB_HOST);
  https
    .get(url, {headers: onHub ? headers : {}}, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return request(new URL(res.headers.location, url).toString(), headers, onResponse, onError, hops + 1);
      }
      onResponse(res);
    })
    .on('error', onError);
}

function getJson(url, headers) {
  return new Promise((resolve, reject) =>
    request(
      url,
      headers,
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(httpError(res.statusCode, body));
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      },
      reject,
    ),
  );
}

function httpError(status, body = '') {
  const hint =
    status === 401 ? 'the token was refused (check it is a valid read token)'
    : status === 403 ? 'access denied: accept the licence on the model page first, and wait for approval'
    : status === 404 ? 'not found'
    : `HTTP ${status}`;
  const err = new Error(hint + (body && status >= 500 ? ` (${body.slice(0, 200)})` : ''));
  err.status = status;
  return err;
}

/**
 * Download `url` to `dest`, verified. `expect` is {sha256} or {gitBlobSha1, size}.
 * The bytes go to dest.part and are renamed only after the hash matches; a
 * mismatch deletes the partial file.
 */
function downloadVerified(url, dest, expect, {headers = {}, onProgress = () => {}} = {}) {
  return new Promise((resolve, reject) => {
    const part = dest + '.part';
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    request(
      url,
      headers,
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(httpError(res.statusCode));
        }
        const total = Number(res.headers['content-length']) || expect.size || 0;
        const hash = crypto.createHash(expect.sha256 ? 'sha256' : 'sha1');
        if (!expect.sha256) hash.update(`blob ${expect.size}\0`); // git's blob id
        let got = 0;
        const out = fs.createWriteStream(part);
        res.on('data', c => {
          got += c.length;
          hash.update(c);
          onProgress(got, total);
        });
        res.on('error', reject);
        res.pipe(out);
        out.on('finish', () =>
          out.close(() => {
            const digest = hash.digest('hex');
            const want = expect.sha256 || expect.gitBlobSha1;
            if ((expect.size && got !== expect.size) || digest !== want) {
              fs.rmSync(part, {force: true});
              return reject(new Error(`${path.basename(dest)}: checksum mismatch; the download was deleted`));
            }
            fs.renameSync(part, dest);
            resolve({bytes: got, digest});
          }),
        );
      },
      reject,
    );
  });
}

/** Which files to fetch from a repo, with what to verify each against. */
async function planRepoDownload(repo, token, {files = SAM3_FILES, required = SAM3_REQUIRED, pinned = SAM3_PINNED_SHA256} = {}) {
  const headers = token ? {Authorization: `Bearer ${token}`} : {};
  const tree = await getJson(`${HUB}/api/models/${repo}/tree/main`, headers);
  const byPath = new Map(tree.filter(e => e.type === 'file').map(e => [e.path, e]));
  const missing = required.filter(f => !byPath.has(f));
  if (missing.length) throw new Error(`${repo} has no ${missing.join(', ')}`);
  return files
    .filter(f => byPath.has(f))
    .map(f => {
      const e = byPath.get(f);
      let expect;
      if (e.lfs) {
        const sha256 = HEX64.test(e.lfs.oid || '') ? e.lfs.oid : pinned[f];
        if (!sha256) throw new Error(`${f}: the Hub gave no checksum and none is pinned; refusing to download it`);
        expect = {sha256, size: e.lfs.size || e.size};
      } else {
        if (!HEX40.test(e.oid || '')) throw new Error(`${f}: no git id to verify against`);
        expect = {gitBlobSha1: e.oid, size: e.size};
      }
      return {path: f, url: `${HUB}/${repo}/resolve/main/${encodeURI(f)}`, expect};
    });
}

/** Download a repo's files into `dir`, verified; `onProgress(done, total, file)`. */
async function downloadRepo(repo, token, dir, {onProgress = () => {}, ...opts} = {}) {
  const plan = await planRepoDownload(repo, token, opts);
  const headers = token ? {Authorization: `Bearer ${token}`} : {};
  const total = plan.reduce((n, f) => n + (f.expect.size || 0), 0);
  let before = 0;
  for (const f of plan) {
    const dest = path.join(dir, f.path);
    await downloadVerified(f.url, dest, f.expect, {headers, onProgress: got => onProgress(before + got, total, f.path)});
    before += f.expect.size || 0;
  }
  return plan.map(f => f.path);
}

module.exports = {downloadVerified, planRepoDownload, downloadRepo, SAM3_FILES, SAM3_REQUIRED, SAM3_PINNED_SHA256, request};
