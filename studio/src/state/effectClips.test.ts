// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Acceptance checks U1, U2, U4, U5, U6 (vault 06-acceptance-test-plan), and
// the per-object behaviour objectEffects.test.ts pinned before clips.
import {afterEach, describe, expect, it, vi} from 'vitest';
import {EFFECT_SPECS} from '@/common/components/video/effects/EffectParamSpecs';
import {
  type EffectClip,
  type EffectDoc,
  EMPTY_DOC,
  activeClips,
  addClip,
  clipLines,
  clipTime,
  clipToEdit,
  loadEffectDoc,
  migrateV1,
  moveClip,
  newClip,
  newClipId,
  normalizeParams,
  parseEffectDoc,
  pickOnGroup,
  pickOnTarget,
  pruneClips,
  removeClip,
  sameTarget,
  saveEffectDoc,
  trimClip,
  updateClip,
} from './effectClips';

const A = {kind: 'object', id: 0} as const;
const B = {kind: 'object', id: 1} as const;
const BG = {kind: 'background'} as const;

function clip(over: Partial<EffectClip> = {}): EffectClip {
  return {id: 'c', target: A, effect: 'Outline', params: normalizeParams('Outline', {}), start: 10, end: 20, row: 0, phase: 0, ...over};
}

let n = 0;
/** Pick the way the effect buttons do: on the target's clip, or a new full-range one. */
function pick(doc: EffectDoc, target: typeof A | typeof B | typeof BG, effect: string, frame = 0): EffectDoc {
  return pickOnTarget(doc, {target, effect, frame, numFrames: 100, selectedId: null, newId: `p${n++}`}).doc;
}
const styleOf = (doc: EffectDoc, id: number) => doc.clips.find(c => c.target.kind === 'object' && c.target.id === id);

describe('normalizeParams (U1, U2)', () => {
  it('fills every default for an empty or malformed record', () => {
    expect(normalizeParams('Outline', undefined)).toEqual({width: 0.006, color: 'layer', opacity: 1, softness: 0.25, style: 'Outline'});
    expect(normalizeParams('Outline', 'x')).toEqual(normalizeParams('Outline', {}));
    expect(normalizeParams('Outline', [1, 2])).toEqual(normalizeParams('Outline', {}));
  });

  it("clamps, steps and type-checks every spec'd param, for every effect", () => {
    for (const [effect, spec] of Object.entries(EFFECT_SPECS)) {
      for (const [key, p] of Object.entries(spec.params)) {
        const at = (v: unknown) => normalizeParams(effect, {[key]: v})[key];
        for (const bad of [NaN, Infinity, null, {}, [], true, undefined]) {
          expect(at(bad), `${effect}.${key} ${String(bad)}`).toBe(p.default);
        }
        if (p.kind === 'number') {
          expect(at(p.min - 1)).toBe(p.min);
          expect(at(p.max + 1)).toBe(p.max);
          expect(at(String(p.max))).toBe(p.default); // strings are not numbers
          const mid = p.min + 3.4 * p.step;
          expect(at(mid)).toBeCloseTo(p.min + 3 * p.step, 10);
        } else if (p.kind === 'choice') {
          expect(at(p.options[p.options.length - 1])).toBe(p.options[p.options.length - 1]);
          expect(at('not a style')).toBe(p.default);
        } else {
          expect(at('#ABCDEF')).toBe('#abcdef');
          expect(at('#0f0')).toBe('#00ff00');
          expect(at('layer')).toBe('layer');
          expect(at('red')).toBe(p.default);
          expect(at('#12345')).toBe(p.default);
        }
      }
    }
  });

  it('rounds to the step without float noise, and drops unknown keys', () => {
    expect(normalizeParams('Outline', {width: 0.0123456, opacity: 0.333, extra: 5})).toEqual({
      width: 0.012,
      color: 'layer',
      opacity: 0.35,
      softness: 0.25,
      style: 'Outline',
    });
  });

  it("keeps an unknown effect's plain values for a newer build, dropping non-values", () => {
    expect(normalizeParams('FutureEffect', {a: 1, b: 'x', c: true, d: {}, e: [1]})).toEqual({a: 1, b: 'x', c: true});
  });
});

