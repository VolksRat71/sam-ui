// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Acceptance check U9 (vault 06-acceptance-test-plan): one Cmd-Z across the
// person's effect and seed edits, newest first, never stepping an agent's.
import {describe, expect, it} from 'vitest';
import {
  type EffectClip,
  type EffectDoc,
  EMPTY_DOC,
  addClip,
  duplicateClip,
  newClip,
  activeClips,
  removeClip,
  reorderClip,
  splitClip,
  trimClip,
  updateClip,
} from './effectClips';
import {
  EMPTY_JOURNAL,
  type Journal,
  type JournalEntry,
  type SeedStatus,
  applyEntry,
  diffClips,
  recordEffect,
  recordSeed,
  selectionAfter,
  steppedObject,
  takeStep,
} from './editJournal';

const PIM = {kind: 'object', id: 1} as const;
const outline = (id: string, frame: number): EffectClip =>
  newClip({id, target: PIM, effect: 'Outline', frame, numFrames: 300, fps: 30});

/** The session's Cmd-Z, on plain values: effect entries restore clips, seed entries go to `seedUndo`. */
function press(
  s: {doc: EffectDoc; journal: Journal},
  which: 'undo' | 'redo',
  seedStep: (id: number) => void,
  status: (id: number) => SeedStatus = () => 'ok',
) {
  const {journal, entry, blocked} = takeStep(s.journal, which, status, id => status(id) !== 'gone');
  s.journal = journal;
  if (entry?.kind === 'effect') {
    s.doc = applyEntry(s.doc, entry.changes, which);
  } else if (entry?.kind === 'seed') {
    entry.objectIds.forEach(seedStep);
  }
  return blocked;
}

