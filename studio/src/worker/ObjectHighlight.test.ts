// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it, vi} from 'vitest';
import {AbstractEffect, type EffectFrameContext, type EffectInit} from '@/common/components/video/effects/Effect';
import type {Effects} from '@/common/components/video/effects/Effects';
import type {Tracklet} from '@/common/tracker/Tracker';
import type {CanvasForm} from 'pts';
import type MaskOverlayEffect from './MaskOverlayEffect';
import ObjectHighlight from './ObjectHighlight';

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

class FakeEffect extends AbstractEffect {
  gl: unknown = null;
  cleanups = 0;
  fail = false;
  draws: {variant: number; ids: number[]}[] = [];
  async setup(init: EffectInit): Promise<void> {
    this.gl = init.gl;
    if (this.fail) {
      throw new Error('setup failed');
    }
  }
  async cleanup(): Promise<void> {
    this.cleanups++;
  }
  apply(_form: CanvasForm, _context: EffectFrameContext, tracklets: Tracklet[]): void {
    // drawing on a lost context paints nothing, which is the bug this guards
    if (!(this.gl as {isContextLost(): boolean}).isContextLost()) {
      this.draws.push({variant: this.variant, ids: tracklets.map(t => t.id)});
    }
  }
}

const NAMES = ['Cutout', 'EraseForeground', 'VibrantMask', 'PixelateMask', 'Replace', 'Burst', 'Scope', 'NoisyMask'];

function setup(noContext = false) {
  const canvases: FakeCanvas[] = [];
  const meta: Record<string, FakeEffect> = Object.fromEntries(NAMES.map(n => [n, new FakeEffect(3)]));
  const plain: number[][] = [];
  const overlay = {
    numVariants: 4,
    apply: (_f: CanvasForm, _c: EffectFrameContext, t: Tracklet[]) => plain.push(t.map(x => x.id)),
    cleanup: async () => {},
  } as unknown as MaskOverlayEffect;
  const highlight = new ObjectHighlight(overlay, meta as unknown as Effects, () => ({width: 4, height: 4}), () => {
    const c = new FakeCanvas(noContext);
    canvases.push(c);
    return c as unknown as OffscreenCanvas;
  });
  const draw = (ids: number[]) => {
    const context = {masks: ids.map(() => ({})), maskColors: ids.map(() => '#fff')} as unknown as EffectFrameContext;
    highlight.apply({} as CanvasForm, context, ids.map(id => ({id}) as Tracklet));
  };
  const live = () => canvases.filter(c => !c.lost).length;
  return {highlight, meta, canvases, plain, draw, live};
}

describe('ObjectHighlight WebGL contexts', () => {
  it('keeps a live context only for the effects objects use (D1)', async () => {
    const {highlight, meta, draw, live} = setup();
    for (const name of NAMES) {
      await highlight.setEffects({1: {name, variant: 0}, 2: {name: 'Cutout', variant: 0}});
      draw([1, 2]);
      expect(live()).toBe(name === 'Cutout' ? 1 : 2);
    }
    await highlight.setEffects({1: {name: 'EraseForeground', variant: 0}});
    expect(live()).toBe(1);
    expect(meta.Cutout.cleanups).toBe(1);
    meta.EraseForeground.draws = [];
    draw([1]);
    expect(meta.EraseForeground.draws).toEqual([{variant: 0, ids: [1]}]);
  });

  it('frees every context on cleanup and when all objects go back to the Overlay', async () => {
    const {highlight, live} = setup();
    await highlight.setEffects({1: {name: 'Burst', variant: 0}, 2: {name: 'Scope', variant: 1}});
    expect(live()).toBe(2);
    await highlight.setEffects({1: {name: 'Overlay', variant: 2}});
    expect(live()).toBe(0);
    await highlight.setEffects({1: {name: 'Burst', variant: 0}});
    await highlight.cleanup();
    expect(live()).toBe(0);
  });

  it('rebuilds a lost context on the next draw instead of drawing nothing', async () => {
    const {highlight, meta, canvases, plain, draw} = setup();
    await highlight.setEffects({1: {name: 'EraseForeground', variant: 0}});
    canvases[0].lose(); // the browser took it, with the event
    draw([1]);
    expect(canvases).toHaveLength(2);
    expect(meta.EraseForeground.draws).toEqual([{variant: 0, ids: [1]}]);

    canvases[1].lost = true; // lost, the event not yet delivered
    draw([1]);
    expect(canvases).toHaveLength(3);
    expect(meta.EraseForeground.draws).toHaveLength(2);
    expect(plain).toEqual([]);
  });

  it('draws an effect without a context as the Overlay, trying once per setEffects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const {highlight, canvases, plain, draw} = setup(true);
    await highlight.setEffects({1: {name: 'Burst', variant: 0}});
    draw([1]);
    draw([1]);
    expect(plain).toEqual([[1], [1]]);
    expect(canvases).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('draws an effect whose setup failed as the Overlay, until the next setEffects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const {highlight, meta, canvases, plain, draw} = setup();
    meta.Scope.fail = true;
    await highlight.setEffects({1: {name: 'Scope', variant: 0}});
    draw([1]);
    expect(plain).toEqual([[1]]);
    expect(canvases).toHaveLength(1);
    meta.Scope.fail = false;
    await highlight.setEffects({1: {name: 'Scope', variant: 0}});
    draw([1]);
    expect(meta.Scope.draws).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('groups objects by effect and variant, three masks per pass, others as the Overlay', async () => {
    const {highlight, meta, plain, draw} = setup();
    highlight.hidden = id => id === 9;
    await highlight.setEffects({
      1: {name: 'Burst', variant: 1},
      2: {name: 'Burst', variant: 1},
      3: {name: 'Burst', variant: 1},
      4: {name: 'Burst', variant: 1},
      5: {name: 'Burst', variant: 2},
      6: {name: 'Overlay', variant: 1},
      9: {name: 'Burst', variant: 1},
    });
    draw([1, 2, 3, 4, 5, 6, 7, 9]);
    expect(meta.Burst.draws).toEqual([
      {variant: 1, ids: [1, 2, 3]},
      {variant: 1, ids: [4]},
      {variant: 2, ids: [5]},
    ]);
    expect(plain).toEqual([[6, 7]]);
  });
});
