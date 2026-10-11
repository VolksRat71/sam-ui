// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {maskToRle} from '~/local/sam2/masks';
import type {CanvasForm} from 'pts';
import ArrowGLEffect from './ArrowGLEffect';
import type BaseGLEffect from './BaseGLEffect';
import type {EffectFrameContext} from './Effect';
import NoisyMaskEffect from './NoisyMaskEffect';

/**
 * Just enough WebGL2 to see texture lifetimes: which texture each unit has
 * bound at every draw, and how many were ever created. Deleting a texture
 * unbinds it, as in WebGL.
 */
function fakeGL() {
  type Tex = {deleted: boolean};
  const units = new Map<number, Tex | null>();
  let unit = 0;
  const gl = {
    created: 0,
    draws: [] as Map<number, Tex | null>[],
    TEXTURE0: 1000,
    createTexture: () => (gl.created++, {deleted: false}),
    deleteTexture: (t: Tex) => {
      t.deleted = true;
      units.forEach((bound, u) => bound === t && units.set(u, null));
    },
    activeTexture: (u: number) => (unit = u - gl.TEXTURE0),
    bindTexture: (_target: number, t: Tex | null) => units.set(unit, t),
    drawArrays: () => gl.draws.push(new Map(units)),
    getProgramParameter: () => true,
  };
  return new Proxy(gl, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : () => ({})),
  });
}

const W = 4;
const H = 4;
const frame = (masks: number) =>
  ({
    width: W,
    height: H,
    frameIndex: 0,
    frame: {width: W, height: H},
    masks: Array.from({length: masks}, () => ({bitmap: maskToRle(new Uint8Array(W * H).fill(1), W, H), bounds: [[0, 0], [W, H]]})),
    maskColors: [],
  }) as unknown as EffectFrameContext;
const form = {ctx: {drawImage: () => {}}} as unknown as CanvasForm;

describe.each([
  ['NoisyMask', () => new NoisyMaskEffect(), 0],
  ['Arrow', () => new ArrowGLEffect(), 1],
])('%s mask textures', (_name, make: () => BaseGLEffect, firstUnit: number) => {
  it('keeps every mask bound for the last draw, which shows all of them, and reuses the textures', async () => {
    const gl = fakeGL();
    const effect = make();
    await effect.setup({width: W, height: H, canvas: {} as OffscreenCanvas, gl: gl as unknown as WebGL2RenderingContext});
    const created = gl.created;
    effect.apply(form, frame(3), []);
    effect.apply(form, frame(3), []);
    const last = gl.draws[gl.draws.length - 1];
    for (let i = 0; i < 3; i++) {
      expect(last.get(firstUnit + i)?.deleted).toBe(false);
    }
    expect(gl.created).toBe(created); // nothing allocated per frame
  });
});
