// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Sticker: the box it follows (the mask's bounds, smoothed over tracked
// neighbours), where it goes and how big, each built-in shape inside its box,
// its picture and label, drawn on a recording 2D context.
import {DataArray, encode, toBbox} from '@/jscocotools/mask';
import type {Tracklet} from '@/common/tracker/Tracker';
import type {CanvasForm} from 'pts';
import {describe, expect, it} from 'vitest';
import {EMPTY_DOC, type EffectClip, clipsMissingImages, imageKeys, normalizeParams} from '~/state/effectClips';
import type {EffectFrameContext, EffectParams} from './Effect';
import {EFFECT_SPECS, paramShown} from './EffectParamSpecs';
import StickerEffect, {type Bounds, SHAPES, placeSticker, smoothedBounds} from './StickerEffect';

type Call = [string, ...unknown[]];
const HASH = 'a'.repeat(64);

/** A 2D context that records what is drawn, with the state a draw reads; text is 10 px a character at any size. */
function recorder(calls: Call[]) {
  const state: Record<string, unknown> = {};
  return new Proxy(state, {
    get(target, key: string) {
      if (key === 'measureText') {
        return (s: string) => ({width: s.length * 10});
      }
      if (key in target) {
        return target[key];
      }
      return (...args: unknown[]) => calls.push([key, ...args]);
    },
    set(target, key: string, v) {
      target[key] = v;
      calls.push([`${key}=`, v]);
      return true;
    },
  });
}
const of = (calls: Call[], name: string) => calls.filter(c => c[0] === name);

/** Every point a path's commands reach (arc: its circle's box). */
function pathPoints(calls: Call[]): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (const [name, ...a] of calls as Array<[string, ...number[]]>) {
    if (name === 'arc') {
      const [x, y, r] = a;
      pts.push([x - r, y - r], [x + r, y + r]);
    } else if (['moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo'].includes(name)) {
      for (let i = 0; i < a.length; i += 2) {
        pts.push([a[i], a[i + 1]]);
      }
    }
  }
  return pts;
}

describe('the box a sticker follows', () => {
  it("is the mask's bounds: x across, y down, in frame pixels (jscocotools toBbox on the column-major RLE)", () => {
    // a 20 x 10 frame with a 6 x 3 block at x 5..10, y 2..4
    const [w, h] = [20, 10];
    const data = new Uint8Array(w * h);
    for (let x = 5; x < 11; x++) for (let y = 2; y < 5; y++) data[x * h + y] = 1;
    const rle = encode(new DataArray(data, [h, w, 1]))[0];
    const [x, y, bw, bh] = toBbox([rle]);
    // StudioSession.toMask stores exactly this as every mask's bounds
    expect([[x, y], [x + bw, y + bh]]).toEqual([[5, 2], [11, 5]]);
  });

  const at = (x: number): {bounds: Bounds} => ({bounds: [[x, 0], [x + 10, 20]]});

  it('is the frame\'s own with smoothing 0, and none on a frame with no mask', () => {
    const masks = [at(0), at(10), at(20)];
    expect(smoothedBounds(masks, 1, 0)).toEqual([[10, 0], [20, 20]]);
    expect(smoothedBounds([at(0), undefined, at(20)], 1, 2)).toBeNull();
  });

  it('averages frames f-k..f+k: a steady move is unchanged, jitter is removed', () => {
    const steady = [0, 10, 20, 30, 40].map(at);
    expect(smoothedBounds(steady, 2, 2)).toEqual([[20, 0], [30, 20]]);
    const jitter = [0, 6, 0, 6, 0].map(at);
    expect(smoothedBounds(jitter, 2, 2)![0][0]).toBeCloseTo(2.4, 10); // (0+6+0+6+0)/5
  });

  it('narrows the window evenly at the video\'s ends and at a frame with no mask, so it stays centred (no lag)', () => {
    const steady = [0, 10, 20, 30, 40].map(at);
    expect(smoothedBounds(steady, 0, 3)).toEqual([[0, 0], [10, 20]]); // first frame: nothing before it
    expect(smoothedBounds(steady, 1, 3)).toEqual([[10, 0], [20, 20]]); // 0..2
    expect(smoothedBounds(steady, 4, 3)).toEqual([[40, 0], [50, 20]]); // last frame
    // frame 1 absent (an absent range, or untracked): frame 3 averages only 2..4
    const gap = [at(100), undefined, at(20), at(30), at(40), at(50), at(60)];
    expect(smoothedBounds(gap, 3, 3)).toEqual([[30, 0], [40, 20]]);
  });

  it('is deterministic: the same masks, the same box, whatever was drawn before', () => {
    const masks = [3, 9, 1, 7, 5, 8].map(at);
    const first = smoothedBounds(masks, 3, 2);
    smoothedBounds(masks, 0, 6);
    expect(smoothedBounds(masks, 3, 2)).toEqual(first);
  });
});

