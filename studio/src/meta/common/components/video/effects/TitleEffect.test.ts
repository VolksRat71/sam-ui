// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Title: its entrance at fixed clip times, where its lines go, and which
// pixels go back over it (the subjects' union, Behind subjects only), drawn
// on a recording 2D context.
import type {CanvasForm} from 'pts';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {normalizeParams} from '~/state/effectClips';
import type {EffectFrameContext, EffectMask, EffectParams} from './Effect';
import TitleEffect, {LINE_HEIGHT, entranceAt, interLoaded, lineOrigins} from './TitleEffect';

describe('entranceAt', () => {
  it('None is there from the first frame', () => {
    expect(entranceAt('None', 0, 0.6)).toEqual({alpha: 1, rise: 0, scale: 1});
  });

  it('Fade goes from clear to opaque over its seconds, easing out, then stays', () => {
    const alpha = (t: number) => entranceAt('Fade', t, 1).alpha;
    expect(alpha(-1)).toBe(0);
    expect(alpha(0)).toBe(0);
    expect(alpha(0.5)).toBeCloseTo(0.875, 10); // 1 - 0.5^3
    expect(alpha(1)).toBe(1);
    expect(alpha(5)).toBe(1);
    expect(entranceAt('Fade', 0.5, 1)).toMatchObject({rise: 0, scale: 1});
  });

  it('Rise comes up half a font size as it fades in', () => {
    expect(entranceAt('Rise', 0, 2)).toEqual({alpha: 0, rise: 0.5, scale: 1});
    expect(entranceAt('Rise', 1, 2).rise).toBeCloseTo(0.0625, 10);
    expect(entranceAt('Rise', 2, 2)).toEqual({alpha: 1, rise: 0, scale: 1});
  });

  it('Pop grows from half size, overshoots, and settles at 1', () => {
    const scale = (t: number) => entranceAt('Pop', t, 1).scale;
    expect(scale(0)).toBeCloseTo(0.5, 10);
    expect(Math.max(...[0.6, 0.7, 0.8, 0.9].map(scale))).toBeGreaterThan(1);
    expect(scale(1)).toBe(1);
    expect(scale(3)).toBe(1);
  });

  it('is a pure function of the clip time: the same time, the same look', () => {
    expect(entranceAt('Pop', 0.37, 0.6)).toEqual(entranceAt('Pop', 0.37, 0.6));
  });
});

describe('lineOrigins', () => {
  it('centres the block of lines on the point, a line height apart', () => {
    expect(lineOrigins([100], 'Centre', 640, 360, 50)).toEqual([[640, 360]]);
    expect(lineOrigins([100, 300, 200], 'Centre', 640, 360, 50)).toEqual([
      [640, 310],
      [640, 360],
      [640, 410],
    ]);
    expect(lineOrigins([10, 10], 'Centre', 0, 0, 40)).toEqual([
      [0, -20],
      [0, 20],
    ]);
  });

  it('aligns lines to the left or right edge of the widest one', () => {
    expect(lineOrigins([100, 300], 'Left', 640, 360, 50).map(o => o[0])).toEqual([490, 490]);
    expect(lineOrigins([100, 300], 'Right', 640, 360, 50).map(o => o[0])).toEqual([790, 790]);
  });
});

describe('interLoaded', () => {
  it("is true once the worker's Inter is in the font set and loaded, false without it or when it fails", async () => {
    const set = (load: () => Promise<unknown[]>) => ({load: vi.fn(load)}) as unknown as FontFaceSet;
    const loaded = set(async () => [{family: 'Inter'}]);
    expect(await interLoaded(loaded)).toBe(true);
    expect(loaded.load).toHaveBeenCalledWith('16px Inter');
    expect(await interLoaded(set(async () => []))).toBe(false);
    expect(await interLoaded(set(() => Promise.reject(new Error('network'))))).toBe(false);
    expect(await interLoaded(undefined)).toBe(false);
  });
});

