// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {
  fillHoles,
  logitsToRle,
  maskInput,
  maskToRle,
  preprocess,
  resizeAntialias,
  resizeBilinear,
  rleArea,
  rleIou,
  rleToMask,
  selectMask,
  toTokens,
} from './masks';

// torch.arange(20).reshape(1,1,4,5) ** 1.5 / 7, and F.interpolate of it
// (bilinear, align_corners=False), computed with torch 2.x.
const SRC = Float32Array.from({length: 20}, (_, i) => i ** 1.5 / 7);
const TORCH = {
  up: [0.0, 0.04762, 0.12698, 0.25895, 0.40406, 0.59198, 0.78681, 1.00934, 1.14286, 0.57043, 0.66084, 0.81154, 1.00301, 1.20466, 1.44188, 1.68506, 1.95205, 2.11224, 1.48311, 1.642, 1.90683, 2.1935, 2.48563, 2.80173, 3.12225, 3.46038, 3.66327, 3.05737, 3.25681, 3.58922, 3.93855, 4.29211, 4.66552, 5.0427, 5.43491, 5.67023, 4.78766, 5.02265, 5.4143, 5.82013, 6.22952, 6.6559, 7.08554, 7.52826, 7.79389, 6.94864, 7.21207, 7.65111, 8.10295, 8.55797, 9.02842, 9.50186, 9.98723, 10.27845, 8.29925, 8.58045, 9.04912, 9.5297, 10.01326, 10.51125, 11.01205, 11.52408, 11.8313],
  down: [0.41828, 1.26681, 3.50612, 5.14075, 8.28301, 10.43219],
  aaDown: [0.76341, 1.50986, 3.66944, 4.97664, 7.97385, 9.65527],
};

const close = (a: ArrayLike<number>, b: number[]) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < b.length; i++) {
    expect(a[i]).toBeCloseTo(b[i], 4);
  }
};

describe('resize', () => {
  it('matches torch bilinear (align_corners=False) up and down', () => {
    close(resizeBilinear(SRC, 5, 4, 9, 7), TORCH.up);
    close(resizeBilinear(SRC, 5, 4, 2, 3), TORCH.down);
  });

  it('matches torch antialiased bilinear', () => {
    close(resizeAntialias(SRC, 5, 4, 9, 7), TORCH.up); // same as plain when enlarging
    close(resizeAntialias(SRC, 5, 4, 2, 3), TORCH.aaDown);
  });
});

describe('RLE', () => {
  it('encodes column-major, as pycocotools does', () => {
    const m = new Uint8Array(6 * 8);
    for (let y = 1; y < 4; y++) for (let x = 2; x < 7; x++) m[y * 8 + x] = 1;
    m[5 * 8 + 0] = 1;
    // tracks.rle.encode of the same mask
    expect(maskToRle(m, 8, 6)).toEqual({size: [6, 8], counts: '5172L00000005'});
  });

  it('round-trips a mask', () => {
    const w = 13;
    const h = 7;
    const m = Uint8Array.from({length: w * h}, (_, i) => ((i * 7919) % 5 === 0 ? 1 : 0));
    const back = rleToMask(maskToRle(m, w, h));
    expect(back.width).toBe(w);
    expect(back.height).toBe(h);
    expect([...back.mask]).toEqual([...m]);
    expect(rleArea(maskToRle(m, w, h))).toBe(m.reduce((a, b) => a + b, 0));
  });

  it('thresholds resized logits at 0', () => {
    // a 4x4 logit map with the right half positive, to 8x6
    const logits = Float32Array.from({length: 16}, (_, i) => (i % 4 >= 2 ? 5 : -5));
    const {mask} = rleToMask(logitsToRle(logits, 4, 4, 8, 6));
    for (let y = 0; y < 6; y++) {
      expect([...mask.slice(y * 8, y * 8 + 8)]).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    }
  });

  it('computes IoU', () => {
    const a = new Uint8Array(16);
    const b = new Uint8Array(16);
    a.fill(1, 0, 8);
    b.fill(1, 4, 12);
    expect(rleIou(maskToRle(a, 4, 4), maskToRle(b, 4, 4))).toBeCloseTo(4 / 12);
    expect(rleIou(maskToRle(new Uint8Array(16), 4, 4), maskToRle(new Uint8Array(16), 4, 4))).toBe(1);
  });
});

describe('fillHoles', () => {
  it('fills background components up to the area, 8-connected, and nothing larger', () => {
    const w = 7;
    const h = 7;
    const logits = new Float32Array(w * h).fill(1);
    logits[1 * w + 1] = -1; // a one-pixel hole
    logits[4 * w + 4] = -1; // a diagonal pair: one 8-connected component of 2
    logits[5 * w + 5] = -1;
    for (let x = 0; x < w; x++) logits[6 * w + x] = -1; // a 7-pixel strip, touching the pair
    const out = fillHoles(logits, w, h, 2);
    expect(out[1 * w + 1]).toBeCloseTo(0.1);
    // the pair touches the strip diagonally (5,5)-(6,6), so it is part of a 9-pixel region
    expect(out[4 * w + 4]).toBe(-1);
    expect(out[6 * w + 0]).toBe(-1);
    expect(fillHoles(logits, w, h, 9)[6 * w + 3]).toBeCloseTo(0.1);
    expect(fillHoles(logits, w, h, 0)).toBe(logits);
  });
});

describe('maskInput', () => {
  it('turns an approved mask into +/-10 logits at the model size', () => {
    const m = new Uint8Array(8 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) m[y * 8 + x] = 1; // left half
    const {logits, appearing} = maskInput(maskToRle(m, 8, 4), 16);
    expect(appearing).toBe(true);
    expect(logits[0]).toBe(10);
    expect(logits[15]).toBe(-10);
    expect(logits[16 * 15 + 3]).toBe(10);
    expect(maskInput(maskToRle(new Uint8Array(32), 8, 4), 16).appearing).toBe(false);
  });
});

describe('small helpers', () => {
  it('selects the highest-IoU candidate', () => {
    expect(selectMask([0.2, 0.9, 0.5])).toBe(1);
    expect(selectMask([0.7])).toBe(0);
  });

  it('normalises RGBA to CHW', () => {
    const rgba = new Uint8Array([255, 0, 51, 255, 0, 255, 102, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const out = preprocess(rgba, 2, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    expect(out.length).toBe(12);
    expect(out[0]).toBeCloseTo(1); // R of pixel 0
    expect(out[4 + 1]).toBeCloseTo(1); // G of pixel 1
    expect(out[8 + 0]).toBeCloseTo(-0.6); // B of pixel 0: 51/255 = 0.2
  });

  it('transposes CHW to token-major', () => {
    const chw = Float32Array.from([0, 1, 2, 10, 11, 12]); // C=2, HW=3
    expect([...toTokens(chw, 2, 3)]).toEqual([0, 10, 1, 11, 2, 12]);
  });
});
