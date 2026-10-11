// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Pictures for effect clips (Replace background's Image fill), kept in this
// browser's Origin Private File System beside the browser engine's projects,
// under the sha-256 of their bytes: a clip stores only that key (an image
// param), so the effect doc stays small and two clips share one copy. A
// picture larger than Cover needs on the video is scaled down to that first.
// Another browser, or cleared site data, has no copy: the clip then draws its colour.
import {type Kv, OpfsKv} from '~/local/kv';
import {isImageHash} from './effectClips';

const DIR = 'effect-images';
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

/** The picture stored under `key`, decoded; null when this browser has no (readable) copy. */
export async function loadEffectImage(key: string, kv?: Kv): Promise<ImageBitmap | null> {
  if (!isImageHash(key)) {
    return null;
  }
  try {
    const blob = await (kv ?? store()).blob(`${DIR}/${key}`);
    return blob == null ? null : await createImageBitmap(blob);
  } catch {
    return null;
  }
}
