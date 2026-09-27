// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// 8-bit grayscale PNGs (what the rotoscoping working folder's mattes are),
// written directly: the canvas encoders only make RGBA.
import {crc32} from './zip';

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  // "deflate" is the zlib format PNG's IDAT holds
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A row-major w x h grayscale image (0-255) as a PNG file. */
export async function grayPng(pixels: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const raw = new Uint8Array((w + 1) * h); // filter byte 0 per row
  for (let y = 0; y < h; y++) {
    raw.set(pixels.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