describe('activeClips (U4, U5)', () => {
  it('a clip [10, 20) is drawn on 10 and 19, not on 9 or 20', () => {
    const doc: EffectDoc = {version: 2, clips: [clip()]};
    expect(activeClips(doc, 9)).toEqual([]);
    expect(activeClips(doc, 10)).toHaveLength(1);
    expect(activeClips(doc, 19)).toHaveLength(1);
    expect(activeClips(doc, 20)).toEqual([]);
  });

  it('returns overlapping clips lowest row first', () => {
    const doc: EffectDoc = {version: 2, clips: [clip({id: 'top', row: 2}), clip({id: 'bg', target: BG, row: 0}), clip({id: 'low', row: 1})]};
    expect(activeClips(doc, 15).map(c => c.id)).toEqual(['bg', 'low', 'top']);
  });

  it('knows nothing of masks: a clip over frames where its object is absent is still active', () => {
    // the resolver takes only the doc and a frame; absence is the renderer's (no mask, nothing drawn)
    expect(activeClips({version: 2, clips: [clip({start: 0, end: 100})]}, 50)).toHaveLength(1);
  });
});

describe('clip time and phase (U6)', () => {
  it('t = (frame - start + phase) / fps, the same every time', () => {
    const c = clip({start: 10, phase: 5});
    expect(clipTime(c, 10, 25)).toBe(0.2);
    expect(clipTime(c, 35, 25)).toBe(1.2);
    expect(clipTime(c, 35, 25)).toBe(clipTime({...c}, 35, 25));
    expect(clipTime(c, 10, 0)).toBeCloseTo(5 / 30); // no fps known yet: 30
  });

  it('a move keeps length and phase, so the animation travels with the clip', () => {
    const doc = moveClip({version: 2, clips: [clip({phase: 3})]}, 'c', 40, 100);
    expect(doc.clips[0]).toMatchObject({start: 40, end: 50, phase: 3});
    expect(clipTime(doc.clips[0], 40, 30)).toBe(clipTime(clip({phase: 3}), 10, 30));
    // clamped inside the video, length kept
    expect(moveClip(doc, 'c', 95, 100).clips[0]).toMatchObject({start: 90, end: 100});
    expect(moveClip(doc, 'c', -5, 100).clips[0]).toMatchObject({start: 0, end: 10});
  });

  it('trimming the start later by d adds d to the phase: frames left in the clip look the same', () => {
    const before = clip({phase: 2});
    const doc = trimClip({version: 2, clips: [before]}, 'c', 'start', 14, 100);
    expect(doc.clips[0]).toMatchObject({start: 14, end: 20, phase: 6});
    for (const f of [14, 17, 19]) {
      expect(clipTime(doc.clips[0], f, 30)).toBe(clipTime(before, f, 30));
    }
    // and back out again restores it exactly
    expect(trimClip(doc, 'c', 'start', 10, 100).clips[0]).toMatchObject({start: 10, phase: 2});
  });

  it('trimming the end leaves the phase; a clip keeps at least one frame and stays inside the video', () => {
    const doc: EffectDoc = {version: 2, clips: [clip()]};
    expect(trimClip(doc, 'c', 'end', 15, 100).clips[0]).toMatchObject({start: 10, end: 15, phase: 0});
    expect(trimClip(doc, 'c', 'end', 3, 100).clips[0]).toMatchObject({end: 11});
    expect(trimClip(doc, 'c', 'end', 500, 100).clips[0]).toMatchObject({end: 100});
    expect(trimClip(doc, 'c', 'start', 50, 100).clips[0]).toMatchObject({start: 19, end: 20, phase: 9});
  });
});

