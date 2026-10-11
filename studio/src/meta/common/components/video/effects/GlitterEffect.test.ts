// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Glitter: each particle a pure function of (seed, index, clip time), its
// spawn point sampled from the frame's mask relative to the mask's box, and
// the whole draw on a recording 2D context: the same inputs draw the same
// sprites, a moved mask moves them, more density draws more.
import {DataArray, encode} from '@/jscocotools/mask';
import type {CanvasForm} from 'pts';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {normalizeParams} from '~/state/effectClips';
import {clipSeed, type EffectFrameContext, type EffectMask, type EffectParams} from './Effect';
import {EFFECT_SPECS} from './EffectParamSpecs';
import GlitterEffect, {type MaskLines, type Particle, maskLines, newParticle, particleAt, rand, spawnPoint} from './GlitterEffect';
import {unionMasks} from './SubjectsBackgroundGLEffect';

const W = 64;
const H = 48;

/** A mask of the pixels `inside(x, y)`, column-major as SAM's RLE, with its tight box. */
function maskOf(inside: (x: number, y: number) => boolean): EffectMask {
  const data = new Uint8Array(W * H);
  let [x0, y0, x1, y1] = [W, H, 0, 0];
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++)
      if (inside(x, y)) {
        data[x * H + y] = 1;
        [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + 1), Math.max(y1, y + 1)];
      }
  return {bitmap: encode(new DataArray(data, [H, W, 1]))[0], bounds: [[x0, y0], [x1, y1]]};
}
const rect = (x0: number, y0: number, x1: number, y1: number) => maskOf((x, y) => x >= x0 && x < x1 && y >= y0 && y < y1);

/** The mask decoded, its per-line counts, and its box as [x0, y0, x1, y1]. */
function prepared(mask: EffectMask): {m: Uint8Array; lines: MaskLines; box: Int32Array} {
  const m = new Uint8Array(W * H);
  unionMasks([mask], m);
  const lines = {colIn: new Int32Array(W), colEdge: new Int32Array(W), rowIn: new Int32Array(H), rowEdge: new Int32Array(H)};
  const box = Int32Array.from(mask.bounds.flat());
  maskLines(m, H, box, lines);
  return {m, lines, box};
}

describe('rand', () => {
  it('is a fraction in [0, 1), the same for the same numbers, different for neighbours', () => {
    const xs = Array.from({length: 1000}, (_, i) => rand(7, i, 3));
    expect(xs.every(x => x >= 0 && x < 1)).toBe(true);
    expect(rand(7, 5, 3)).toBe(rand(7, 5, 3));
    expect(new Set(xs).size).toBe(1000);
    expect(rand(8, 5, 3)).not.toBe(rand(7, 5, 3));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });
});

describe('particleAt', () => {
  const at = (seed: number, slot: number, t: number): Particle | null => {
    const q = newParticle();
    return particleAt(q, seed, slot, t, 1) ? q : null;
  };

  it('is a pure function of (seed, index, time): the same particle however it is reached', () => {
    for (const t of [0.4, 1.7, 9.25]) {
      for (let slot = 0; slot < 50; slot++) {
        expect(at(42, slot, t)).toEqual(at(42, slot, t));
      }
    }
  });

  it('is alive only between its spawn and the end of its life, never spawned before the clip starts', () => {
    expect(Array.from({length: 200}, (_, i) => at(1, i, 0)).filter(q => q != null)).toEqual([]);
    for (let slot = 0; slot < 200; slot++) {
      const q = at(1, slot, 0.6);
      if (q != null) {
        expect(q.age).toBeGreaterThanOrEqual(0);
        expect(q.age).toBeLessThan(1);
        expect(q.spawn).toBeGreaterThanOrEqual(0);
        expect(q.spawn).toBeLessThanOrEqual(0.6);
      }
    }
  });

  it('ages on the clock: a small step ages it, the same spawn and spawn point', () => {
    const [a, b] = [at(3, 11, 5), at(3, 11, 5.05)];
    if (a != null && b != null && b.age > a.age) {
      expect(b.spawn).toBeCloseTo(a.spawn, 10);
      expect([b.u, b.v, b.angle]).toEqual([a.u, a.v, a.angle]);
    }
    // over many slots, some step on and none jump back to an older spawn
    const pairs = Array.from({length: 100}, (_, i) => [at(3, i, 5), at(3, i, 5.05)]).filter(([x, y]) => x != null && y != null);
    expect(pairs.length).toBeGreaterThan(40);
    expect(pairs.every(([x, y]) => y!.spawn >= x!.spawn - 1e-9)).toBe(true);
  });

  it('a different seed is a different particle', () => {
    const live = (seed: number) => Array.from({length: 100}, (_, i) => at(seed, i, 4)).map(q => q?.u ?? -1);
    expect(live(clipSeed('c1'))).not.toEqual(live(clipSeed('c2')));
  });

  it('density scales the particles alive: twice the slots, about twice as many', () => {
    const alive = (n: number, t: number) => Array.from({length: n}, (_, i) => at(9, i, t)).filter(q => q != null).length;
    for (const t of [3, 7.5]) {
      const [a, b] = [alive(200, t), alive(400, t)];
      expect(a).toBeGreaterThan(200 * 0.6);
      expect(b / a).toBeGreaterThan(1.8);
      expect(b / a).toBeLessThan(2.2);
    }
  });
});