describe('placeSticker', () => {
  // a subject 100 px wide and 200 px tall at (300, 100), on a 720 px tall frame
  const box: Bounds = [[300, 100], [400, 300]];
  const place = (position: string, over: Partial<{size: number; minSize: number; offsetX: number; offsetY: number}> = {}) => {
    const o = {size: 0.25, minSize: 0, offsetX: 0, offsetY: 0, ...over};
    return placeSticker(box, position, o.size, o.minSize, o.offsetX, o.offsetY, 720);
  };

  it("is sized by the subject's height, never smaller than the minimum share of the frame height", () => {
    expect(place('Centre').h).toBe(50);
    expect(place('Centre', {minSize: 0.1}).h).toBe(72);
  });

  it('sits above the subject (Top), below it (Bottom), on its middle or its top corners', () => {
    expect(place('Top')).toEqual({x: 350, y: 75, h: 50});
    expect(place('Bottom')).toEqual({x: 350, y: 325, h: 50});
    expect(place('Centre')).toEqual({x: 350, y: 200, h: 50});
    expect(place('Top-left')).toEqual({x: 300, y: 100, h: 50});
    expect(place('Top-right')).toEqual({x: 400, y: 100, h: 50});
  });

  it("moves by its offsets in subject heights (y down)", () => {
    expect(place('Top', {offsetX: 0.5, offsetY: -0.25})).toEqual({x: 450, y: 25, h: 50});
  });
});

describe('the built-in shapes', () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`${name} is drawn inside its box (${shape.aspect}:1) and fills most of it`, () => {
      const calls: Call[] = [];
      const h = 100;
      const w = shape.aspect * h;
      shape.path(recorder(calls) as unknown as Path2DTarget, w, h);
      const pts = pathPoints(calls);
      expect(pts.length).toBeGreaterThan(2);
      const xs = pts.map(p => p[0]);
      const ys = pts.map(p => p[1]);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(-w / 2 - 1e-9);
      expect(Math.max(...xs)).toBeLessThanOrEqual(w / 2 + 1e-9);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(-h / 2 - 1e-9);
      expect(Math.max(...ys)).toBeLessThanOrEqual(h / 2 + 1e-9);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.8 * w);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.8 * h);
    });
  }

  it('are the eight of the design, each a style of the Sticker beside Your picture', () => {
    expect(Object.keys(SHAPES)).toEqual(['Star', 'Heart', 'Arrow', 'Speech bubble', 'Price tag', 'Sparkle', 'Crown', 'Label']);
    const style = EFFECT_SPECS.Sticker.params.style;
    expect(style.kind === 'choice' && style.options).toEqual([...Object.keys(SHAPES), 'Your picture']);
  });
});
type Path2DTarget = Parameters<(typeof SHAPES)['Star']['path']>[0];

