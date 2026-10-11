// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Outline's settings and what it pushes to the GPU, against a fake WebGL2
// context that records calls (no GPU in vitest). The pixels are checked in
// the browser harness (see the PR).
import {DataArray, encode} from '@/jscocotools/mask';
import type {CanvasForm} from 'pts';
import {describe, expect, it, vi} from 'vitest';
import type {EffectFrameContext} from './Effect';
import OutlineGLEffect, {outlineRgb, resolveOutlineParams} from './OutlineGLEffect';

describe('resolveOutlineParams', () => {
  it('defaults every missing param', () => {
    expect(resolveOutlineParams({})).toEqual({width: 0.006, color: 'layer', opacity: 1, softness: 0.25, glow: false});
  });

  it('clamps numbers to range and ignores wrong types', () => {
    expect(resolveOutlineParams({width: 1, opacity: -2, softness: 3})).toMatchObject({width: 0.05, opacity: 0, softness: 1});
    expect(resolveOutlineParams({width: 0})).toMatchObject({width: 0.002});
    expect(resolveOutlineParams({width: '0.02', opacity: NaN, softness: true})).toMatchObject({width: 0.006, opacity: 1, softness: 0.25});
  });

  it("takes '#rrggbb' or 'layer' as the colour, anything else follows the layer", () => {
    expect(resolveOutlineParams({color: '#FFaa00'}).color).toBe('#FFaa00');
    expect(resolveOutlineParams({color: 'layer'}).color).toBe('layer');
    expect(resolveOutlineParams({color: 'red'}).color).toBe('layer');
    expect(resolveOutlineParams({color: '#fff'}).color).toBe('layer');
  });

  it("is Glow only for style 'Glow'", () => {
    expect(resolveOutlineParams({style: 'Glow'}).glow).toBe(true);
    expect(resolveOutlineParams({style: 'Outline'}).glow).toBe(false);
    expect(resolveOutlineParams({style: 'glow'}).glow).toBe(false);
  });
});

describe('outlineRgb', () => {
  it('follows the layer colour for layer, else the given colour', () => {
    expect(outlineRgb('layer', '#ff0000')).toEqual([1, 0, 0]);
    expect(outlineRgb('#00ff00', '#ff0000')).toEqual([0, 1, 0]);
  });
});

type Call = [string, unknown[]];

/** A WebGL2 context that records every call; constants are their own names, uniform locations their names. */
function fakeGL() {
  const calls: Call[] = [];
  let ids = 0;
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_, key) {
      if (typeof key !== 'string') {
        return undefined;
      }
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
        return key === 'TEXTURE0' ? 1000 : key;
      }
      return (...args: unknown[]) => {
        calls.push([key, args]);
        if (key === 'getUniformLocation') {
          return args[1];
        }
        if (key === 'getProgramParameter') {
          return true;
        }
        return key.startsWith('create') ? {id: ++ids, kind: key} : null;
      };
    },
  });
  return {gl: gl as unknown as WebGL2RenderingContext, calls};
}

function mask(w: number, h: number) {
  const data = new Uint8Array(w * h);
  for (let x = 4; x < 12; x++) for (let y = 4; y < 12; y++) data[x * h + y] = 1;
  return {bitmap: encode(new DataArray(data, [h, w, 1]))[0], bounds: [[4, 4], [12, 12]] as [[number, number], [number, number]]};
}

async function setUp() {
  const {gl, calls} = fakeGL();
  const effect = new OutlineGLEffect();
  await effect.setup({width: 32, height: 20, gl, canvas: {} as OffscreenCanvas});
  const drawImage = vi.fn();
  const form = {ctx: {drawImage}} as unknown as CanvasForm;
  const context = (n: number): EffectFrameContext => ({
    frameIndex: 0,
    totalFrames: 1,
    fps: 30,
    width: 32,
    height: 20,
    masks: Array.from({length: n}, () => mask(32, 20)),
    maskColors: ['#ff0000', '#0000ff', '#00ff00'].slice(0, n),
    frame: {} as ImageBitmap,
    actionPoint: null,
  });
  /** The last value given to each uniform since `from`. */
  const uniforms = (from: number) => {
    const out = new Map<string, unknown>();
    for (const [name, args] of calls.slice(from)) {
      if (name.startsWith('uniform')) {
        out.set(args[0] as string, args.length === 2 ? args[1] : args.slice(1));
      }
    }
    return out;
  };
  return {effect, calls, form, drawImage, context, uniforms};
}

describe('OutlineGLEffect', () => {
  it('pushes every setting from params on each apply', async () => {
    const {effect, calls, form, drawImage, context, uniforms} = await setUp();
    effect.setParams({width: 0.05, color: 'layer', opacity: 0.5, softness: 0.8, style: 'Glow'});
    let from = calls.length;
    effect.apply(form, context(2), []);
    let u = uniforms(from);
    expect(u.get('uWidth')).toBe(1); // 0.05 x 20 px
    expect(u.get('uRadius')).toBe(2);
    expect(u.get('uGlow')).toBe(1);
    expect(u.get('uOpacity')).toBe(0.5);
    expect(u.get('uSoftness')).toBe(0.8);
    expect(u.get('uNumMasks')).toBe(2);
    expect(u.get('uColor0')).toEqual([1, 0, 0]);
    expect(u.get('uColor1')).toEqual([0, 0, 1]);
    expect(drawImage).toHaveBeenCalledTimes(1);

    // the next object's params replace these entirely: nothing carries over
    effect.setParams({color: '#00ff00'});
    from = calls.length;
    effect.apply(form, context(1), []);
    u = uniforms(from);
    expect(u.get('uWidth')).toBeCloseTo(0.12);
    expect(u.get('uGlow')).toBe(0);
    expect(u.get('uOpacity')).toBe(1);
    expect(u.get('uNumMasks')).toBe(1);
    expect(u.get('uColor0')).toEqual([0, 1, 0]);
  });

  it('makes no GL resources per frame, and frees them on cleanup', async () => {
    const {effect, calls, form, context} = await setUp();
    const created = () => calls.filter(([name]) => name.startsWith('create')).length;
    const before = created();
    for (let i = 0; i < 5; i++) {
      effect.apply(form, context(3), []);
    }
    expect(created()).toBe(before);
    await effect.cleanup();
    const deleted = calls.filter(([name]) => /^delete(Texture|Framebuffer)$/.test(name)).length;
    expect(deleted).toBe(1 + 3 + 2 + 2); // frame texture, masks, targets, framebuffers
  });

  it('draws nothing with no masks', async () => {
    const {effect, form, drawImage, context} = await setUp();
    effect.apply(form, context(0), []);
    expect(drawImage).not.toHaveBeenCalled();
  });
});
