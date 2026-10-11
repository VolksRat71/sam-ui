// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Pictures for effect clips (Replace background's Image fill), kept in this
// browser's Origin Private File System beside the browser engine's projects,
// under the sha-256 of their bytes: a clip stores only that key (an image
// param), so the effect doc stays small and two clips share one copy. A
// picture larger than Cover needs on the video is scaled down to that first.
// Another browser, or cleared site data, has no copy: the clip then draws its colour.
import {type Kv, OpfsKv} from '~/local/kv';
import {imageKeys, isImageHash, parseEffectDoc} from './effectClips';

const DIR = 'effect-images';
const DOC_PREFIX = 'sam-ui-studio:effects:v2:';
/** A stored picture younger than this is never freed: a clip may be about to save it. */
export const KEEP_NEW_MS = 10 * 60 * 1000;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/** Refused before reading: a file this big, or a picture of more pixels, would spike memory to decode. */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 100e6;

let shared: Kv | null = null;
const store = (): Kv => {
  if (!OpfsKv.available()) {
    throw new Error('This browser cannot store pictures for effects.');
  }
  return (shared ??= new OpfsKv());
};

/**
 * The size to keep a w x h picture at for a maxWidth x maxHeight video: no
 * larger than Cover needs (it fills the frame without being scaled up), never
 * scaled up itself, and its long side at most twice the video's (a panorama).
 */
export function coverSize(w: number, h: number, maxWidth: number, maxHeight: number): [number, number] {
  const s = Math.min(1, Math.max(maxWidth / w, maxHeight / h), (2 * Math.max(maxWidth, maxHeight)) / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/** A picture file's width and height from its header, without making a bitmap of it. */
async function naturalSize(file: Blob): Promise<[number, number]> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    return [img.naturalWidth, img.naturalHeight];
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Store a picked picture (PNG, JPEG or WebP), no larger than Cover needs on
 * the video (maxWidth x maxHeight), and answer its key. One that already fits
 * is kept byte for byte; a larger one is decoded straight at the smaller size.
 */
export async function storeEffectImage(file: Blob, maxWidth: number, maxHeight: number, kv: Kv = store()): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new Error('Choose a PNG, JPEG or WebP picture.');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('That picture is over 50 MB: choose a smaller one.');
  }
  const [w0, h0] = await naturalSize(file).catch(() => {
    throw new Error('That picture could not be read.');
  });
  if (w0 * h0 > MAX_IMAGE_PIXELS) {
    throw new Error('That picture is over 100 megapixels: choose a smaller one.');
  }
  const [w, h] = coverSize(w0, h0, maxWidth, maxHeight);
  let bytes: Uint8Array;
  if (w === w0 && h === h0) {
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    const bitmap = await createImageBitmap(file, {resizeWidth: w, resizeHeight: h, resizeQuality: 'high'}).catch(() => {
      throw new Error('That picture could not be read.');
    });
    try {
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      bytes = new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer());
    } finally {
      bitmap.close();
    }
  }
  const key = await sha256Hex(bytes);
  await kv.write(`${DIR}/${key}`, bytes);
  return key;
}

/** Why a clip's picture cannot be drawn: this browser has no copy, or the copy does not decode. */
export type ImageProblem = 'missing' | 'unreadable';

/** The picture stored under `key`, decoded, or why it cannot be. */
export async function loadEffectImage(key: string, kv?: Kv): Promise<ImageBitmap | ImageProblem> {
  if (!isImageHash(key)) {
    return 'missing';
  }
  let blob: Blob | null;
  try {
    blob = await (kv ?? store()).blob(`${DIR}/${key}`);
  } catch {
    return 'missing';
  }
  if (blob == null) {
    return 'missing';
  }
  return createImageBitmap(blob).catch(() => 'unreadable' as const);
}

/**
 * The picture keys every saved effect doc uses, from localStorage's
 * [key, value] entries: each doc's image settings (whatever effect has one),
 * and hash values of an effect this build does not know. Null when a saved
 * doc does not parse: nothing can then be freed safely.
 */
export function savedImageKeys(entries: Iterable<[string, string | null]>): Set<string> | null {
  const keys = new Set<string>();
  for (const [k, v] of entries) {
    if (k.startsWith(DOC_PREFIX) && v != null) {
      let raw: unknown;
      try {
        raw = JSON.parse(v);
      } catch {
        return null;
      }
      imageKeys(parseEffectDoc(raw)).forEach(key => keys.add(key));
    }
  }
  return keys;
}

/** The stored pictures to free: no saved doc uses them and they are older than KEEP_NEW_MS (an unknown age is kept). */
export function unusedImages(files: Array<{name: string; modified: number | null}>, used: ReadonlySet<string>, now: number): string[] {
  return files
    .filter(f => isImageHash(f.name) && !used.has(f.name) && f.modified != null && now - f.modified >= KEEP_NEW_MS)
    .map(f => f.name);
}

/**
 * Free the stored pictures no saved effect doc uses (run once, at app
 * start: the undo journal is not persisted, so nothing else can bring one
 * back). Never throws: a failure only leaves pictures stored.
 */
export async function freeUnusedEffectImages(kv?: Kv, storage?: Storage, now = Date.now()): Promise<void> {
  // ponytail: another tab open for over KEEP_NEW_MS can still undo back to a freed picture (its clip then draws its colour); share the journal if that bites
  try {
    if (kv == null && !OpfsKv.available()) {
      return;
    }
    const k = kv ?? store();
    const ls = storage ?? window.localStorage;
    const used = savedImageKeys(Array.from({length: ls.length}, (_, i) => ls.key(i)!).map(key => [key, ls.getItem(key)]));
    if (used == null) {
      return;
    }
    const files = await Promise.all(
      (await k.list(DIR)).map(async name => {
        const blob = await k.blob(`${DIR}/${name}`);
        return {name, modified: blob instanceof File ? blob.lastModified : null};
      }),
    );
    for (const name of unusedImages(files, used, now)) {
      await k.remove(`${DIR}/${name}`);
    }
  } catch (error) {
    console.warn('Could not free unused effect pictures', error);
  }
}
