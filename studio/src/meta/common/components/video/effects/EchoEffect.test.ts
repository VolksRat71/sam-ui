// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Echo: which earlier frames a clip draws from (inside the clip only, count
// and spacing, at most six), each copy's opacity, and the compositing order on
// recording 2D contexts: the stage inside every subject's mask is cut out
// first, the copies drawn farthest first, then the subjects put back on top
// (the layer's own and every other shown layer's). A frame's
// drawing depends only on what it is given, never on frames drawn before.
import type {Tracklet} from '@/common/tracker/Tracker';
import type {CanvasForm} from 'pts';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {type EffectClip, type EffectDoc, normalizeParams, splitClip, trimClip} from '~/state/effectClips';
import type {EffectFrameContext, EffectMask, EffectParams, HistoryFrame} from './Effect';
import EchoEffect, {echoAlpha, echoFrames} from './EchoEffect';

const params = (p: EffectParams = {}) => normalizeParams('Echo', p);

describe('echoFrames', () => {
  it('count frames, spacing apart, nearest first', () => {
    expect(echoFrames(params({count: 3, spacing: 2}), 0, 50)).toEqual([48, 46, 44]);
    expect(echoFrames(params({count: 1, spacing: 8}), 0, 50)).toEqual([42]);
  });

  it("never a frame before the clip's start, so the clip starts clean", () => {
    expect(echoFrames(params({count: 4, spacing: 3}), 40, 40)).toEqual([]);
    expect(echoFrames(params({count: 4, spacing: 3}), 40, 42)).toEqual([]);
    expect(echoFrames(params({count: 4, spacing: 3}), 40, 43)).toEqual([40]);
    expect(echoFrames(params({count: 4, spacing: 3}), 40, 47)).toEqual([44, 41]);
    expect(echoFrames(params({count: 4, spacing: 3}), 40, 60)).toEqual([57, 54, 51, 48]);
  });

  it('six frames at most, whatever the stored count', () => {
    expect(echoFrames({count: 50, spacing: 1}, 0, 100)).toHaveLength(6);
    expect(echoFrames({count: 0, spacing: 0}, 0, 100)).toEqual([99]); // clamped to 1 and 1
  });

  it('is a pure function of the settings, the clip start and the frame', () => {
    expect(echoFrames(params({count: 5, spacing: 4}), 3, 77)).toEqual(echoFrames(params({count: 5, spacing: 4}), 3, 77));
  });
});

describe('historyFrames: from the clip animation start (start - phase)', () => {
  const echo = new EchoEffect();
  const clip: EffectClip = {id: 'e', target: {kind: 'object', id: 1}, effect: 'Echo', params: params({count: 4, spacing: 3}), start: 20, end: 100, row: 0, phase: 0};
  const doc: EffectDoc = {version: 2, clips: [clip]};
  const frames = (c: EffectClip, from: number, to: number) => Array.from({length: to - from + 1}, (_, k) => echo.historyFrames(c, from + k));

  it('a split at 50: the right part names the same frames on 50-62 as the unsplit clip', () => {
    const right = splitClip(doc, 'e', 50, 'r').clips.find(c => c.id === 'r')!;
    expect(right.start).toBe(50);
    expect(frames(right, 50, 62)).toEqual(frames(clip, 50, 62));
    expect(frames(right, 50, 50)[0]).toEqual([47, 44, 41, 38]);
  });

  it('a start trimmed to 50 likewise', () => {
    const trimmed = trimClip(doc, 'e', 'start', 50, 247).clips[0];
    expect(frames(trimmed, 50, 62)).toEqual(frames(clip, 50, 62));
  });

  it('a fresh clip (phase 0) still starts clean; never before frame 0', () => {
    expect(echo.historyFrames(clip, 20)).toEqual([]);
    expect(echo.historyFrames(clip, 23)).toEqual([20]);
    expect(echo.historyFrames({...clip, start: 5, phase: 40}, 12)).toEqual([9, 6, 3, 0]);
  });
});

describe('echoAlpha', () => {
  it('Echo: each copy falloff fainter than the one before', () => {
    const p = params({style: 'Echo', opacity: 0.8, falloff: 0.5});
    expect([1, 2, 3].map(k => echoAlpha(p, k))).toEqual([0.8, 0.4, 0.2]);
  });

  it('Strobe: every copy alike, whatever the falloff', () => {
    const p = params({style: 'Strobe', opacity: 0.7, falloff: 0.5});
    expect([1, 2, 6].map(k => echoAlpha(p, k))).toEqual([0.7, 0.7, 0.7]);
  });
});