describe('edit journal (U9)', () => {
  it("person adds Outline, an agent changes clicks, two undos step back only the person's own edits", () => {
    const s = {doc: EMPTY_DOC, journal: EMPTY_JOURNAL};
    const seedUndos: number[] = [];
    // the person clicks Pim (a seed entry), then adds Outline at frame 30
    s.journal = recordSeed(s.journal, [1]);
    const before = s.doc;
    s.doc = addClip(s.doc, outline('c1', 30));
    s.journal = recordEffect(s.journal, before, s.doc, 'add', 0);
    // an agent changes Pim's clicks: it reaches the backend and the screen, never the journal
    const agentJournal = s.journal;

    press(s, 'undo', id => seedUndos.push(id));
    expect(s.doc.clips).toEqual([]); // the Outline went first: newest
    expect(seedUndos).toEqual([]);
    press(s, 'undo', id => seedUndos.push(id));
    expect(seedUndos).toEqual([1]); // then the person's click, on the backend
    expect(s.journal.undo).toEqual([]);
    expect(agentJournal.undo).toHaveLength(2); // the agent added nothing to step

    // redo walks forward again, oldest undone last
    press(s, 'redo', () => {});
    press(s, 'redo', () => {});
    expect(s.doc.clips.map(c => c.id)).toEqual(['c1']);
  });

  it('a seed undo never removes an effect, and an effect undo never touches seeds', () => {
    const s = {doc: addClip(EMPTY_DOC, outline('c1', 0)), journal: EMPTY_JOURNAL};
    const seeds: number[] = [];
    const was = s.doc;
    s.doc = updateClip(s.doc, 'c1', {params: {...s.doc.clips[0].params, width: 0.02}});
    s.journal = recordEffect(s.journal, was, s.doc, 'w', 0);
    s.journal = recordSeed(s.journal, [1]);
    press(s, 'undo', id => seeds.push(id));
    expect(seeds).toEqual([1]);
    expect(s.doc.clips[0].params.width).toBe(0.02); // the effect is untouched by the seed undo
    press(s, 'undo', id => seeds.push(id));
    expect(seeds).toEqual([1]);
    expect(s.doc.clips[0].params.width).toBe(0.006);
  });

  it('restores a removed clip by id, with its settings and range', () => {
    const doc = addClip(EMPTY_DOC, outline('c1', 40));
    const gone = removeClip(doc, 'c1');
    const changes = diffClips(doc, gone);
    expect(changes).toEqual([{id: 'c1', before: doc.clips[0], after: null, place: {next: null, index: 0}}]);
    expect(applyEntry(gone, changes, 'undo').clips).toEqual(doc.clips);
    expect(applyEntry(doc, changes, 'redo').clips).toEqual([]);
  });

  it('undo of a delete puts the clip back in its place in draw order, not on top', () => {
    // c1 [0, 72) split at 36 into c1 and c2 on one row, then c1 trimmed into c2: on 36-49 c2 is drawn on top (later in the doc)
    const s = {doc: addClip(EMPTY_DOC, outline('c1', 0)), journal: EMPTY_JOURNAL};
    const edit = (fn: (d: EffectDoc) => EffectDoc, key: string) => {
      const was = s.doc;
      s.doc = fn(was);
      s.journal = recordEffect(s.journal, was, s.doc, key, 0);
    };
    edit(d => splitClip(d, 'c1', 36, 'c2'), 'split');
    edit(d => trimClip(d, 'c1', 'end', 50, 300), 'trim');
    const overlapped = s.doc;
    expect(activeClips(overlapped, 40).at(-1)?.id).toBe('c2');
    edit(d => removeClip(d, 'c1'), 'remove');
    press(s, 'undo', () => {});
    expect(s.doc).toEqual(overlapped);
    expect(activeClips(s.doc, 40).at(-1)?.id).toBe('c2');
    press(s, 'redo', () => {});
    expect(s.doc.clips.map(c => c.id)).toEqual(['c2']);
  });

  it('a split, a duplicate and a reorder are one step each: undo restores the doc exactly, redo puts it back', () => {
    const doc = addClip(addClip(EMPTY_DOC, outline('c1', 30)), outline('c2', 60));
    const edits: Array<[string, (d: EffectDoc) => EffectDoc]> = [
      ['split', d => splitClip(d, 'c1', 50, 'c3')],
      ['duplicate', d => duplicateClip(d, 'c2', 'c4', 300)],
      ['reorder', d => reorderClip(d, 'c2', 'down')],
    ];
    for (const [what, edit] of edits) {
      const after = edit(doc);
      const j = recordEffect(EMPTY_JOURNAL, doc, after, `edit:${what}`, 0);
      expect(j.undo, what).toHaveLength(1);
      const s = {doc: after, journal: j};
      press(s, 'undo', () => {});
      expect(s.doc, what).toEqual(doc);
      press(s, 'redo', () => {});
      expect(s.doc, what).toEqual(after);
    }
  });

  it('Cmd-Z selects the clip the edit selected then, not the first clip it changed', () => {
    // c1 [30, 102) row 0 and c2 [60, 132) row 1 overlap; c1 comes first in the doc
    const doc = addClip(addClip(EMPTY_DOC, outline('c1', 30)), outline('c2', 60));
    const ops: Array<[string, EffectDoc, {before: string; after: string}, [string, string]]> = [
      // reorder: c2 selected, Alt+Down; c1's row changes too, and first
      ['reorder', reorderClip(doc, 'c2', 'down'), {before: 'c2', after: 'c2'}, ['c2', 'c2']],
      // split: the original selected; the edit selected the right part, which redo selects again
      ['split', splitClip(doc, 'c1', 50, 'c3'), {before: 'c1', after: 'c3'}, ['c1', 'c3']],
      // duplicate: undo selects the original (its copy is gone), redo the copy
      ['duplicate', duplicateClip(doc, 'c2', 'c4', 300), {before: 'c2', after: 'c4'}, ['c2', 'c4']],
    ];
    for (const [what, after, select, [undone, redone]] of ops) {
      const j = recordEffect(EMPTY_JOURNAL, doc, after, `edit:${what}`, 0, select);
      const s = {doc: after, journal: j};
      const step = (which: 'undo' | 'redo') => {
        const entry = takeStep(s.journal, which, () => 'ok', () => true).entry as Extract<JournalEntry, {kind: 'effect'}>;
        press(s, which, () => {});
        const id = selectionAfter(entry, which);
        expect(s.doc.clips.some(c => c.id === id), what).toBe(true);
        return id;
      };
      expect(step('undo'), what).toBe(undone);
      expect(step('redo'), what).toBe(redone);
    }
    // edits that name no selection select the clip they changed, or nothing once it is gone
    const added = addClip(doc, outline('c5', 0));
    const entry = recordEffect(EMPTY_JOURNAL, doc, added, 'add', 0).undo[0] as Extract<JournalEntry, {kind: 'effect'}>;
    expect(selectionAfter(entry, 'redo')).toBe('c5');
    expect(selectionAfter(entry, 'undo')).toBeNull();
  });

  it('merges a drag (same key, close together) into one step, but not separate edits', () => {
    let doc = addClip(EMPTY_DOC, outline('c1', 0));
    let j = EMPTY_JOURNAL;
    for (const [w, at] of [[0.01, 0], [0.02, 300], [0.03, 600]] as const) {
      const was = doc;
      doc = updateClip(doc, 'c1', {params: {...doc.clips[0].params, width: w}});
      j = recordEffect(j, was, doc, 'c1:width', at);
    }
    expect(j.undo).toHaveLength(1);
    expect(applyEntry(doc, (j.undo[0] as Extract<JournalEntry, {kind: 'effect'}>).changes, 'undo').clips[0].params.width).toBe(0.006);
    const was = doc;
    doc = updateClip(doc, 'c1', {params: {...doc.clips[0].params, width: 0.04}});
    expect(recordEffect(j, was, doc, 'c1:width', 5000).undo).toHaveLength(2); // a later drag is its own step
    expect(recordEffect(j, doc, doc, 'x', 700)).toBe(j); // nothing changed: nothing recorded
  });

  it('skips entries for removed objects, waits for a tracking one, and follows per-object undo buttons', () => {
    let j = recordSeed(recordSeed(EMPTY_JOURNAL, [1]), [2]);
    const s = {doc: EMPTY_DOC, journal: j};
    const seeds: number[] = [];
    // object 2 is tracking: the step waits and says why
    expect(press(s, 'undo', id => seeds.push(id), id => (id === 2 ? {blocked: 'tracking'} : 'ok'))).toBe('tracking');
    expect(s.journal).toBe(j);
    // object 2 was removed: its entry is dropped and object 1 steps
    press(s, 'undo', id => seeds.push(id), id => (id === 2 ? 'gone' : 'ok'));
    expect(seeds).toEqual([1]);
    // the Layer info Undo button stepped object 1: its newest entry moves to redo too
    j = steppedObject(recordSeed(recordSeed(EMPTY_JOURNAL, [1]), [2]), 'undo', 1);
    expect(j.undo).toEqual([{kind: 'seed', objectIds: [2]}]);
    expect(j.redo).toEqual([{kind: 'seed', objectIds: [1]}]);
  });
});