describe('spawnPoint', () => {
  const point = (mask: EffectMask, u: number, v: number, edge: boolean, byRow: boolean): [number, number] | null => {
    const {m, lines, box} = prepared(mask);
    const out = new Float64Array(2);
    return spawnPoint(out, m, H, box, lines, u, v, edge, byRow) ? [out[0], out[1]] : null;
  };
  const inMask = (mask: EffectMask, [x, y]: [number, number]) => prepared(mask).m[Math.floor(x) * H + Math.floor(y)] > 0;

  it('inside: a point of the mask, at (u, v) of its box', () => {
    const mask = rect(10, 8, 30, 40);
    expect(point(mask, 0, 0, false, false)).toEqual([10.5, 8.5]);
    expect(point(mask, 0.5, 0.5, false, false)).toEqual([20.5, 24.5]);
    expect(point(mask, 0.5, 0.5, false, true)).toEqual([20.5, 24.5]);
    for (let i = 0; i < 100; i++) {
      expect(inMask(mask, point(mask, rand(1, i, 0), rand(1, i, 1), false, i % 2 === 0)!)).toBe(true);
    }
  });

  it('edge: a point on the mask whose neighbour across the line is outside', () => {
    const disc = maskOf((x, y) => (x - 30) ** 2 + (y - 24) ** 2 < 15 ** 2);
    const {m} = prepared(disc);
    const out = (x: number, y: number) => x < 0 || y < 0 || x >= W || y >= H || m[x * H + y] === 0;
    for (let i = 0; i < 200; i++) {
      const byRow = i % 2 === 0;
      const [x, y] = point(disc, rand(2, i, 0), rand(2, i, 1), true, byRow)!.map(Math.floor);
      expect(m[x * H + y]).toBeGreaterThan(0);
      expect(byRow ? out(x - 1, y) || out(x + 1, y) : out(x, y - 1) || out(x, y + 1)).toBe(true);
    }
    // a column's edge points are its top and bottom
    expect(point(rect(10, 8, 30, 40), 0.5, 0, true, false)).toEqual([20.5, 8.5]);
    expect(point(rect(10, 8, 30, 40), 0.5, 0.99, true, false)).toEqual([20.5, 39.5]);
  });

  it('a box spanning a gap (two blobs) samples the nearest line with mask on it', () => {
    const two = maskOf((x, y) => y >= 10 && y < 20 && ((x >= 2 && x < 8) || (x >= 50 && x < 60)));
    for (let i = 0; i < 100; i++) {
      const p = point(two, rand(3, i, 0), rand(3, i, 1), i % 3 === 0, false)!;
      expect(inMask(two, p)).toBe(true);
    }
    expect(point(two, 0.2, 0.5, false, false)![0]).toBeLessThan(8); // nearer the left blob
  });

  it('is relative to the mask box: a moved mask moves the point by as much', () => {
    const shape = (dx: number, dy: number) => maskOf((x, y) => (x - 20 - dx) ** 2 / 100 + (y - 20 - dy) ** 2 / 64 < 1);
    for (let i = 0; i < 50; i++) {
      const [u, v, edge, byRow] = [rand(4, i, 0), rand(4, i, 1), i % 2 === 0, i % 3 === 0];
      const [a, b] = [point(shape(0, 0), u, v, edge, byRow)!, point(shape(17, 9), u, v, edge, byRow)!];
      expect([b[0] - a[0], b[1] - a[1]]).toEqual([17, 9]);
    }
  });
});

