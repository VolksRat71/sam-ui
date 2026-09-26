// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Paints RLE masks (COCO order: column-major, size [height, width]) into RGBA
// pixels: a translucent fill and a solid outline in each object's colour,
// the look of Meta's Overlay highlight, for any number of objects.
import {decode, type RLEObject} from '@/jscocotools/mask';

export const FILL_ALPHA = 0.45;
const EDGE = 2; // outline width, in video pixels

export function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  return m == null
    ? [255, 0, 0]
    : [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** One little-endian RGBA pixel as a Uint32. */
function pack(r: number, g: number, b: number, a: number): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * Paint `rle` into `out` (width * height pixels, row-major). Later calls
 * paint over earlier ones, so the last object drawn is on top.
 */
export function paintMask(
  out: Uint32Array,
  width: number,
  height: number,
  rle: RLEObject,
  color: string,
  fillAlpha: number = FILL_ALPHA,
): void {
  const [h, w] = rle.size;
  if (h !== height || w !== width) {
    return; // a mask at another resolution; never sent by the backend
  }
  const data = decode([rle]).data as Uint8Array; // index x * h + y
  const [r, g, b] = parseHex(color);
  const fill = pack(r, g, b, Math.round(fillAlpha * 255));
  const edge = pack(r, g, b, 255);
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && data[x * h + y] > 0;
  for (let x = 0; x < w; x++) {
    const col = x * h;
    for (let y = 0; y < h; y++) {
      if (data[col + y] === 0) {
        continue;
      }
      let border = false;
      for (let d = 1; d <= EDGE && !border; d++) {
        border = !on(x - d, y) || !on(x + d, y) || !on(x, y - d) || !on(x, y + d);
      }
      out[y * w + x] = border ? edge : fill;
    }
  }
}

/** A white-on-transparent alpha mask, for Meta's thumbnail code. */
export function paintAlpha(out: Uint32Array, rle: RLEObject): void {
  const [h, w] = rle.size;
  const data = decode([rle]).data as Uint8Array;
  const white = pack(255, 255, 255, 255);
  for (let x = 0; x < w; x++) {
    const col = x * h;
    for (let y = 0; y < h; y++) {
      if (data[col + y] > 0) {
        out[y * w + x] = white;
      }
    }
  }
}
