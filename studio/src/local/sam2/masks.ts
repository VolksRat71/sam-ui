// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Pure pixel work for the browser SAM 2 engine, done as SAM 2's Python video
// predictor does it (sam2/sam2_video_predictor.py, sam2/utils/misc.py):
//   - bilinear resizes that match torch.nn.functional.interpolate
//     (align_corners=False, with and without antialias);
//   - the decoder's low-res logits to a video-size mask, thresholded at 0,
//     as COCO RLE (column-major, jscocotools' encode);
//   - SAM 2's optional small-hole fill (fill_hole_area);
//   - an approved mask as the memory encoder's mask input (add_new_mask +
//     use_mask_input_as_output_without_sam: resized, >= 0.5, then *20 - 10);
//   - frame preprocessing (RGBA to normalised CHW floats).
import {DataArray, decode, encode, type RLEObject} from '@/jscocotools/mask';

/**
 * One axis of torch's bilinear resize (align_corners=False, antialias=False):
 * for each output index, the two source taps and the weight of the second.
 */
function plainTaps(inSize: number, outSize: number): {i0: Int32Array; i1: Int32Array; w: Float32Array} {
  const scale = inSize / outSize;
  const i0 = new Int32Array(outSize);
  const i1 = new Int32Array(outSize);
  const w = new Float32Array(outSize);
  for (let o = 0; o < outSize; o++) {
    let src = (o + 0.5) * scale - 0.5;
    if (src < 0) {
      src = 0;
    }
    const a = Math.min(Math.floor(src), inSize - 1);
    i0[o] = a;
    i1[o] = Math.min(a + 1, inSize - 1);
    w[o] = src - a;
  }
  return {i0, i1, w};
}

/**
 * Resize a row-major `sw` x `sh` plane to `dw` x `dh` (torch bilinear,
 * align_corners=False, no antialias). Separable, rows first.
 */
export function resizeBilinear(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const x = plainTaps(sw, dw);
  const y = plainTaps(sh, dh);
  const tmp = new Float32Array(dw * sh);
  for (let r = 0; r < sh; r++) {
    const row = r * sw;
    const out = r * dw;
    for (let c = 0; c < dw; c++) {
      const a = src[row + x.i0[c]];
      tmp[out + c] = a + (src[row + x.i1[c]] - a) * x.w[c];
    }
  }
  const dst = new Float32Array(dw * dh);
  for (let r = 0; r < dh; r++) {
    const r0 = y.i0[r] * dw;
    const r1 = y.i1[r] * dw;
    const wy = y.w[r];
    const out = r * dw;
    for (let c = 0; c < dw; c++) {
      const a = tmp[r0 + c];
      dst[out + c] = a + (tmp[r1 + c] - a) * wy;
    }
  }
  return dst;
}

/** One axis of torch's antialiased bilinear resize (a triangle filter, widened when shrinking). */
function aaTaps(inSize: number, outSize: number): {start: Int32Array; size: Int32Array; weights: Float32Array[]} {
  const scale = inSize / outSize;
  const support = scale >= 1 ? scale : 1;
  const invScale = scale >= 1 ? 1 / scale : 1;
  const start = new Int32Array(outSize);
  const size = new Int32Array(outSize);
  const weights: Float32Array[] = [];
  for (let o = 0; o < outSize; o++) {
    const center = scale * (o + 0.5);
    const lo = Math.max(Math.trunc(center - support + 0.5), 0);
    const hi = Math.min(Math.trunc(center + support + 0.5), inSize);
    const ws = new Float32Array(Math.max(hi - lo, 0));
    let total = 0;
    for (let j = 0; j < ws.length; j++) {
      const t = Math.abs((j + lo - center + 0.5) * invScale);
      ws[j] = t < 1 ? 1 - t : 0;
      total += ws[j];
    }
    if (total > 0) {
      for (let j = 0; j < ws.length; j++) {
        ws[j] /= total;
      }
    }
    start[o] = lo;
    size[o] = ws.length;
    weights.push(ws);
  }
  return {start, size, weights};
}

/** torch bilinear with antialias=True (what add_new_mask uses to fit a mask to the model). */
export function resizeAntialias(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const x = aaTaps(sw, dw);
  const y = aaTaps(sh, dh);
  const tmp = new Float32Array(dw * sh);
  for (let r = 0; r < sh; r++) {
    const row = r * sw;
    for (let c = 0; c < dw; c++) {
      const ws = x.weights[c];
      const s = row + x.start[c];
      let v = 0;
      for (let j = 0; j < ws.length; j++) {
        v += src[s + j] * ws[j];
      }
      tmp[r * dw + c] = v;
    }
  }
  const dst = new Float32Array(dw * dh);
  for (let r = 0; r < dh; r++) {
    const ws = y.weights[r];
    const s = y.start[r];
    for (let c = 0; c < dw; c++) {
      let v = 0;
      for (let j = 0; j < ws.length; j++) {
        v += tmp[(s + j) * dw + c] * ws[j];
      }
      dst[r * dw + c] = v;
    }
  }
  return dst;
}

/**
 * SAM 2's fill_holes_in_mask_scores: background regions (logit <= 0),
 * 8-connected, of at most `maxArea` pixels become foreground (0.1). Returns a
 * new array; `maxArea` 0 returns the input unchanged.
 */