describe('StickerEffect', () => {
  const W = 1280;
  const H = 720;
  const box = (x: number): {bounds: Bounds} => ({bounds: [[x, 200], [x + 100, 400]]});
  const picture = {width: 200, height: 100} as ImageBitmap;

  function draw(params: EffectParams, over: Partial<EffectFrameContext> = {}, trackMasks?: Array<{bounds: Bounds} | undefined>) {
    const calls: Call[] = [];
    const effect = new StickerEffect();
    effect.setParams(normalizeParams('Sticker', params));
    const masks = over.masks ?? [{bitmap: {} as never, bounds: box(500).bounds}];
    const tracklets = masks.map((_, i) => ({id: i + 1, masks: trackMasks ?? []}) as unknown as Tracklet);
    const context = {frameIndex: 2, totalFrames: 10, fps: 24, width: W, height: H, masks, maskColors: ['#00ff00'], frame: {} as ImageBitmap, actionPoint: null, images: new Map([[HASH, picture]]), ...over} as EffectFrameContext;
    effect.apply({ctx: recorder(calls)} as unknown as CanvasForm, context, tracklets);
    return calls;
  }

  it('draws nothing on a frame where its layer has no mask', () => {
    expect(draw({}, {masks: []})).toEqual([]);
  });

  it('draws the shape at its place: outline under the fill, in its colours, one save/restore', () => {
    const calls = draw({style: 'Heart', position: 'Top', size: 0.5, minSize: 0, color: '#ff0000', outline: '#000000', outlineWidth: 0.1, smooth: 0});
    // bbox 100 x 200 at (500, 200): 100 px tall, centred 50 px above its top
    expect(of(calls, 'translate')).toEqual([['translate', 550, 150]]);
    const names = calls.map(c => c[0]);
    expect(names.indexOf('stroke')).toBeLessThan(names.indexOf('fill'));
    expect(of(calls, 'fillStyle=')).toEqual([['fillStyle=', '#ff0000']]);
    expect(of(calls, 'strokeStyle=')).toEqual([['strokeStyle=', '#000000']]);
    expect(of(calls, 'lineWidth=')).toEqual([['lineWidth=', 20]]); // twice the outline: the fill covers its inner half
    expect(of(calls, 'save')).toHaveLength(1);
    expect(of(calls, 'restore')).toHaveLength(1);
  });

  it("follows the layer colour when its colour is 'layer', and leaves out the outline at width 0", () => {
    const calls = draw({style: 'Star', color: 'layer', outlineWidth: 0});
    expect(of(calls, 'fillStyle=')).toEqual([['fillStyle=', '#00ff00']]);
    expect(of(calls, 'stroke')).toEqual([]);
  });

  it('follows the smoothed box: the average of the tracked neighbours', () => {
    const track = [box(0), box(100), box(200), box(600), box(400)];
    const raw = draw({style: 'Star', position: 'Centre', smooth: 0}, {masks: [{bitmap: {} as never, bounds: box(200).bounds}]}, track);
    expect(of(raw, 'translate')).toEqual([['translate', 250, 300]]);
    const smooth = draw({style: 'Star', position: 'Centre', smooth: 2}, {masks: [{bitmap: {} as never, bounds: box(200).bounds}]}, track);
    expect(of(smooth, 'translate')).toEqual([['translate', 310, 300]]); // x0 (0+100+200+600+400)/5 = 260, centre +50
  });

  it('points the Arrow at the subject from where it sits', () => {
    const turn = (position: string) => of(draw({style: 'Arrow', position}), 'rotate')[0]?.[1] ?? 0;
    expect(turn('Top')).toBe(0);
    expect(turn('Bottom')).toBeCloseTo(Math.PI, 10);
    expect(turn('Top-left')).toBeCloseTo(-Math.PI / 4, 10);
    expect(turn('Top-right')).toBeCloseTo(Math.PI / 4, 10);
    expect(of(draw({style: 'Star', position: 'Top-left'}), 'rotate')).toEqual([]); // nothing else turns
  });

  it('draws Your picture at the sticker height in proportion, and nothing while it has no stored picture', () => {
    const calls = draw({style: 'Your picture', image: HASH, position: 'Centre', size: 0.5, minSize: 0});
    expect(of(calls, 'drawImage')).toEqual([['drawImage', picture, -100, -50, 200, 100]]);
    expect(of(calls, 'fill')).toEqual([]);
    expect(draw({style: 'Your picture', image: 'b'.repeat(64)})).toEqual([]); // missing in this browser
    expect(draw({style: 'Your picture'})).toEqual([]); // none picked
  });

  it('writes its label with fillText in Inter, widening the Label to fit and shrinking text past four heights', () => {
    const calls = draw({style: 'Label', text: 'SALE', position: 'Centre', size: 0.5, minSize: 0, textColor: '#112233'});
    const fills = of(calls, 'fillText');
    expect(fills).toEqual([['fillText', 'SALE', expect.any(Number), expect.any(Number)]]);
    expect(of(calls, 'fillStyle=').at(-1)).toEqual(['fillStyle=', '#112233']);
    expect(String(of(calls, 'font=')[0][1])).toMatch(/^700 [\d.]+px Inter, sans-serif$/);
    // 'SALE' is 40 px (recorder): the Label stays at its own 2:1, 200 px wide at 100 px tall
    const xs = pathPoints(calls).map(p => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(200, 6);
    // 24 characters, 240 px of text at 50 px tall: the Label caps at four heights and the text is drawn smaller
    const long = draw({style: 'Label', text: 'x'.repeat(24), position: 'Centre', size: 0.25, minSize: 0});
    const lx = pathPoints(long).map(p => p[0]);
    expect(Math.max(...lx) - Math.min(...lx)).toBeCloseTo(200, 6);
    expect(of(long, 'font=')).toHaveLength(2);
  });

  it('draws no text for a shape without a label, or an empty label', () => {
    expect(of(draw({style: 'Star', text: 'hi'}), 'fillText')).toEqual([]);
    expect(of(draw({style: 'Label', text: ''}), 'fillText')).toEqual([]);
  });

  it('draws the same calls for the same frame and settings (seek, replay, export)', () => {
    const p = {style: 'Speech bubble', text: 'Hi!', smooth: 3};
    const track = [box(0), box(30), box(10), box(50), box(20)];
    expect(draw(p, {}, track)).toEqual(draw(p, {}, track));
  });
});

describe('Sticker settings', () => {
  const clip = (params: EffectParams): EffectClip => ({id: 'c1', target: {kind: 'object', id: 1}, effect: 'Sticker', start: 0, end: 10, row: 0, phase: 0, params: normalizeParams('Sticker', params)} as EffectClip);

  it('starts as a star above the subject, lightly smoothed, with no picture and no label', () => {
    expect(normalizeParams('Sticker', {})).toMatchObject({style: 'Star', position: 'Top', image: '', text: '', smooth: 2});
  });

  it("keeps a picture as slice 3's key (the same picker, store and missing-picture count)", () => {
    expect(normalizeParams('Sticker', {style: 'Your picture', image: HASH}).image).toBe(HASH);
    expect(normalizeParams('Sticker', {image: '../etc/passwd'}).image).toBe('');
    const doc = {...EMPTY_DOC, clips: [clip({style: 'Your picture', image: HASH})]};
    expect(imageKeys(doc)).toEqual([HASH]);
    expect(clipsMissingImages(doc, new Set([HASH]))).toBe(1);
    // a Star that once had a picture does not draw it, so it is not missing one
    expect(clipsMissingImages({...EMPTY_DOC, clips: [clip({style: 'Star', image: HASH})]}, new Set([HASH]))).toBe(0);
  });

  it("cleans its label as the Title's text is cleaned: format characters dropped, two lines, 24 characters", () => {
    const p = normalizeParams('Sticker', {style: 'Label', text: 'a‮b​\none\ntwo'});
    expect(p.text).toBe('ab\none two');
    expect(String(normalizeParams('Sticker', {text: 'y'.repeat(40)}).text)).toHaveLength(24);
    expect(normalizeParams('Sticker', {text: '   '}).text).toBe('');
  });

  it('shows the label only on Label, Price tag and Speech bubble, the picture only on Your picture', () => {
    const shown = (key: string, style: string) => paramShown(EFFECT_SPECS.Sticker.params[key], normalizeParams('Sticker', {style}));
    expect(['Label', 'Price tag', 'Speech bubble', 'Star', 'Your picture'].map(s => shown('text', s))).toEqual([true, true, true, false, false]);
    expect(['Your picture', 'Star'].map(s => shown('image', s))).toEqual([true, false]);
    expect(['Your picture', 'Star'].map(s => shown('color', s))).toEqual([false, true]);
  });
});
