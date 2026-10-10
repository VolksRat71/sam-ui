// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// ObjectHighlight with fake effects: per-clip settings never leak between
// passes (U3), draw order, untouched objects in the preview and the export
// (what objectEffects.test.ts pinned for exportEffects), and an export's own
// drawing state (part of U8). Then WebGL context lifetimes (D1) with fake
// contexts: only GL effects in use by the preview or a running export hold
// one, and a lost one is rebuilt.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {backgroundEffects, highlightEffects, moreEffects} from '@/common/components/effects/EffectsUtils';
import BaseGLEffect from '@/common/components/video/effects/BaseGLEffect';
import {AbstractEffect, type EffectFrameContext, type EffectInit, type EffectParams} from '@/common/components/video/effects/Effect';
import AllEffects, {type Effects} from '@/common/components/video/effects/Effects';
import type {Tracklet} from '@/common/tracker/Tracker';
import type {CanvasForm} from 'pts';
import {type EffectClip, type EffectDoc, normalizeParams} from '~/state/effectClips';
import type MaskOverlayEffect from './MaskOverlayEffect';
import ObjectHighlight from './ObjectHighlight';

type Drawn = {effect: string; params: EffectParams; variant: number; ids: number[]; time?: number; active?: number | null};

function fakeEffect(name: string, log: Drawn[]) {
  return {
    numVariants: 4,
    variant: 0,
    params: {} as EffectParams,
    setParams(p: EffectParams) {
      this.params = p;
    },
    setup: vi.fn(async () => {}),
    apply(_form: CanvasForm, ctx: EffectFrameContext, ts: Tracklet[]) {
      log.push({effect: name, params: {...this.params}, variant: this.variant, ids: ts.map(t => t.id), time: ctx.time});
    },
  };
}

function setup() {
  const log: Drawn[] = [];
  const overlay = {
    variant: 0,
    activeObjectId: 7 as number | null,
    faded: () => true,
    apply(_form: CanvasForm, _ctx: EffectFrameContext, ts: Tracklet[]) {
      log.push({effect: 'Overlay', params: {}, variant: this.variant, ids: ts.map(t => t.id), active: this.activeObjectId});
    },
  };
  const meta = Object.fromEntries(
    ['Outline', 'Cutout', 'PixelateMask', 'BackgroundBlur'].map(n => [n, fakeEffect(n, log)]),
  ) as unknown as Effects;
  const h = new ObjectHighlight(overlay as unknown as MaskOverlayEffect, meta, () => ({width: 8, height: 8}));
  return {h, log, overlay};
}

const preview = {} as CanvasForm;
const exportForm = {} as CanvasForm;

function frame(ids: number[], frameIndex = 10): [EffectFrameContext, Tracklet[]] {
  const ctx = {
    frameIndex,
    fps: 10,
    totalFrames: 100,
    width: 8,
    height: 8,
    masks: ids.map(id => ({bitmap: {id}, bounds: [[0, 0], [1, 1]]})),
    maskColors: ids.map(id => `#00000${id}`),
  } as unknown as EffectFrameContext;
  return [ctx, ids.map(id => ({id}) as Tracklet)];
}

let n = 0;
function clip(id: number | 'bg', effect: string, params: EffectParams = {}, over: Partial<EffectClip> = {}): EffectClip {
  return {
    id: `k${n++}`,
    target: id === 'bg' ? {kind: 'background'} : {kind: 'object', id},
    effect,
    params: normalizeParams(effect, params),
    start: 0,
    end: 100,
    row: 0,
    phase: 0,
    ...over,
  };
}
const doc = (...clips: EffectClip[]): EffectDoc => ({version: 2, clips});

