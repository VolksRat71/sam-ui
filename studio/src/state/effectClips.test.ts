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
  cleanText,
  clipLines,
  clipTime,
  clipToEdit,
  duplicateClip,
  graphemes,
  loadEffectDoc,
  migrateV1,
  moveClip,
  newClip,
  newClipId,
  normalizeParams,
  overlapNeighbour,
  parseEffectDoc,
  pickOnGroup,
  pickOnTarget,
  pruneClips,
  removeClip,
  reorderClip,
  sameTarget,
  saveEffectDoc,
  splitClip,
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
    expect(normalizeParams('Outline', undefined)).toEqual({width: 0.006, color: 'layer', opacity: 1, softness: 0.25, wobble: 0.008, boil: 8, style: 'Outline'});
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
        } else if (p.kind === 'image') {
          const hash = 'ab'.repeat(32);
          expect(at(hash)).toBe(hash);
          expect(at('')).toBe('');
          for (const bad of ['AB'.repeat(32), 'ab'.repeat(31), `${'ab'.repeat(32)}0`, '../../etc/passwd', 'layer']) {
            expect(at(bad), bad).toBe('');
          }
        } else if (p.kind === 'text') {
          expect(at(' Typed ')).toBe('Typed');
          expect(at('x'.repeat(p.maxLength + 5))).toHaveLength(p.maxLength);
          expect(at('\u0000 ')).toBe(p.default);
        } else {
          expect(at('#ABCDEF')).toBe('#abcdef');
          expect(at('#0f0')).toBe('#00ff00');
          expect(at('layer')).toBe(p.followsLayer === false ? p.default : 'layer'); // a background colour cannot follow a layer
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
      wobble: 0.008,
      boil: 8,
      style: 'Outline',
    });
  });

  it("keeps an unknown effect's plain values for a newer build, dropping non-values", () => {
    expect(normalizeParams('FutureEffect', {a: 1, b: 'x', c: true, d: {}, e: [1]})).toEqual({a: 1, b: 'x', c: true});
  });
});

