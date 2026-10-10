// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Test support for GL effects: a WebGL2 context that records calls (no GPU
// in vitest) and an effect set up on it with frame contexts to apply.
import {DataArray, encode} from '@/jscocotools/mask';
import type {CanvasForm} from 'pts';
import {vi} from 'vitest';
import type {Effect, EffectFrameContext} from './Effect';

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

/** `effect` set up on a recording context, 32 x 20 px; context(n) has n masks. */
export async function setUpGL<E extends Effect>(effect: E) {
  const {gl, calls} = fakeGL();
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