describe('adding, editing and removing clips', () => {
  it('a new clip starts at the playhead, lasts 3 s, and stops at the video end (Q3)', () => {
    const c = newClip({id: 'n', target: A, effect: 'Outline', frame: 30, numFrames: 300, fps: 30});
    expect(c).toMatchObject({start: 30, end: 120, phase: 0});
    expect(newClip({id: 'n', target: A, effect: 'Outline', frame: 280, numFrames: 300, fps: 30})).toMatchObject({start: 280, end: 300});
    expect(newClip({id: 'n', target: A, effect: 'Outline', frame: 999, numFrames: 300, fps: 30})).toMatchObject({start: 299, end: 300});
    expect(c.params).toEqual(normalizeParams('Outline', {}));
  });

  it("a new clip goes on top of its own target's clips only", () => {
    let doc = addClip(EMPTY_DOC, newClip({id: 'a1', target: A, effect: 'Outline', frame: 0, numFrames: 300, fps: 30}));
    doc = addClip(doc, newClip({id: 'b1', target: B, effect: 'Outline', frame: 0, numFrames: 300, fps: 30}));
    doc = addClip(doc, newClip({id: 'a2', target: A, effect: 'Cutout', frame: 0, numFrames: 300, fps: 30}));
    doc = addClip(doc, newClip({id: 'g1', target: BG, effect: 'BackgroundBlur', frame: 0, numFrames: 300, fps: 30}));
    expect(Object.fromEntries(doc.clips.map(c => [c.id, c.row]))).toEqual({a1: 0, b1: 0, a2: 1, g1: 0});
  });

  it('names new clips c1, c2, ... past every id in the doc', () => {
    expect(newClipId(EMPTY_DOC)).toBe('c1');
    expect(newClipId({version: 2, clips: [clip({id: 'c7'}), clip({id: 'v1-9'}), clip({id: 'c2'})]})).toBe('c8');
  });

  it('updates settings (validated) and switches effects (to the new defaults)', () => {
    let doc: EffectDoc = {version: 2, clips: [clip()]};
    doc = updateClip(doc, 'c', {params: {...doc.clips[0].params, width: 9}});
    expect(doc.clips[0].params.width).toBe(0.05);
    doc = updateClip(doc, 'c', {effect: 'Cutout'});
    expect(doc.clips[0]).toMatchObject({effect: 'Cutout', params: {style: 'Unchanged'}, start: 10, end: 20});
  });

  it('removes a clip, and pruning drops removed objects but never the background', () => {
    const doc: EffectDoc = {version: 2, clips: [clip({id: 'a'}), clip({id: 'b', target: B}), clip({id: 'g', target: BG})]};
    expect(removeClip(doc, 'a').clips.map(c => c.id)).toEqual(['b', 'g']);
    expect(pruneClips(doc, [1]).clips.map(c => c.id)).toEqual(['b', 'g']);
    expect(pruneClips(doc, [0, 1])).toBe(doc);
  });

  it('an effect pick edits the selected clip, else the top one on the playhead, never one off the playhead', () => {
    const doc: EffectDoc = {
      version: 2,
      clips: [clip({id: 'low', row: 0, start: 0, end: 50}), clip({id: 'high', row: 1, start: 60, end: 90}), clip({id: 'other', target: B})],
    };
    expect(clipToEdit(doc, A, 10, null)?.id).toBe('low');
    expect(clipToEdit(doc, A, 70, null)?.id).toBe('high');
    expect(clipToEdit(doc, A, 55, null)).toBeNull(); // between clips: nothing visible to edit
    expect(clipToEdit(doc, A, 55, 'low')?.id).toBe('low'); // unless it is selected
    expect(clipToEdit(doc, A, 70, 'low')?.id).toBe('low');
    expect(clipToEdit(doc, A, 70, 'other')?.id).toBe('high'); // selected, but not this layer's
    expect(clipToEdit(doc, BG, 70, null)).toBeNull();
  });

  it('a pick off every clip of a layer adds a clip at the playhead; on a layer with none, over the whole video', () => {
    const doc: EffectDoc = {version: 2, clips: [clip({id: 'a', start: 0, end: 50})]};
    const off = pickOnTarget(doc, {target: A, effect: 'Burst', frame: 60, numFrames: 300, fps: 10, selectedId: null, newId: 'n'});
    expect(off.doc.clips.find(c => c.id === 'n')).toMatchObject({start: 60, end: 90, row: 1, effect: 'Burst'});
    expect(off.doc.clips.find(c => c.id === 'a')).toBe(doc.clips[0]); // the clip off the playhead is untouched
    const fresh = pickOnTarget(doc, {target: B, effect: 'Burst', frame: 60, numFrames: 300, fps: 10, selectedId: null, newId: 'm'});
    expect(fresh.doc.clips.find(c => c.id === 'm')).toMatchObject({start: 0, end: 300});
  });

  it("a group pick treats every member alike: its clip on the playhead changes, else a 3 s clip is added there, never the selection's", () => {
    const C = {kind: 'object', id: 2} as const;
    const doc: EffectDoc = {
      version: 2,
      clips: [clip({id: 'a', target: A, start: 50, end: 80, effect: 'Burst', params: normalizeParams('Burst', {style: 'Colour rays'})}), clip({id: 'c', target: C, start: 0, end: 20})],
    };
    const r = pickOnGroup(doc, {members: [0, 1, 2], effect: 'Burst', frame: 60, numFrames: 300, fps: 10});
    expect([r.changed, r.added]).toEqual([1, 2]);
    const style = r.doc.clips.find(c => c.id === 'a')!.params.style;
    expect(style).toBe('White rays'); // the same effect again: its next style, for every member
    for (const t of [B, C]) {
      expect(r.doc.clips.filter(c => sameTarget(c.target, t) && c.start === 60)).toEqual([
        expect.objectContaining({end: 90, effect: 'Burst', params: expect.objectContaining({style})}),
      ]);
    }
    expect(r.doc.clips.find(c => c.id === 'c')).toBe(doc.clips[1]); // C's clip off the playhead is untouched
    expect(new Set(r.doc.clips.map(c => c.id)).size).toBe(r.doc.clips.length);
  });
});