describe('GlitterEffect', () => {
  type Draw = [number, number, number, number, number];
  let draws: Draw[];
  let alpha: number;
  beforeEach(() => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return new Proxy({}, {get: () => () => ({addColorStop() {}})});
        }
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const form = (): CanvasForm => {
    draws = [];
    alpha = 1;
    const ctx = {
      save() {},
      restore() {},
      set globalAlpha(a: number) {
        alpha = a;
      },
      get globalAlpha() {
        return alpha;
      },
      drawImage(_s: unknown, x: number, y: number, w: number, h: number) {
        draws.push([x, y, w, h, alpha]);
      },
    };
    return {ctx} as unknown as CanvasForm;
  };
  const draw = (params: EffectParams, over: Partial<EffectFrameContext> = {}, masks = [rect(10, 8, 30, 40)]) => {
    const effect = new GlitterEffect();
    effect.setParams(normalizeParams('Glitter', params));
    const context = {frameIndex: 0, totalFrames: 100, fps: 24, width: W, height: H, masks, maskColors: masks.map(() => '#ff0000'), time: 2, seed: clipSeed('c1'), ...over};
    effect.apply(form(), context as EffectFrameContext, []);
    return draws;
  };

  it('draws the same sprites for the same frame and settings, others for the next frame', () => {
    for (const style of ['Glitter', 'Sparkle', 'Dust']) {
      const a = draw({style});
      expect(a.length).toBeGreaterThan(5);
      expect(draw({style})).toEqual(a);
      expect(draw({style}, {time: 2 + 1 / 24})).not.toEqual(a);
      expect(draw({style}, {seed: clipSeed('c2')})).not.toEqual(a);
    }
  });

  it('follows the subject: the mask moved, every sprite moved by as much', () => {
    const a = draw({}, {}, [rect(10, 8, 30, 40)]);
    const b = draw({}, {}, [rect(25, 4, 45, 36)]);
    expect(b.length).toBe(a.length);
    b.forEach((d, i) => {
      expect(d[0] - a[i][0]).toBeCloseTo(15, 6);
      expect(d[1] - a[i][1]).toBeCloseTo(-4, 6);
    });
  });

  it('no mask on the frame: nothing drawn', () => {
    expect(draw({}, {}, [])).toEqual([]);
  });

  it('density sets how many it draws', () => {
    const n = (density: number) => draw({density}, {time: 5}).length;
    expect(n(400) / n(100)).toBeGreaterThan(3.2);
    expect(n(400) / n(100)).toBeLessThan(4.8);
  });

  it('spread 0 keeps every particle on the mask; Edge keeps it on the edge', () => {
    const at = (d: Draw) => [d[0] + d[2] / 2, d[1] + d[3] / 2];
    for (const [x, y] of draw({spread: 0, area: 'Inside'}).map(at)) {
      expect(x >= 10 && x <= 30 && y >= 8 && y <= 40).toBe(true);
    }
    for (const [x, y] of draw({spread: 0, area: 'Edge'}).map(at)) {
      expect(Math.min(Math.abs(x - 10.5), Math.abs(x - 29.5), Math.abs(y - 8.5), Math.abs(y - 39.5))).toBeLessThan(1e-6);
    }
  });

  it('size is its diameter as a share of the frame height, every alpha in range', () => {
    const d = draw({style: 'Glitter', size: 0.05});
    expect(Math.max(...d.map(x => x[2]))).toBeLessThanOrEqual(0.05 * H * 1.5 + 1e-9);
    expect(d.every(x => x[4] > 0 && x[4] <= 1)).toBe(true);
  });
});

describe('Glitter settings', () => {
  it('start as the Glitter style, the layer colour', () => {
    const p = normalizeParams('Glitter', {});
    expect(p).toEqual({...EFFECT_SPECS.Glitter.styles.Glitter, colours: 'One colour', color: 'layer'});
  });

  it("are a seeded effect's: each clip's particles its own", () => {
    expect(Object.keys(EFFECT_SPECS).filter(n => EFFECT_SPECS[n].seeded)).toEqual(['Glitter']);
    expect(clipSeed('c1')).not.toBe(clipSeed('c2'));
    expect(clipSeed('c1')).toBe(clipSeed('c1'));
    expect(Number.isInteger(clipSeed('v1-3')) && clipSeed('v1-3') >= 0).toBe(true);
  });
});
