// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Pictures for effect clips (Replace background's Image fill), kept in this
// browser's Origin Private File System beside the browser engine's projects,
// under the sha-256 of their bytes: a clip stores only that key (an image
// param), so the effect doc stays small and two clips share one copy. A
// picture larger than the video is scaled down to fit it first. Another
// browser, or cleared site data, has no copy: the clip then draws its colour.
import {type Kv, OpfsKv} from '~/local/kv';
import {isImageHash} from './effectClips';

const DIR = 'effect-images';
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

let shared: Kv | null = null;
const store = (): Kv => {
  if (!OpfsKv.available()) {
    throw new Error('This browser cannot store pictures for effects.');
  }
  return (shared ??= new OpfsKv());
};

/** w x h scaled down (never up) to fit in maxWidth x maxHeight, in whole pixels. */
export function fitWithin(w: number, h: number, maxWidth: number, maxHeight: number): [number, number] {
  const s = Math.min(1, maxWidth / w, maxHeight / h);
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Store a picked picture (PNG, JPEG or WebP), no larger than the video
 * (maxWidth x maxHeight), and answer its key. One that fits is kept byte for byte.
 */
export async function storeEffectImage(file: Blob, maxWidth: number, maxHeight: number, kv: Kv = store()): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new Error('Choose a PNG, JPEG or WebP picture.');
  }
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That picture could not be read.');
  });
  try {
    const [w, h] = fitWithin(bitmap.width, bitmap.height, maxWidth, maxHeight);
    let bytes: Uint8Array;
    if (w === bitmap.width && h === bitmap.height) {
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
      bytes = new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer());
    }
    const key = await sha256Hex(bytes);
    await kv.write(`${DIR}/${key}`, bytes);
    return key;
  } finally {
    bitmap.close();
  }
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