describe('per-object picks (the behaviour objectEffects.test.ts pinned)', () => {
  it("Nate's sequence: focus A, set Original, focus B: A is still Original, also after B changes", () => {
    let doc = pick(EMPTY_DOC, A, 'Cutout');
    expect(styleOf(doc, 0)).toMatchObject({effect: 'Cutout', params: {style: 'Unchanged'}, start: 0, end: 100});
    expect(styleOf(doc, 1)).toBeUndefined(); // B untouched: shown as Overlay
    doc = pick(doc, B, 'PixelateMask');
    expect(styleOf(doc, 0)?.effect).toBe('Cutout');
    expect(styleOf(doc, 1)).toMatchObject({effect: 'PixelateMask', params: {style: 'Fine'}});
  });

  it('picking the current effect again cycles its styles, for that object only, and wraps', () => {
    let doc = pick(EMPTY_DOC, A, 'Burst');
    doc = pick(doc, B, 'Burst');
    doc = pick(pick(doc, A, 'Burst'), A, 'Burst');
    expect(styleOf(doc, 0)?.params.style).toBe('Colour wedges');
    expect(styleOf(doc, 1)?.params.style).toBe('Colour rays');
    doc = pick(pick(doc, A, 'Burst'), A, 'Burst');
    expect(styleOf(doc, 0)?.params.style).toBe('Colour rays');
    expect(doc.clips).toHaveLength(2); // picks edit, never pile up
  });

  it('a background pick is a persisted clip too (Q7)', () => {
    let doc = pick(EMPTY_DOC, BG, 'BackgroundBlur');
    doc = pick(doc, BG, 'BackgroundBlur');
    expect(doc.clips).toEqual([expect.objectContaining({target: BG, effect: 'BackgroundBlur', params: {style: 'Medium'}})]);
    expect(parseEffectDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it('Outline cycles Outline -> Glow (applying the preset) -> Outline', () => {
    let doc = pick(EMPTY_DOC, A, 'Outline');
    doc = pick(doc, A, 'Outline');
    expect(styleOf(doc, 0)?.params).toEqual({width: 0.02, color: 'layer', opacity: 0.9, softness: 0.8, style: 'Glow'});
    doc = pick(doc, A, 'Outline');
    expect(styleOf(doc, 0)?.params).toMatchObject({style: 'Outline', softness: 0.25});
  });
});

describe('storage (U1)', () => {
  it('migrates a v1 map to one full-range clip per object, the style matching the old variant', () => {
    const doc = migrateV1({'2': {name: 'Cutout', variant: 1}, '5': {name: 'EraseForeground', variant: 2}, '7': {name: 'Burst', variant: 9}}, 120);
    expect(doc.clips).toEqual([
      {id: 'v1-2', target: {kind: 'object', id: 2}, effect: 'Cutout', params: {style: 'More contrast'}, start: 0, end: 120, row: 0, phase: 0},
      {id: 'v1-5', target: {kind: 'object', id: 5}, effect: 'EraseForeground', params: {style: 'Green'}, start: 0, end: 120, row: 0, phase: 0},
      {id: 'v1-7', target: {kind: 'object', id: 7}, effect: 'Burst', params: {style: 'White rays'}, start: 0, end: 120, row: 0, phase: 0},
    ]);
  });

  it('reads a v1 map defensively, keeping an unknown effect as it was', () => {
    const doc = migrateV1({'2': {name: 'Cutout'}, x: {name: 'y'}, '3': 'bad', '4': {variant: 1}, '6': {name: 'Gone', variant: 3}}, 50);
    expect(doc.clips.map(c => [c.id, c.effect, c.params])).toEqual([
      ['v1-2', 'Cutout', {style: 'Unchanged'}],
      ['v1-6', 'Gone', {variant: 3}],
    ]);
    expect(migrateV1(null, 50)).toEqual(EMPTY_DOC);
    expect(migrateV1('x', 50)).toEqual(EMPTY_DOC);
  });

  it('reads a stored v2 doc, dropping malformed clips and validating settings', () => {
    const good = clip({id: 'ok', params: {width: 1, color: 'blue', bogus: 1}});
    const doc = parseEffectDoc({
      version: 2,
      clips: [
        good,
        {...good}, // duplicate id
        {...good, id: 'neg', start: -1},
        {...good, id: 'empty', start: 5, end: 5},
        {...good, id: 'frac', start: 1.5},
        {...good, id: 'tgt', target: {kind: 'object', id: 'x'}},
        {...good, id: 'fx', effect: 3},
        null,
        {...good, id: 'raw', effect: 'Future', params: {k: 'v'}, row: 'x', phase: NaN, target: {kind: 'background'}},
      ],
    });
    expect(doc.clips.map(c => c.id)).toEqual(['ok', 'raw']);
    expect(doc.clips[0].params).toEqual({width: 0.05, color: 'layer', opacity: 1, softness: 0.25, style: 'Outline'});
    expect(doc.clips[1]).toMatchObject({effect: 'Future', params: {k: 'v'}, row: 0, phase: 0, target: {kind: 'background'}});
    expect(parseEffectDoc({version: 1, clips: []})).toEqual(EMPTY_DOC);
    expect(parseEffectDoc(null)).toEqual(EMPTY_DOC);
  });
});

describe("the session's load, prune and save (useStudioSession's wiring)", () => {
  const V1 = 'sam-ui-studio:effects:juggle.mp4';
  const V2 = 'sam-ui-studio:effects:v2:juggle.mp4';
  function storage(entries: Record<string, unknown>) {
    const store = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
    const setItem = vi.fn((k: string, v: string) => store.set(k, v));
    vi.stubGlobal('window', {localStorage: {getItem: (k: string) => store.get(k) ?? null, setItem}});
    return {store, setItem};
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('migrates a v1 map once the frame count is known, prunes a deleted layer, and writes only the v2 key', () => {
    const v1 = {'1': {name: 'Cutout', variant: 3}, '2': {name: 'Burst', variant: 1}};
    const {store, setItem} = storage({[V1]: v1});
    // as the hook does: load, prune to the layers that still exist, save
    const doc = pruneClips(loadEffectDoc('juggle.mp4', 247), [1]);
    expect(doc.clips).toEqual([
      {id: 'v1-1', target: {kind: 'object', id: 1}, effect: 'Cutout', params: {style: 'Sepia'}, start: 0, end: 247, row: 0, phase: 0},
    ]);
    saveEffectDoc('juggle.mp4', doc);
    expect(setItem.mock.calls.map(([k]) => k)).toEqual([V2]);
    expect(store.get(V1)).toBe(JSON.stringify(v1)); // an older build keeps its copy
    // the next load reads v2, not the v1 map
    expect(loadEffectDoc('juggle.mp4', 247)).toEqual(doc);
  });

  it('loads a stored v2 doc as it is (validated), ignoring a leftover v1 map', () => {
    const bg = clip({id: 'b', target: BG, effect: 'Original', params: {style: 'Dimmed'}, start: 0, end: 72});
    storage({[V2]: {version: 2, clips: [bg, {id: 'bad'}]}, [V1]: {'1': {name: 'Cutout', variant: 0}}});
    expect(loadEffectDoc('juggle.mp4', 247)).toEqual({version: 2, clips: [bg]});
  });

  it('starts empty with no store, or with storage blocked', () => {
    storage({});
    expect(loadEffectDoc('juggle.mp4', 247)).toEqual(EMPTY_DOC);
    vi.stubGlobal('window', {});
    expect(loadEffectDoc('juggle.mp4', 247)).toEqual(EMPTY_DOC);
    expect(() => saveEffectDoc('juggle.mp4', EMPTY_DOC)).not.toThrow();
  });
});

describe('clipLines (timeline band layout)', () => {
  it('stacks overlapping clips with the upper row higher, and lets clips that do not overlap share a line', () => {
    const doc = [
      clip({id: 'base', row: 0, start: 0, end: 100}),
      clip({id: 'mid', row: 1, start: 10, end: 30}),
      clip({id: 'top', row: 2, start: 50, end: 70}),
      clip({id: 'over', row: 3, start: 20, end: 60}),
    ];
    const {line, count} = clipLines(doc);
    expect(Object.fromEntries(line)).toEqual({over: 0, top: 1, mid: 1, base: 2});
    expect(count).toBe(3);
    expect(clipLines([clip({id: 'a', start: 0, end: 10}), clip({id: 'b', row: 1, start: 10, end: 20})]).count).toBe(1);
    expect(clipLines([]).count).toBe(0);
  });
});