describe("Title's text setting (cleanText)", () => {
  const clean = (v: unknown) => cleanText(v, 80, 3);

  it('keeps typed text, trimmed, with up to three lines', () => {
    expect(clean('  Hello world  ')).toBe('Hello world');
    expect(clean('One\nTwo\nThree')).toBe('One\nTwo\nThree');
    expect(clean('Win\r\nOld Mac\rEnd')).toBe('Win\nOld Mac\nEnd');
    expect(clean('<b>not markup</b> & "quotes"')).toBe('<b>not markup</b> & "quotes"'); // fillText draws it as typed
  });

  it('joins lines past the third onto it', () => {
    expect(clean('a\nb\nc\nd\ne')).toBe('a\nb\nc d e');
  });

  it('drops control characters but line breaks; a tab is a space', () => {
    expect(clean('a\u0000b\u0007c\u001bd\u007fe\u0085f')).toBe('abcdef');
    expect(clean('a\tb')).toBe('a b');
  });

  it('drops invisible format characters (bidi overrides, zero-width spaces) but keeps the joiner emoji need; Unicode line separators break lines', () => {
    expect(clean('a\u202eb\u202dc\u2066d\u2069e\u200bf\ufeffg\u00adh')).toBe('abcdefgh');
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
    expect(clean(`hi ${family}`)).toBe(`hi ${family}`);
    expect(clean('one\u2028two\u2029three')).toBe('one\ntwo\nthree');
  });

  it('keeps the non-joiner (Persian, Indic) and subdivision flags; drops stray tag characters', () => {
    expect(clean('\u0645\u06cc\u200c\u0631\u0648\u0645')).toBe('\u0645\u06cc\u200c\u0631\u0648\u0645'); // "می‌روم"
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    expect(clean(`go ${england}`)).toBe(`go ${england}`);
    expect(clean('a\u{E0067}b\u{E007F}c\u{1F3F4}')).toBe('abc\u{1F3F4}'); // tags outside a flag; a plain black flag stays
  });

  it('counts and cuts in characters as people see them (graphemes), never inside one', () => {
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}'; // 8 UTF-16 units, one character
    const flag = '\u{1F1EF}\u{1F1F5}';
    expect(graphemes(`a${family}${flag}e\u0301`)).toEqual(['a', family, flag, 'e\u0301']);
    expect(clean('x'.repeat(100))).toBe('x'.repeat(80));
    expect(clean(family.repeat(85))).toBe(family.repeat(80));
    expect(clean(`${'x'.repeat(79)}${family}${flag}`)).toBe(`${'x'.repeat(79)}${family}`);
  });

  it("is '' for nothing left or not a string, which normalizeParams turns into the default", () => {
    expect(['', '   ', '\n\n', '\u0000', 42, null, undefined, {}].map(clean)).toEqual(Array(8).fill(''));
    expect(normalizeParams('Title', {text: '  \n '}).text).toBe('Your title');
    expect(normalizeParams('Title', {text: 7}).text).toBe('Your title');
    expect(normalizeParams('Title', {text: ' Behind\nyou '}).text).toBe('Behind\nyou');
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

  it("a group pick treats every member like a one-layer pick: its clip on the playhead changes, else a 3 s clip is added there (whole video if it has none), never the selection's", () => {
    const C = {kind: 'object', id: 2} as const;
    const doc: EffectDoc = {
      version: 2,
      clips: [clip({id: 'a', target: A, start: 50, end: 80, effect: 'Burst', params: normalizeParams('Burst', {style: 'Colour rays'})}), clip({id: 'c', target: C, start: 0, end: 20})],
    };
    const r = pickOnGroup(doc, {members: [0, 1, 2], effect: 'Burst', frame: 60, numFrames: 300, fps: 10});
    expect([r.changed, r.added]).toEqual([1, 2]);
    const style = r.doc.clips.find(c => c.id === 'a')!.params.style;
    expect(style).toBe('White rays'); // the same effect again: its next style, for every member
    expect(r.doc.clips.filter(c => sameTarget(c.target, C) && c.start === 60)).toEqual([
      expect.objectContaining({end: 90, effect: 'Burst', params: expect.objectContaining({style})}),
    ]);
    expect(r.doc.clips.filter(c => sameTarget(c.target, B))).toEqual([ // B had no clips: the whole video, as a one-layer pick
      expect.objectContaining({start: 0, end: 300, effect: 'Burst', params: expect.objectContaining({style})}),
    ]);
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
    expect(doc.clips).toEqual([expect.objectContaining({target: BG, effect: 'BackgroundBlur', params: {radius: 0.008, style: 'Medium'}})]);
    expect(parseEffectDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it('Outline cycles Outline -> Glow (applying the preset) -> Scribble -> Outline', () => {
    let doc = pick(EMPTY_DOC, A, 'Outline');
    doc = pick(doc, A, 'Outline');
    expect(styleOf(doc, 0)?.params).toEqual({width: 0.02, color: 'layer', opacity: 0.9, softness: 0.8, wobble: 0.008, boil: 8, style: 'Glow'});
    doc = pick(doc, A, 'Outline');
    expect(styleOf(doc, 0)?.params).toMatchObject({style: 'Scribble', width: 0.005, softness: 0.25, opacity: 1});
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
    expect(doc.clips[0].params).toEqual({width: 0.05, color: 'layer', opacity: 1, softness: 0.25, wobble: 0.008, boil: 8, style: 'Outline'});
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

describe('split, duplicate and stack order (slice 2)', () => {
  const ids = (doc: EffectDoc) => doc.clips.map(c => c.id);
  const rows = (doc: EffectDoc) => Object.fromEntries(doc.clips.map(c => [c.id, c.row]));

  it('a split keeps every frame as it was: the right part continues the animation', () => {
    const whole = clip({start: 10, end: 40, phase: 4, row: 2, effect: 'Noisy', params: normalizeParams('Noisy', {})});
    const doc = splitClip({version: 2, clips: [clip({id: 'x', target: B}), whole]}, 'c', 25, 'r');
    expect(ids(doc)).toEqual(['x', 'c', 'r']);
    const [left, right] = [doc.clips[1], doc.clips[2]];
    expect(left).toEqual({...whole, end: 25});
    expect(right).toEqual({...whole, id: 'r', start: 25, phase: 4 + 15});
    for (let f = 10; f < 40; f++) {
      const part = f < 25 ? left : right;
      expect(activeClips(doc, f).filter(c => sameTarget(c.target, A))).toEqual([part]);
      expect(clipTime(part, f, 24)).toBe(clipTime(whole, f, 24));
    }
  });

  it('splits only strictly inside the clip, and names the right part c<n> by default', () => {
    const doc: EffectDoc = {version: 2, clips: [clip({id: 'c3'})]};
    for (const f of [9, 10, 20, 21, 10.4]) {
      expect(splitClip(doc, 'c3', f)).toBe(doc);
    }
    expect(splitClip(doc, 'nope', 15)).toBe(doc);
    expect(splitClip(doc, 'c3', 10.6).clips.map(c => [c.id, c.start, c.end])).toEqual([
      ['c3', 10, 11],
      ['c4', 11, 20],
    ]);
    expect(splitClip(doc, 'c3', 19).clips[1]).toMatchObject({start: 19, end: 20, phase: 9}); // a one-frame right part
  });

  it('a duplicate goes right after the original on its row, from the start of its animation', () => {
    const orig = clip({start: 10, end: 20, phase: 7, row: 1});
    const doc = duplicateClip({version: 2, clips: [clip({id: 'low', row: 0, start: 0, end: 100}), orig]}, 'c', 'd', 100);
    expect(doc.clips.at(-1)).toEqual({...orig, id: 'd', start: 20, end: 30, phase: 0});
    expect(doc.clips.slice(0, 2)).toEqual([expect.objectContaining({id: 'low'}), orig]);
    // it ends exactly at the video end: still fits
    expect(duplicateClip({version: 2, clips: [orig]}, 'c', 'd', 30).clips[1]).toMatchObject({start: 20, end: 30, row: 1});
  });

  it("with no room after it (the video's end, or a clip on that row), the duplicate goes on a new top row at the same frames", () => {
    const orig = clip({start: 10, end: 20, phase: 3});
    expect(duplicateClip({version: 2, clips: [orig]}, 'c', 'd', 29).clips[1]).toEqual({...orig, id: 'd', phase: 0, row: 1});
    const blocked: EffectDoc = {version: 2, clips: [orig, clip({id: 'next', start: 29, end: 50}), clip({id: 'top', row: 3, start: 60, end: 70})]};
    expect(duplicateClip(blocked, 'c', 'd', 100).clips.at(-1)).toMatchObject({start: 10, end: 20, row: 4, phase: 0});
    // another row, or another layer, does not block it
    const free: EffectDoc = {version: 2, clips: [orig, clip({id: 'up', row: 1, start: 20, end: 30}), clip({id: 'b', target: B, start: 20, end: 30})]};
    expect(duplicateClip(free, 'c', 'd', 100).clips.at(-1)).toMatchObject({start: 20, end: 30, row: 0});
    expect(duplicateClip(free, 'gone', 'd', 100)).toBe(free);
  });

  it("moves a clip up or down its own layer's stack, past the nearest clip it overlaps", () => {
    const doc: EffectDoc = {
      version: 2,
      clips: [clip({id: 'a', row: 0}), clip({id: 'b', row: 1}), clip({id: 'other', target: B, row: 0}), clip({id: 'c', row: 2})],
    };
    expect(rows(reorderClip(doc, 'a', 'up'))).toEqual({a: 1, b: 0, other: 0, c: 2});
    expect(rows(reorderClip(doc, 'c', 'down'))).toEqual({a: 0, b: 2, other: 0, c: 1});
    expect(reorderClip(doc, 'c', 'down').clips[0]).toBe(doc.clips[0]); // clips that keep their row keep their object
    expect(reorderClip(doc, 'c', 'up')).toBe(doc); // at the top
    expect(reorderClip(doc, 'a', 'down')).toBe(doc); // at the bottom
    expect(reorderClip(doc, 'other', 'up')).toBe(doc); // alone on its layer
    expect(reorderClip(doc, 'nope', 'up')).toBe(doc);
    // the move changes which of two overlapping clips draws on top
    expect(activeClips(reorderClip(doc, 'b', 'up'), 15).filter(x => sameTarget(x.target, A)).map(x => x.id)).toEqual(['a', 'c', 'b']);
  });

  it('skips clips it does not overlap, so every move changes what is drawn; with none to pass, nothing changes', () => {
    // low [0, 50) and top [0, 50) overlap; mid [60, 90) overlaps neither
    const doc: EffectDoc = {
      version: 2,
      clips: [clip({id: 'low', row: 0, start: 0, end: 50}), clip({id: 'mid', row: 1, start: 60, end: 90}), clip({id: 'top', row: 2, start: 0, end: 50})],
    };
    expect(overlapNeighbour(doc, 'top', 'down')?.id).toBe('low');
    expect(rows(reorderClip(doc, 'top', 'down'))).toEqual({top: 0, low: 1, mid: 2}); // past mid and low; mid keeps its place above low
    expect(rows(reorderClip(doc, 'low', 'up'))).toEqual({mid: 0, top: 1, low: 2});
    expect(activeClips(reorderClip(doc, 'top', 'down'), 10).map(c => c.id)).toEqual(['top', 'low']);
    expect(overlapNeighbour(doc, 'mid', 'up')).toBeNull();
    expect(reorderClip(doc, 'mid', 'up')).toBe(doc);
    expect(reorderClip(doc, 'mid', 'down')).toBe(doc);
    expect(overlapNeighbour(doc, 'nope', 'up')).toBeNull();
  });

  it('keeps rows dense: gaps (after a removal) and shared rows (after a split) become 0..n-1', () => {
    const gappy: EffectDoc = {version: 2, clips: [clip({id: 'a', row: 0}), clip({id: 'b', row: 4}), clip({id: 'c', row: 7})]};
    expect(rows(reorderClip(gappy, 'a', 'up'))).toEqual({a: 1, b: 0, c: 2});
    // after a split the parts share a row; the clip over both moves under the one it overlaps
    const split = splitClip({version: 2, clips: [clip({id: 'top', row: 1, start: 0, end: 100}), clip({id: 'c'})]}, 'c', 15, 'r');
    expect(rows(reorderClip(split, 'top', 'down'))).toEqual({top: 1, c: 0, r: 2});
    expect(rows(reorderClip(split, 'c', 'up'))).toEqual({top: 1, c: 2, r: 0});
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

  it("shows on top the clip drawn on top when a split's parts or a duplicate overlap on one row", () => {
    const base: EffectDoc = {version: 2, clips: [clip({id: 'c', start: 0, end: 60})]};
    const overlapped = [
      trimClip(splitClip(base, 'c', 30, 'r'), 'r', 'start', 20, 100), // the right part's start back over the left part
      trimClip(splitClip(base, 'c', 30, 'r'), 'c', 'end', 40, 100), // the left part's end over the right part
      moveClip(duplicateClip(base, 'c', 'r', 200), 'r', 25, 200), // the copy moved back over the original
    ];
    for (const doc of overlapped) {
      expect(doc.clips.map(c => c.row)).toEqual([0, 0]);
      const drawnTop = activeClips(doc, 35).at(-1)!.id;
      const {line} = clipLines(doc.clips);
      const shownTop = [...line].sort((a, b) => a[1] - b[1])[0][0];
      expect(drawnTop).toBe('r');
      expect(shownTop).toBe(drawnTop);
      expect(clipToEdit(doc, A, 35, null)?.id).toBe(drawnTop); // an effect pick edits the one on top too
    }
  });
});
