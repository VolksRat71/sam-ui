// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// pts 1.0 caches the style it last wrote to each 2D context and skips writes
// it thinks are applied. The frame loop writes the context directly (the
// clear, save/restore), so every canvas-2D background effect must still get
// its own fill on the next frame, not the clear's transparent one.
// Then the history seam: the earlier frames a draw's effects name are fetched
// with every layer's mask on them before the draw and closed after it.
import {CanvasForm} from 'pts';
import {afterEach, describe, expect, it, vi} from 'vitest';
import VideoWorkerContext from './VideoWorkerContext';
import BackgroundTextEffect from './effects/BackgroundTextEffect';
import DesaturateEffect from './effects/DesaturateEffect';
import {Effect, EffectFrameContext} from './effects/Effect';
import EraseBackgroundEffect from './effects/EraseBackgroundEffect';
import OriginalEffect from './effects/OriginalEffect';
import type {Effects} from './effects/Effects';
import {normalizeParams, type EffectClip} from '~/state/effectClips';
import type MaskOverlayEffect from '~/worker/MaskOverlayEffect';
import ObjectHighlight from '~/worker/ObjectHighlight';

const W = 640;
const H = 360;

type Paint = {op: string; fillStyle: unknown};

/** A 2D context that keeps its state (with save/restore) and records each paint with the fill it used. */
function recordingContext() {
  const paints: Paint[] = [];
  const stack: Record<string, unknown>[] = [];
  let state: Record<string, unknown> = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
    filter: 'none',
  };
  const methods: Record<string, (...args: never[]) => unknown> = {
    save: () => stack.push({...state}),
    restore: () => {
      state = stack.pop() ?? state;
    },
    measureText: (s: string) => ({width: s.length * 10}),
  };
  const ctx = new Proxy(
    {},
    {
      get: (_t, k: string) =>
        methods[k] ??
        (k in state
          ? state[k]
          : () => {
              if (k === 'fill' || k === 'fillRect' || k === 'fillText') {
                paints.push({op: k, fillStyle: state.fillStyle});
              }
            }),
      set: (_t, k: string, v) => {
        state[k] = v;
        return true;
      },
    },
  );
  return {ctx: ctx as OffscreenCanvasRenderingContext2D, paints};
}

/** Draw one frame per effect the way _drawFrameImpl does (direct clear, then the effect loop); the last frame's paints. */
function drawFrames(...perFrame: Effect[]): Paint[] {
  const {ctx, paints} = recordingContext();
  const form = new CanvasForm(ctx);
  const self: {_effects: Effect[]; _stats: object} = {_effects: [], _stats: {}};
  const processEffects = VideoWorkerContext.prototype['_processEffects'];
  for (const [i, effect] of perFrame.entries()) {
    self._effects = [effect];
    form.ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    form.ctx.fillRect(0, 0, W, H);
    paints.length = 0;
    const context: EffectFrameContext = {
      frame: {} as ImageBitmap,
      masks: [],
      maskColors: [],
      frameIndex: 30 + i,
      totalFrames: 247,
      fps: 24,
      width: W,
      height: H,
      actionPoint: null,
    };
    processEffects.call(self as never, form, context, []);
  }
  return paints;
}

const twice = (e: Effect) => [e, e];

function withVariant<E extends Effect>(effect: E, variant: number): E {
  effect.variant = variant;
  return effect;
}

