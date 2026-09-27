// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Fetches the browser engine's model files. They are never in the repo or
// the build: in dev they come from a gitignored studio/.models/<repo>/ when
// it is there (served by Vite), otherwise from Hugging Face, and a download
// is kept in Cache Storage so the next load is local.
import {MODEL_FILES, type ModelFile, type Variant} from './sam2/config';

export type ModelFileName = ModelFile | 'constants.json';
export type DownloadProgress = {file: ModelFileName; loaded: number; total: number; source: 'local' | 'cache' | 'network'};

const CACHE = 'sam-ui-models-v1';

export function hubUrl(repo: string, file: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}

/** Where a local copy may be (dev: studio/.models, or VITE_MODEL_BASE), or null. */
export function localBase(): string | null {
  const env = import.meta.env as Record<string, string | boolean | undefined>;
  const base = env.VITE_MODEL_BASE;
  if (typeof base === 'string' && base !== '') {
    return base.replace(/\/+$/, '');
  }
  return env.DEV ? '/.models' : null;
}

async function readAll(response: Response, onBytes: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const total = Number(response.headers.get('Content-Length') ?? 0);
  if (response.body == null) {
    const buf = new Uint8Array(await response.arrayBuffer());
    onBytes(buf.length, buf.length);
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    loaded += value.length;
    onBytes(loaded, Math.max(total, loaded));
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE);
  } catch {
    return null; // private mode, or storage blocked: download every time
  }
}

/** One model file: a local copy, else the cached download, else Hugging Face. */
export async function loadModelFile(
  variant: Variant,
  file: ModelFileName,
  onProgress?: (p: DownloadProgress) => void,
): Promise<Uint8Array> {
  const local = localBase();
  if (local != null) {
    const response = await fetch(`${local}/${variant.repo}/${file}`).catch(() => null);
    // Vite answers unknown paths with index.html, so check what came back
    if (response?.ok && !(response.headers.get('Content-Type') ?? '').includes('text/html')) {
      return readAll(response, (loaded, total) => onProgress?.({file, loaded, total, source: 'local'}));
    }
  }
  const url = hubUrl(variant.repo, file);
  const cache = await openCache();
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit != null) {
    return readAll(hit, (loaded, total) => onProgress?.({file, loaded, total, source: 'cache'}));
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const bytes = await readAll(response, (loaded, total) => onProgress?.({file, loaded, total, source: 'network'}));
  await cache
    ?.put(url, new Response(bytes, {headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length)}}))
    .catch(() => {}); // over quota: it still runs, and downloads again next time
  return bytes;
}

/** Whether every file of a variant is already in Cache Storage (no download needed). */
export async function isCached(variant: Variant): Promise<boolean> {
  const cache = await openCache();
  if (cache == null) {
    return false;
  }
  const files: ModelFileName[] = ['constants.json', ...MODEL_FILES];
  const hits = await Promise.all(files.map(f => cache.match(hubUrl(variant.repo, f)).catch(() => undefined)));
  return hits.every(h => h != null);
}

/**
 * Where a variant's files would come from right now: a local copy (dev, or
 * VITE_MODEL_BASE), this browser's cache, or a download. For the picker's
 * status line; the loader decides again when it runs.
 */
export async function modelAvailability(variant: Variant): Promise<'local' | 'cached' | 'download'> {
  const local = localBase();
  if (local != null) {
    const response = await fetch(`${local}/${variant.repo}/constants.json`, {method: 'HEAD'}).catch(() => null);
    if (response?.ok && !(response.headers.get('Content-Type') ?? '').includes('text/html')) {
      return 'local';
    }
  }
  return (await isCached(variant)) ? 'cached' : 'download';
}