describe('TitleEffect', () => {
  type Call = [string, ...unknown[]];

  /** A 2D context that records what is drawn, with the state a draw reads. */
  /** Draw calls on every recorder, in order: `form:fillText`, `cut:drawImage`. */
  const seq: string[] = [];
  function recorder(calls: Call[], canvas: unknown = null, tag = 'form') {
    const state: Record<string, unknown> = {canvas};
    return new Proxy(state, {
      get(target, key: string) {
        if (key === 'measureText') {
          return (s: string) => ({width: s.length * 10});
        }
        if (['save', 'restore', 'translate', 'scale', 'fillText', 'drawImage', 'putImageData'].includes(key)) {
          return (...args: unknown[]) => (seq.push(`${tag}:${key}`), calls.push([key, ...args]));
        }
        return target[key];
      },
      set(target, key: string, v) {
        target[key] = v;
        if (['font', 'fillStyle', 'globalAlpha', 'textAlign', 'textBaseline', 'globalCompositeOperation'].includes(key)) {
          calls.push([`${key}=`, v]);
        }
        return true;
      },
    });
  }

  const cuts: Array<{width: number; height: number; calls: Call[]}> = [];
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      calls: Call[] = [];
      constructor(
        public width: number,
        public height: number,
      ) {
        cuts.push(this);
      }
      getContext() {
        return recorder(this.calls, this, 'cut');
      }
    },
  );
  vi.stubGlobal(
    'ImageData',
    class {
      data: Uint8ClampedArray;
      constructor(w: number, h: number) {
        this.data = new Uint8ClampedArray(w * h * 4);
      }
    },
  );
  afterEach(() => {
    cuts.length = 0;
  });

  const W = 4;
  const H = 2;
  const frame = {} as ImageBitmap;
  /** The form's canvas: the stage the background clips below drew. */
  const stage = {name: 'stage'};
  // column-major RLE: 0 out, then 3 in (x 0: y 0-1, x 1: y 0), then the rest out
  const mask: EffectMask = {bitmap: {size: [H, W], counts: '035'} as never, bounds: [[0, 0], [W, H]]};

  function draw(params: EffectParams, over: Partial<EffectFrameContext> = {}) {
    const calls: Call[] = [];
    const effect = new TitleEffect();
    effect.setParams(normalizeParams('Title', params));
    const context = {frameIndex: 0, totalFrames: 10, fps: 10, width: W, height: H, masks: [mask], maskColors: ['#fff'], frame, actionPoint: null, time: 5, ...over} as EffectFrameContext;
    effect.apply({ctx: recorder(calls, stage)} as unknown as CanvasForm, context, []);
    return {calls, effect, context};
  }
  const of = (calls: Call[], name: string) => calls.filter(c => c[0] === name);

  it('draws each line with fillText alone, in Inter at its weight, size (of the frame height) and colour', () => {
    const {calls} = draw({text: 'One\nTwo', weight: 300, size: 0.25, color: '#ff8800', align: 'Left', x: 0.25, y: 1, placement: 'In front'});
    expect(of(calls, 'font=')).toEqual([['font=', '300 0.5px Inter, sans-serif']]);
    expect(of(calls, 'fillStyle=')).toEqual([['fillStyle=', '#ff8800']]);
    expect(of(calls, 'textAlign=')).toEqual([['textAlign=', 'left']]);
    expect(of(calls, 'translate')).toEqual([['translate', 1, 2]]); // x 0.25 of 4, y 1 of 2
    const lh = 0.5 * LINE_HEIGHT;
    expect(of(calls, 'fillText')).toEqual([
      ['fillText', 'One', -15, -lh / 2],
      ['fillText', 'Two', -15, lh / 2],
    ]);
  });

  it('enters on the clip clock: nothing at the first frame of a Fade, all of it once the entrance is over', () => {
    expect(of(draw({animation: 'Fade', entrance: 1, placement: 'In front'}, {time: 0}).calls, 'fillText')).toEqual([]);
    expect(of(draw({animation: 'Fade', entrance: 1, placement: 'In front'}, {time: 1}).calls, 'globalAlpha=')).toEqual([['globalAlpha=', 1]]);
    // Rise starts half a font size (0.12 x 2 px) low
    expect(of(draw({animation: 'Rise', entrance: 1, placement: 'In front'}, {time: 0.000001}).calls, 'translate')[0][2]).toBeCloseTo(1 + 0.12, 4);
  });

  it("Behind subjects cuts the stage below out inside the subjects' union before the text and puts it back over it; In front does not", () => {
    seq.length = 0;
    const behind = draw({});
    expect(seq.filter(c => /drawImage|fillText/.test(c))).toEqual(['cut:drawImage', 'form:fillText', 'form:drawImage']);
    expect(cuts).toHaveLength(1);
    const cut = cuts[0];
    // the union's alpha, rows from the column-major mask: (0,0) (0,1) (1,0) in
    const put = of(cut.calls, 'putImageData')[0][1] as {data: Uint8ClampedArray};
    expect([...Array(W * H).keys()].filter(i => put.data[i * 4 + 3] === 255)).toEqual([0, 1, 4]);
    expect(cut.calls.map(c => c[0])).toEqual(['putImageData', 'globalCompositeOperation=', 'drawImage', 'globalCompositeOperation=']);
    expect(of(cut.calls, 'globalCompositeOperation=')[0][1]).toBe('source-in');
    expect(of(cut.calls, 'drawImage')[0][1]).toBe(stage); // what the clips below drew there, not the raw frame
    // on the form after the text, at the origin
    const names = behind.calls.map(c => c[0]);
    expect(names.lastIndexOf('drawImage')).toBeGreaterThan(names.lastIndexOf('fillText'));
    expect(of(behind.calls, 'drawImage')).toEqual([['drawImage', cut, 0, 0]]);

    cuts.length = 0;
    const front = draw({placement: 'In front'});
    expect(of(front.calls, 'drawImage')).toEqual([]);
    expect(cuts).toHaveLength(0);
  });

  it('puts nothing back on a frame with no subject, and still does while the text is not shown yet', () => {
    expect(of(draw({}, {masks: []}).calls, 'drawImage')).toEqual([]);
    expect(of(draw({animation: 'Fade'}, {time: 0}).calls, 'drawImage')).toHaveLength(1);
  });

  it('makes its canvas once, and frees it on cleanup', async () => {
    const {effect, context} = draw({});
    effect.apply({ctx: recorder([])} as unknown as CanvasForm, context, []);
    expect(cuts).toHaveLength(1);
    await effect.cleanup();
    effect.apply({ctx: recorder([])} as unknown as CanvasForm, context, []);
    expect(cuts).toHaveLength(2);
  });
});