describe('canvas-2D background effects keep their fill on a redraw', () => {
  it('Text v1: the heading is drawn white', () => {
    const paints = drawFrames(...twice(withVariant(new BackgroundTextEffect(), 0)));
    expect(paints.filter(p => p.op === 'fillText').map(p => p.fillStyle)).toEqual(['#fff']);
  });

  it('Text v2: the band is #00000066 and the paragraph white', () => {
    const paints = drawFrames(...twice(withVariant(new BackgroundTextEffect(), 1)));
    expect(paints.find(p => p.op === 'fill')?.fillStyle).toBe('#00000066');
    const text = paints.filter(p => p.op === 'fillText');
    expect(text.length).toBeGreaterThan(0);
    expect(new Set(text.map(p => p.fillStyle))).toEqual(new Set(['#fff']));
  });

  it.each([
    [0, '#000'],
    [1, '#fff'],
    [2, '#0f0'],
  ])('Erase v%i: the background is filled %s', (variant, color) => {
    const paints = drawFrames(...twice(withVariant(new EraseBackgroundEffect(), variant)));
    expect(paints).toEqual([{op: 'fill', fillStyle: color}]);
  });

  it('Desaturate: the hue pass fills white, inside save/restore', () => {
    const paints = drawFrames(...twice(new DesaturateEffect()));
    expect(paints).toEqual([{op: 'fill', fillStyle: '#fff'}]);
  });

  it('Text v1 after Desaturate: its save/restore does not leave the heading transparent', () => {
    const paints = drawFrames(new DesaturateEffect(), withVariant(new BackgroundTextEffect(), 0));
    expect(paints.filter(p => p.op === 'fillText').map(p => p.fillStyle)).toEqual(['#fff']);
  });

  it('Original v3: the dim overlay fills #00000066', () => {
    const paints = drawFrames(...twice(withVariant(new OriginalEffect(), 2)));
    expect(paints).toEqual([{op: 'fill', fillStyle: '#00000066'}]);
  });
});

describe("studio's effect clips: ObjectHighlight draws several in one slot", () => {
  it('Text v1 over an overlapping Desaturate clip: the heading is drawn white', async () => {
    const meta = {Desaturate: new DesaturateEffect(), BackgroundText: new BackgroundTextEffect()} as unknown as Effects;
    const h = new ObjectHighlight({} as MaskOverlayEffect, meta, () => ({width: W, height: H}));
    const clip = (effect: string, row: number, params = {}): EffectClip => ({
      id: effect,
      target: {kind: 'background'},
      effect,
      params: normalizeParams(effect, params),
      start: 0,
      end: 100,
      row,
      phase: 0,
    });
    await h.setDoc({version: 2, clips: [clip('Desaturate', 0), clip('BackgroundText', 1, {style: 'Zooming words'})]}, []);
    const paints = drawFrames(...twice(h));
    expect(paints.filter(p => p.op === 'fillText').map(p => p.fillStyle)).toEqual(['#fff']);
  });
});

