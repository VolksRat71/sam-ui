// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// pts 1.0 caches the style it last wrote to each 2D context and skips writes
// it thinks are applied. The frame loop writes the context directly (the
// clear, save/restore), so every canvas-2D background effect must still get
// its own fill on the next frame, not the clear's transparent one.
import {CanvasForm} from 'pts';
import {describe, expect, it} from 'vitest';
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