describe('ObjectHighlight', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return {};
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('two objects with one effect and different settings: two passes, each with its own settings (U3)', async () => {
    const {h, log} = setup();
    const d = doc(clip(1, 'Outline', {width: 0.01, color: '#ff0000'}), clip(2, 'Outline', {width: 0.04, color: '#0000ff'}));
    for (const order of [[1, 2], [2, 1]]) {
      log.length = 0;
      await h.setDoc(d, order);
      h.apply(preview, ...frame([1, 2]));
      expect(log.map(p => p.ids)).toEqual(order.map(id => [id]));
      const by = Object.fromEntries(log.map(p => [p.ids[0], p.params]));
      expect(by[1]).toMatchObject({width: 0.01, color: '#ff0000'});
      expect(by[2]).toMatchObject({width: 0.04, color: '#0000ff'});
    }
  });

  it('equal settings share a pass, three masks at a time; the style sets the variant', async () => {
    const {h, log} = setup();
    const d = doc(...[1, 2, 3, 4].map(id => clip(id, 'PixelateMask', {style: 'Coarse'})));
    await h.setDoc(d, [1, 2, 3, 4]);
    h.apply(preview, ...frame([1, 2, 3, 4]));
    expect(log.map(p => [p.effect, p.ids, p.variant])).toEqual([
      ['PixelateMask', [1, 2, 3], 2],
      ['PixelateMask', [4], 2],
    ]);
  });

  it('draws background clips, then objects bottom layer first, each by row; passes keep that order', async () => {
    const {h, log} = setup();
    const d = doc(
      clip(1, 'Outline', {}, {row: 1}),
      clip(1, 'PixelateMask', {}, {row: 0}),
      clip(2, 'Cutout'),
      clip('bg', 'BackgroundBlur', {style: 'Strong'}),
    );
    await h.setDoc(d, [2, 1]);
    h.apply(preview, ...frame([1, 2]));
    expect(log.map(p => [p.effect, p.ids])).toEqual([
      ['BackgroundBlur', []],
      ['Cutout', [2]],
      ['PixelateMask', [1]],
      ['Outline', [1]],
    ]);
    expect(log[0].variant).toBe(2);
  });

  it('objects the order does not name yet go below it; absent objects are skipped', async () => {
    const {h, log} = setup();
    await h.setDoc(doc(clip(1, 'Cutout'), clip(5, 'Outline'), clip(9, 'PixelateMask')), [1, 5]);
    h.apply(preview, ...frame([1, 9])); // 5 has no mask on this frame
    expect(log.map(p => p.ids)).toEqual([[9], [1]]);
  });

  it('passes each clip its own clock: (frame - start + phase) / fps', async () => {
    const {h, log} = setup();
    await h.setDoc(doc(clip(1, 'Outline', {}, {start: 4, phase: 2})), [1]);
    h.apply(preview, ...frame([1], 10));
    expect(log[0].time).toBeCloseTo(0.8);
  });

  it('an object with no clip on the frame shows the Overlay with editing aids in the preview', async () => {
    const {h, log} = setup();
    await h.setDoc(doc(clip(1, 'Cutout', {}, {start: 50, end: 60}), clip(2, 'Outline')), [1, 2, 3]);
    h.apply(preview, ...frame([1, 2, 3], 10));
    expect(log.map(p => [p.effect, p.ids, p.active])).toEqual([
      ['Overlay', [1], 7],
      ['Outline', [2], undefined],
      ['Overlay', [3], 7],
    ]);
  });

  it('an unknown effect draws as the Overlay; one on the background leaves the frame plain', async () => {
    const {h, log} = setup();
    await h.setDoc(doc(clip(1, 'FutureEffect', {k: 1}), clip('bg', 'FutureBackground')), [1]);
    h.apply(preview, ...frame([1]));
    expect(log.map(p => [p.effect, p.ids, p.variant])).toEqual([['Overlay', [1], 0]]);
  });

  it('hides hidden objects in the preview only', async () => {
    const {h, log} = setup();
    await h.setDoc(doc(clip(1, 'Cutout')), [1, 2]);
    h.hidden = id => id === 1;
    h.apply(preview, ...frame([1, 2]));
    expect(log.map(p => p.ids)).toEqual([[2]]);
    log.length = 0;
    const state = {doc: doc(clip(1, 'Cutout')), drawOrder: [1, 2], untouched: 'shown' as const};
    await h.prepare(state);
    h.drawWith(exportForm, state);
    h.apply(exportForm, ...frame([1, 2]));
    expect(log.map(p => p.ids)).toEqual([[1], [2]]);
  });

  it("an export draws untouched objects as Original by default, or as shown; a chosen Overlay stays (Q5)", async () => {
    const {h, log, overlay} = setup();
    const d = doc(clip(1, 'PixelateMask'), clip(4, 'Overlay', {style: 'Strong tint'}));
    const original = {doc: d, drawOrder: [1, 2, 3, 4], untouched: 'original' as const};
    await h.prepare(original);
    h.drawWith(exportForm, original);
    h.apply(exportForm, ...frame([1, 2, 3, 4]));
    expect(log.map(p => [p.effect, p.ids, p.params.style ?? null])).toEqual([
      ['PixelateMask', [1], 'Fine'],
      ['Cutout', [2, 3], 'Unchanged'],
      ['Overlay', [4], null],
    ]);
    expect(log[2]).toMatchObject({variant: 1, active: null}); // no selection emphasis in the file
    expect(overlay.activeObjectId).toBe(7); // ...and the preview's is left alone

    log.length = 0;
    const shown = {...original, untouched: 'shown' as const};
    h.drawWith(exportForm, shown);
    h.apply(exportForm, ...frame([1, 2, 3, 4]));
    expect(log.map(p => [p.effect, p.ids, p.variant])).toEqual([
      ['PixelateMask', [1], 0],
      ['Overlay', [2, 3], 0],
      ['Overlay', [4], 1],
    ]);
  });

  it("an export's canvas keeps its own clips while the preview changes (U8)", async () => {
    const {h, log} = setup();
    await h.setDoc(doc(clip(1, 'Cutout')), [1]);
    const state = {doc: doc(clip(1, 'PixelateMask')), drawOrder: [1], untouched: 'original' as const};
    await h.prepare(state);
    h.drawWith(exportForm, state);
    await h.setDoc(doc(clip(1, 'Outline')), [1]); // an edit while the export runs
    h.apply(exportForm, ...frame([1]));
    h.apply(preview, ...frame([1]));
    expect(log.map(p => p.effect)).toEqual(['PixelateMask', 'Outline']);
  });
});