describe('EchoEffect', () => {
  type Call = [string, ...unknown[]];
  /** Draw calls on every recorder, in order, tagged: `form:drawImage`, `cut:putImageData`. */
  const seq: Array<[string, ...unknown[]]> = [];
  function recorder(calls: Call[], canvas: unknown, tag: string) {
    const state: Record<string, unknown> = {canvas};
    return new Proxy(state, {
      get(target, key: string) {
        if (['drawImage', 'putImageData', 'fillRect'].includes(key)) {
          return (...args: unknown[]) => (seq.push([`${tag}:${key}`, ...args]), calls.push([key, ...args]));
        }
        return target[key];
      },
      set(target, key: string, v) {
        target[key] = v;
        calls.push([`${key}=`, v]);
        return true;
      },
    });
  }
  const canvases: Array<{tag: string; calls: Call[]}> = [];

  beforeEach(() => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        calls: Call[] = [];
        tag = canvases.length % 2 === 0 ? 'cut' : 'copy';
        constructor(
          public width: number,
          public height: number,
        ) {
          canvases.push(this);
        }
        getContext() {
          return recorder(this.calls, this, this.tag);
        }
      },
    );
    vi.stubGlobal(
      'ImageData',
      class {
        data: Uint8ClampedArray;
        constructor(
          public width: number,
          public height: number,
        ) {
          this.data = new Uint8ClampedArray(width * height * 4);
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    canvases.length = 0;
    seq.length = 0;
  });

  const W = 4;
  const H = 2;
  const stage = {name: 'stage'};
  // column-major RLE: 0 out, then 3 in (x 0: y 0-1, x 1: y 0), then the rest out
  const mask = (bounds: EffectMask['bounds'] = [[0, 0], [2, 2]]): EffectMask => ({bitmap: {size: [H, W], counts: '035'} as never, bounds});
  const past = (name: string, ids: number[]): HistoryFrame => ({frame: {name} as unknown as ImageBitmap, masks: new Map(ids.map(id => [id, mask()]))});

  function draw(p: EffectParams, history: Map<number, HistoryFrame> | undefined, frameIndex = 20, effect = new EchoEffect(), over: Partial<EffectFrameContext> = {}, ids = [7]) {
    const calls: Call[] = [];
    effect.setParams(params(p));
    const context = {frameIndex, totalFrames: 100, fps: 10, width: W, height: H, masks: ids.map(() => mask()), maskColors: ids.map(() => '#00ff00'), frame: {}, actionPoint: null, history, ...over} as unknown as EffectFrameContext;
    effect.apply({ctx: recorder(calls, stage, 'form')} as unknown as CanvasForm, context, ids.map(id => ({id}) as Tracklet));
    return {calls, effect};
  }
  const draws = () => seq.filter(c => /drawImage/.test(c[0])).map(c => [c[0], (c[1] as {name?: string; tag?: string}).name ?? (c[1] as {tag: string}).tag]);

  it('cuts the layer out of the stage, draws the copies farthest first, then puts the layer back on top', () => {
    const {calls} = draw({count: 3, spacing: 2, opacity: 0.8, falloff: 0.5}, new Map([18, 16, 14].map(i => [i, past(`f${i}`, [7])])));
    expect(draws()).toEqual([
      ['cut:drawImage', 'stage'], // what the clips below drew inside the current mask
      ['copy:drawImage', 'f14'],
      ['form:drawImage', 'copy'],
      ['copy:drawImage', 'f16'],
      ['form:drawImage', 'copy'],
      ['copy:drawImage', 'f18'],
      ['form:drawImage', 'copy'],
      ['form:drawImage', 'cut'],
    ]);
    expect(calls.filter(c => c[0] === 'globalAlpha=').map(c => c[1])).toEqual([0.8 * 0.25, 0.8 * 0.5, 0.8, 1]);
    // each copy is its frame inside that frame's mask, within the mask's bounds
    const copy = canvases.find(c => c.tag === 'copy')!;
    expect(copy.calls.slice(0, 4).map(c => c[0])).toEqual(['putImageData', 'globalCompositeOperation=', 'drawImage', 'globalCompositeOperation=']);
    expect(copy.calls[1][1]).toBe('source-in');
    expect(copy.calls[0].slice(2)).toEqual([0, 0, 0, 0, 2, 2]);
    const put = copy.calls[0][1] as {data: Uint8ClampedArray};
    expect([...Array(W * H).keys()].filter(i => put.data[i * 4 + 3] === 255)).toEqual([0, 1, 4]);
    expect(seq.find(c => c[0] === 'form:drawImage')!.slice(2)).toEqual([0, 0, 2, 2, 0, 0, 2, 2]);
  });

  it("skips frames it was not given and frames without the layer's mask; nothing at all with no history (the clip's start)", () => {
    draw({count: 3, spacing: 2}, new Map([
      [18, past('f18', [7])],
      [16, past('f16', [8])], // another layer only
    ]));
    expect(draws()).toEqual([
      ['cut:drawImage', 'stage'],
      ['copy:drawImage', 'f18'],
      ['form:drawImage', 'copy'],
      ['form:drawImage', 'cut'],
    ]);
    seq.length = 0;
    const {calls} = draw({}, undefined);
    expect(calls).toEqual([]);
    expect(draw({}, new Map()).calls).toEqual([]);
  });

  it('tints each copy with the layer colour or a custom one, never the layer itself', () => {
    const history = new Map([[18, past('f18', [7])]]);
    const tints = (p: EffectParams) => {
      canvases.length = 0;
      draw({count: 1, spacing: 2, ...p}, history);
      return canvases.find(c => c.tag === 'copy')!.calls.filter(c => c[0] === 'fillStyle=').map(c => c[1]);
    };
    expect(tints({tint: 'None'})).toEqual([]);
    expect(tints({tint: 'Layer colour'})).toEqual(['#00ff00']);
    expect(tints({tint: 'Custom', color: '#ff00aa'})).toEqual(['#ff00aa']);
    const copy = canvases.find(c => c.tag === 'copy')!.calls;
    expect(copy.findIndex(c => c[0] === 'globalCompositeOperation=' && c[1] === 'source-atop')).toBeGreaterThan(copy.findIndex(c => c[0] === 'drawImage'));
    expect(copy.find(c => c[0] === 'globalAlpha=')?.[1]).toBe(0.6); // the default strength
    canvases.length = 0;
    draw({count: 1, spacing: 2, tint: 'Custom', tintStrength: 0.25}, history);
    expect(canvases.find(c => c.tag === 'copy')!.calls.find(c => c[0] === 'globalAlpha=')?.[1]).toBe(0.25);
    expect(canvases.find(c => c.tag === 'cut')!.calls.some(c => c[0] === 'fillStyle=')).toBe(false);
  });

  it("keeps the copies behind every subject: the cut is the union of all shown layers' masks, taken once and put back last", () => {
    // another layer (the ball) whose mask covers (3,0) and (3,1), outside this layer's: column-major, 6 out then 2 in
    const ball: EffectMask = {bitmap: {size: [H, W], counts: '62'} as never, bounds: [[3, 0], [4, 2]]};
    const history = new Map([18, 16].map(i => [i, past(`f${i}`, [7, 8])]));
    draw({count: 2, spacing: 2}, history, 20, new EchoEffect(), {subjects: [mask(), mask(), ball]}, [7, 8]);
    expect(draws()).toEqual([
      ['cut:drawImage', 'stage'],
      ['copy:drawImage', 'f16'],
      ['form:drawImage', 'copy'],
      ['copy:drawImage', 'f18'],
      ['form:drawImage', 'copy'],
      ['copy:drawImage', 'f16'],
      ['form:drawImage', 'copy'],
      ['copy:drawImage', 'f18'],
      ['form:drawImage', 'copy'],
      ['form:drawImage', 'cut'],
    ]);
    const cut = canvases.find(c => c.tag === 'cut')!;
    const put = cut.calls[0][1] as {data: Uint8ClampedArray};
    expect([...Array(W * H).keys()].filter(i => put.data[i * 4 + 3] === 255)).toEqual([0, 1, 3, 4, 7]);
    // within the union's bounds, the whole frame here
    expect(cut.calls[0].slice(2)).toEqual([0, 0, 0, 0, 4, 2]);
    expect(seq.at(-1)!.slice(2)).toEqual([0, 0, 4, 2, 0, 0, 4, 2]);
  });

  it('draws a frame the same whatever it drew before (no state carried between frames)', () => {
    const at = (f: number) => new Map([2, 4].map(d => [f - d, past(`f${f - d}`, [7])]));
    draw({count: 2, spacing: 2}, at(50), 50);
    const fresh = seq.map(c => c.map(String));
    expect(fresh.filter(c => c[0] === 'form:drawImage')).toHaveLength(3);
    seq.length = 0;
    const effect = new EchoEffect();
    draw({count: 2, spacing: 2}, at(90), 90, effect);
    draw({count: 6, spacing: 1, tint: 'Custom'}, at(10), 10, effect);
    seq.length = 0;
    draw({count: 2, spacing: 2}, at(50), 50, effect);
    expect(seq.map(c => c.map(String))).toEqual(fresh);
  });

  it('allocates its canvases once, not per frame', () => {
    const effect = new EchoEffect();
    for (const f of [20, 21, 22]) {
      draw({count: 2, spacing: 1}, new Map([[f - 1, past('a', [7])], [f - 2, past('b', [7])]]), f, effect);
    }
    expect(canvases).toHaveLength(2);
  });
});