describe('earlier frames for effects that draw from them (historyFrames)', () => {
  type Opened = {index: number; closed: boolean};
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A context with a fake frame store (failing to decode frame `broken`) and two layers (1 on every even frame, 2 on frames below 15), drawing with `effect`. */
  function worker(effect: Effect, history: (form: CanvasForm, i: number) => number[], broken = -1) {
    const frames: Opened[] = [];
    const bitmaps: Opened[] = [];
    vi.stubGlobal('createImageBitmap', async (f: {index: number}) => {
      const b = {index: f.index, closed: false, width: W, height: H, close: () => (b.closed = true)};
      bitmaps.push(b);
      return b;
    });
    const store = {
      frame: async (index: number) => {
        if (index === broken) {
          throw new Error('decode failed');
        }
        const f = {index, closed: false, close: () => (f.closed = true)};
        frames.push(f);
        return f;
      },
    };
    const mask = (i: number) => ({data: {counts: `m${i}`, size: [H, W]}, bounds: [[0, 0], [1, 1]], shape: [H, W], isEmpty: false});
    const tracklets = [
      {id: 1, color: '#f00', masks: Array.from({length: 30}, (_, i) => (i % 2 === 0 ? mask(i) : undefined))},
      {id: 2, color: '#00f', masks: Array.from({length: 30}, (_, i) => (i < 15 ? mask(100 + i) : undefined))},
    ];
    const ctx = Object.assign(Object.create(VideoWorkerContext.prototype), {
      _store: store,
      _decodedVideo: {width: W, height: H, numFrames: 30, fps: 24, frames: []},
      _tracklets: tracklets,
      _effects: [effect],
      _stats: {},
      _allowAnimation: false,
      _currentSegmetationPoint: null,
      _sendRenderingError: () => {},
      historyFrames: history,
    }) as VideoWorkerContext;
    const form = new CanvasForm(recordingContext().ctx);
    const draw = (i: number) => (ctx as unknown as {_drawFrameImpl(f: CanvasForm, i: number): Promise<boolean>})._drawFrameImpl(form, i);
    return {frames, bitmaps, form, draw};
  }

  /** An effect that records the history each draw gets: frame index, the bitmap's frame, and the masks by layer. */
  function recorder(seen: unknown[], fail = false): Effect {
    return {
      apply: (_f: CanvasForm, c: EffectFrameContext) => {
        seen.push([...(c.history ?? new Map()).entries()].map(([i, h]) => [i, (h.frame as unknown as Opened).index, Object.fromEntries([...h.masks].map(([id, m]) => [id, (m.bitmap as {counts: string}).counts]))]));
        if (fail) {
          throw new Error('effect failed');
        }
      },
    } as unknown as Effect;
  }

  it("fetches the frames named for the draw, nearest first, each with every layer's mask on it; skips the frame itself, repeats and frames off the video", async () => {
    const seen: unknown[] = [];
    const asked: Array<[CanvasForm, number]> = [];
    const {frames, bitmaps, form, draw} = worker(recorder(seen), (f, i) => (asked.push([f, i]), [i - 2, i - 3, i, i - 2, -1, 99]));
    expect(await draw(16)).toBe(true);
    expect(asked).toEqual([[form, 16]]);
    expect(seen).toEqual([
      [
        [14, 14, {1: 'm14', 2: 'm114'}],
        [13, 13, {2: 'm113'}],
      ],
    ]);
    expect(frames.map(f => f.index)).toEqual([16, 14, 13]);
    // every frame and bitmap closed once the draw is over (the current frame's as before)
    expect(frames.every(f => f.closed)).toBe(true);
    expect(bitmaps.every(b => b.closed)).toBe(true);
  });

  it('closes the fetched frames when the draw fails', async () => {
    const {frames, bitmaps, draw} = worker(recorder([], true), (_f, i) => [i - 1, i - 2]);
    expect(await draw(10)).toBe(false);
    expect(frames.map(f => f.index)).toEqual([10, 9, 8]);
    // the history's and the current frame's bitmap
    expect(frames.every(f => f.closed) && bitmaps.every(b => b.closed)).toBe(true);
  });

  it('leaves out a history frame that fails to decode and still draws (and an export goes on)', async () => {
    const seen: unknown[] = [];
    const {frames, bitmaps, draw} = worker(recorder(seen), (_f, i) => [i - 2, i - 4, i - 6], 14);
    expect(await draw(18)).toBe(true);
    expect(seen).toEqual([
      [
        [16, 16, {1: 'm16'}],
        [12, 12, {1: 'm12', 2: 'm112'}],
      ],
    ]);
    expect(frames.every(f => f.closed) && bitmaps.every(b => b.closed)).toBe(true);
  });

  it('gives a frame the same history however it is reached (after a far frame, or again)', async () => {
    const seen: unknown[] = [];
    const {draw} = worker(recorder(seen), (_f, i) => [i - 4, i - 8]);
    await draw(20);
    await draw(28);
    await draw(2);
    await draw(20);
    expect(seen[3]).toEqual(seen[0]);
    expect(seen[2]).toEqual([]); // frames before the video's start are never fetched
  });

  it('fetches nothing when no effect names a frame', async () => {
    const seen: unknown[] = [];
    const {frames, draw} = worker(recorder(seen), () => []);
    await draw(5);
    expect(frames.map(f => f.index)).toEqual([5]);
    expect(seen).toEqual([[]]);
  });
});