/** A WebGL2 context that only knows whether it is lost, and can be lost as Chrome's cap does. */
class FakeCanvas {
  lost = false;
  constructor(private _noContext = false) {}
  private _onLost: (() => void)[] = [];
  private _gl = {
    isContextLost: () => this.lost,
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? {loseContext: () => this.lose()} : null),
  };
  getContext(): unknown {
    return this._noContext ? null : this._gl;
  }
  addEventListener(type: string, listener: () => void): void {
    if (type === 'webglcontextlost') {
      this._onLost.push(listener);
    }
  }
  lose(): void {
    this.lost = true;
    this._onLost.forEach(l => l());
  }
}

/** A Meta GL effect: needs a live context to draw anything. */
class FakeGLEffect extends BaseGLEffect {
  gl: {isContextLost(): boolean} | null = null;
  cleanups = 0;
  fail = false;
  draws: number[][] = [];
  async setup(init: EffectInit): Promise<void> {
    this.gl = (init.gl as unknown as {isContextLost(): boolean}) ?? null;
    if (this.fail) {
      throw new Error('setup failed');
    }
  }
  async cleanup(): Promise<void> {
    this.cleanups++;
  }
  apply(_form: CanvasForm, _context: EffectFrameContext, tracklets: Tracklet[]): void {
    // drawing on a lost context paints nothing, which is the bug this guards
    if (this.gl?.isContextLost() === false) {
      this.draws.push(tracklets.map(t => t.id));
    }
  }
}

/** A Meta 2D effect: draws on the form, no context. */
class Fake2DEffect extends AbstractEffect {
  draws: number[][] = [];
  apply(_form: CanvasForm, _context: EffectFrameContext, tracklets: Tracklet[]): void {
    this.draws.push(tracklets.map(t => t.id));
  }
}