export function fillHoles(logits: Float32Array, w: number, h: number, maxArea: number): Float32Array {
  if (maxArea <= 0) {
    return logits;
  }
  const out = new Float32Array(logits);
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const region: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || logits[start] > 0) {
      continue;
    }
    region.length = 0;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const p = stack[--top];
      if (region.length <= maxArea) {
        region.push(p);
      }
      const px = p % w;
      const py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) {
          continue;
        }
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= w) {
            continue;
          }
          const q = ny * w + nx;
          if (!seen[q] && logits[q] <= 0) {
            seen[q] = 1;
            stack[top++] = q;
          }
        }
      }
    }
    if (region.length <= maxArea) {
      for (const p of region) {
        out[p] = 0.1;
      }
    }
  }
  return out;
}

/**
 * The decoder's low-res logits (row-major `lw` x `lh`) as the video-size mask
 * SAM 2 outputs: bilinear to `width` x `height`, then > 0, as COCO RLE.
 */
export function logitsToRle(logits: Float32Array, lw: number, lh: number, width: number, height: number): RLEObject {
  const full = resizeBilinear(logits, lw, lh, width, height);
  const data = new Uint8Array(width * height); // column-major, x * h + y
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (full[row + x] > 0) {
        data[x * height + y] = 1;
      }
    }
  }
  return encode(new DataArray(data, [height, width, 1]))[0];
}

/** A row-major 0/1 mask as COCO RLE. */
export function maskToRle(mask: Uint8Array, width: number, height: number): RLEObject {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[x * height + y] = mask[y * width + x] ? 1 : 0;
    }
  }
  return encode(new DataArray(data, [height, width, 1]))[0];
}

/** COCO RLE to a row-major 0/1 mask. */
export function rleToMask(rle: RLEObject): {mask: Uint8Array; width: number; height: number} {
  const [height, width] = rle.size;
  const data = decode([rle]).data as Uint8Array; // x * h + y
  const mask = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    const col = x * height;
    for (let y = 0; y < height; y++) {
      if (data[col + y]) {
        mask[y * width + x] = 1;
      }
    }
  }
  return {mask, width, height};
}

export function rleArea(rle: RLEObject): number {
  const data = decode([rle]).data as Uint8Array;
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    n += data[i] ? 1 : 0;
  }
  return n;
}

/** Intersection over union of two same-size masks; two empty masks count as 1. */
export function rleIou(a: RLEObject, b: RLEObject): number {
  if (a.size[0] !== b.size[0] || a.size[1] !== b.size[1]) {
    throw new Error(`mask sizes differ: ${a.size} vs ${b.size}`);
  }
  const da = decode([a]).data as Uint8Array;
  const db = decode([b]).data as Uint8Array;
  let inter = 0;
  let union = 0;
  for (let i = 0; i < da.length; i++) {
    const x = da[i] > 0;
    const y = db[i] > 0;
    inter += x && y ? 1 : 0;
    union += x || y ? 1 : 0;
  }
  return union === 0 ? 1 : inter / union;
}

/**
 * An approved mask as the memory encoder's high-res mask input, the way SAM 2
 * builds a mask seed's memory:
 *   - add_new_mask: resized to the model size with antialias, then >= 0.5;
 *   - _use_mask_as_output: scaled to +10 / -10 logits, and stored as the
 *     low-res mask (a quarter of the size, antialiased);
 *   - propagate_in_video_preflight: that low-res mask, bilinear back to the
 *     model size, is what the memory encoder binarises.
 * `appearing` is whether any pixel is set (SAM 2's object score: +10 or -10).
 */
export function maskInput(rle: RLEObject, size: number): {logits: Float32Array; appearing: boolean} {
  const {mask, width, height} = rleToMask(rle);
  const src = new Float32Array(width * height);
  for (let i = 0; i < src.length; i++) {
    src[i] = mask[i];
  }
  const fit = width === size && height === size ? src : resizeAntialias(src, width, height, size, size);
  const high = new Float32Array(size * size);
  let appearing = false;
  for (let i = 0; i < high.length; i++) {
    const on = fit[i] >= 0.5;
    high[i] = on ? 10 : -10;
    appearing ||= on;
  }
  const low = size / 4;
  const logits = resizeBilinear(resizeAntialias(high, size, size, low, low), low, low, size, size);
  return {logits, appearing};
}

/** Low-res logits (lowSize^2) at the model size, as SAM 2 upsamples a stored mask for its memory. */
export function upsampleLogits(lowRes: Float32Array, lowSize: number, size: number): Float32Array {
  return resizeBilinear(lowRes, lowSize, lowSize, size, size);
}

/**
 * SAM 2's multimask choice: the candidate with the highest predicted IoU.
 * Both exports make this choice in-graph (they return one mask); this is for
 * a decoder that returns several.
 */
export function selectMask(ious: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < ious.length; i++) {
    if (ious[i] > ious[best]) {
      best = i;
    }
  }
  return best;
}

/** RGBA pixels (`size` x `size`) to normalised CHW floats, as SAM 2 loads frames. */
export function preprocess(
  rgba: Uint8ClampedArray | Uint8Array,
  size: number,
  mean: readonly number[],
  std: readonly number[],
): Float32Array {
  const n = size * size;
  const out = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    const m = mean[c];
    const s = std[c];
    const plane = c * n;
    for (let i = 0; i < n; i++) {
      out[plane + i] = (rgba[i * 4 + c] / 255 - m) / s;
    }
  }
  return out;
}

/** [1, C, H, W] (channel-major) to [H*W, 1, C] (token-major), as flatten(2).permute(2, 0, 1). */
export function toTokens(chw: Float32Array, channels: number, hw: number): Float32Array {
  const out = new Float32Array(chw.length);
  for (let c = 0; c < channels; c++) {
    const plane = c * hw;
    for (let p = 0; p < hw; p++) {
      out[p * channels + c] = chw[plane + p];
    }
  }
  return out;
}