describe('ObjectHighlight WebGL contexts (D1)', () => {
  // the real registry's split between GL and 2D effects, faked
  const isGL = (name: string) => AllEffects[name as keyof Effects] instanceof BaseGLEffect;

  function contexts(noContext = false) {
    const canvases: FakeCanvas[] = [];
    const meta = Object.fromEntries(
      Object.keys(AllEffects).map(n => [n, isGL(n) ? new FakeGLEffect(4) : new Fake2DEffect(4)]),
    ) as unknown as Record<string, FakeGLEffect>;
    const plain: number[][] = [];
    const overlay = {
      variant: 0,
      apply: (_f: CanvasForm, _c: EffectFrameContext, t: Tracklet[]) => plain.push(t.map(x => x.id)),
      cleanup: async () => {},
    } as unknown as MaskOverlayEffect;
    const h = new ObjectHighlight(overlay, meta as unknown as Effects, () => ({width: 4, height: 4}), () => {
      const c = new FakeCanvas(noContext);
      canvases.push(c);
      return c as unknown as OffscreenCanvas;
    });
    const draw = (ids: number[], form = preview) => h.apply(form, ...frame(ids));
    const live = () => canvases.filter(c => !c.lost).length;
    return {h, meta, canvases, plain, draw, live};
  }

  it('cycling every exposed background and object effect keeps one context per GL effect in use, none for 2D', async () => {
    const {h, draw, live, canvases} = contexts();
    const backgrounds = backgroundEffects.map(e => e.effectName);
    const objects = [...highlightEffects, ...moreEffects].map(e => e.effectName);
    expect(backgrounds.filter(n => !isGL(n))).toEqual(['Original', 'EraseBackground', 'Desaturate', 'BackgroundText']);
    for (let round = 0; round < 2; round++) {
      for (const bg of backgrounds) {
        for (const fx of objects) {
          await h.setDoc(doc(clip('bg', bg), clip(1, fx), clip(2, 'Cutout')), [1, 2]);
          draw([1, 2]);
          expect(live()).toBe(new Set([bg, fx, 'Cutout'].filter(n => n !== 'Overlay' && isGL(n))).size);
        }
      }
    }
    await h.setDoc(doc(clip('bg', 'Original'), clip(1, 'Desaturate')), [1]);
    expect(live()).toBe(0);
    expect(canvases.length).toBeGreaterThan(0);
  });

  it('frees a context on cleanup and when no clip uses its effect', async () => {
    const {h, meta, draw, live} = contexts();
    await h.setDoc(doc(clip(1, 'Burst'), clip(2, 'Scope')), [1, 2]);
    expect(live()).toBe(2);
    await h.setDoc(doc(clip(1, 'Burst'), clip(2, 'Overlay')), [1, 2]);
    expect(live()).toBe(1);
    expect(meta.Scope.cleanups).toBe(1);
    draw([1, 2]);
    expect(meta.Burst.draws).toEqual([[1]]);
    await h.cleanup();
    expect(live()).toBe(0);
  });

  it("a preview edit during an export never frees an effect the export draws; the export's end does", async () => {
    const {h, meta, draw, live} = contexts();
    await h.setDoc(doc(clip(1, 'Burst')), [1]);
    const state = {doc: doc(clip(1, 'Burst'), clip('bg', 'BackgroundBlur')), drawOrder: [1, 2], untouched: 'original' as const};
    await h.prepare(state);
    h.drawWith(exportForm, state);
    expect(live()).toBe(3); // Burst, BackgroundBlur, and Cutout for the untouched object 2
    await h.setDoc(doc(clip(1, 'Scope')), [1]); // the person edits the preview mid-export
    expect(live()).toBe(4);
    draw([1, 2], exportForm);
    expect(meta.Burst.draws).toEqual([[1]]);
    expect(meta.BackgroundBlur.draws).toEqual([[]]);
    expect(meta.Cutout.draws).toEqual([[2]]);
    await h.finish(state);
    expect(live()).toBe(1);
    expect([meta.Burst, meta.BackgroundBlur, meta.Cutout].map(e => e.cleanups)).toEqual([1, 1, 1]);
  });

  it('rebuilds a lost context on the next draw instead of drawing nothing', async () => {
    const {h, meta, canvases, plain, draw} = contexts();
    await h.setDoc(doc(clip(1, 'EraseForeground'), clip('bg', 'Pixelate')), [1]);
    canvases[0].lose(); // the browser took it, with the event
    draw([1]);
    expect(canvases).toHaveLength(3);
    expect(meta.EraseForeground.draws).toEqual([[1]]);

    canvases[1].lost = true; // lost, the event not yet delivered
    draw([1]);
    expect(canvases).toHaveLength(4);
    expect(meta.Pixelate.draws).toEqual([[], []]);
    expect(meta.EraseForeground.draws).toHaveLength(2);
    expect(plain).toEqual([]);
  });

  it('draws an object effect without a context as the Overlay and a background one not at all, trying once per setDoc', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const {h, meta, canvases, plain, draw} = contexts(true);
    await h.setDoc(doc(clip(1, 'Burst'), clip('bg', 'Sobel'), clip('bg', 'Desaturate', {}, {row: 1})), [1]);
    draw([1]);
    draw([1]);
    expect(plain).toEqual([[1], [1]]);
    expect((meta.Desaturate as unknown as Fake2DEffect).draws).toEqual([[], []]); // 2D needs no context
    expect(canvases).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('draws an effect whose setup failed as the Overlay, until the next setDoc', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const {h, meta, canvases, plain, draw} = contexts();
    meta.Scope.fail = true;
    await h.setDoc(doc(clip(1, 'Scope')), [1]);
    draw([1]);
    expect(plain).toEqual([[1]]);
    expect(canvases).toHaveLength(1);
    meta.Scope.fail = false;
    await h.setDoc(doc(clip(1, 'Scope')), [1]);
    draw([1]);
    expect(meta.Scope.draws).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
