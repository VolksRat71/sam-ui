// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// This window's edits, newest last, for one Cmd-Z across effects and clicks
// (Nate, Q6). An effect entry holds before/after snapshots of the clips it
// changed, by clip id; a seed entry only names the objects whose clicks or
// ranges the person changed, because the backend keeps that history (undo
// steps the object back there). Agents' changes are never recorded, so an
// undo here only steps back the person's own edits. Not persisted: a reload
// starts empty, and Cmd-Z then falls back to the selected object's history.
import type {EffectClip, EffectDoc} from './effectClips';

/** Where an added or removed clip sat in the doc (doc order is draw order on a row): before `next`, or last; `index` if `next` is gone. */
export type ClipPlace = {next: string | null; index: number};
export type ClipChange = {id: string; before: EffectClip | null; after: EffectClip | null; place?: ClipPlace};
/** The clip selected before and after an edit that names it (split, duplicate, reorder). */
export type ClipSelection = {before: string; after: string};
export type JournalEntry =
  | {kind: 'effect'; changes: ClipChange[]; key: string; at: number; select?: ClipSelection}
  | {kind: 'seed'; objectIds: number[]};
export type Journal = {undo: JournalEntry[]; redo: JournalEntry[]};

export const EMPTY_JOURNAL: Journal = {undo: [], redo: []};
/** Edits with the same key this close together are one undo step (a slider drag, a clip drag). */
export const MERGE_MS = 1000;
const DEPTH = 200;

const same = (a: EffectClip | null, b: EffectClip | null) => a === b || JSON.stringify(a) === JSON.stringify(b);
const placeIn = (clips: EffectClip[], i: number): ClipPlace => ({next: clips[i + 1]?.id ?? null, index: i});

/** The clips `after` changed, added or removed against `before` (unchanged clips keep their object), an added or removed one with its place. */
export function diffClips(before: EffectDoc, after: EffectDoc): ClipChange[] {
  const was = new Map(before.clips.map(c => [c.id, c]));
  const changes: ClipChange[] = [];
  after.clips.forEach((c, i) => {
    const b = was.get(c.id) ?? null;
    was.delete(c.id);
    if (!same(b, c)) {
      changes.push({id: c.id, before: b, after: c, ...(b == null && {place: placeIn(after.clips, i)})});
    }
  });
  before.clips.forEach((b, i) => {
    if (was.has(b.id)) {
      changes.push({id: b.id, before: b, after: null, place: placeIn(before.clips, i)});
    }
  });
  return changes;
}

function push(j: Journal, entry: JournalEntry): Journal {
  return {undo: [...j.undo, entry].slice(-DEPTH), redo: []};
}

/**
 * Record an effect edit, with the clip it selects before and after (`select`)
 * when that is not simply the clip it changed. With the same `key` as the
 * newest entry and within MERGE_MS of it, the edit joins that entry (its
 * first before, its latest after).
 */
export function recordEffect(j: Journal, before: EffectDoc, after: EffectDoc, key: string, at: number, select?: ClipSelection): Journal {
  const changes = diffClips(before, after);
  if (changes.length === 0) {
    return j;
  }
  const last = j.undo.at(-1);
  if (last?.kind === 'effect' && last.key === key && at - last.at < MERGE_MS) {
    const merged = [...last.changes];
    for (const c of changes) {
      const i = merged.findIndex(m => m.id === c.id);
      merged[i < 0 ? merged.length : i] = i < 0 ? c : {...merged[i], after: c.after, ...(c.place && {place: c.place})};
    }
    return {undo: [...j.undo.slice(0, -1), {...last, changes: merged, at}], redo: []};
  }
  return push(j, {kind: 'effect', changes, key, at, ...(select && {select})});
}

/** The clip to select once an effect entry has stepped: the one its edit selected then, else the first clip it put back. */
export function selectionAfter(entry: Extract<JournalEntry, {kind: 'effect'}>, which: 'undo' | 'redo'): string | null {
  const named = entry.select?.[which === 'undo' ? 'before' : 'after'];
  return named ?? entry.changes.map(c => (which === 'undo' ? c.before : c.after)).find(c => c != null)?.id ?? null;
}

/** Record a seed change the person made on `objectIds` (the backend holds what it was). */
export function recordSeed(j: Journal, objectIds: number[]): Journal {
  return objectIds.length === 0 ? j : push(j, {kind: 'seed', objectIds});
}

/** The entry Cmd-Z (undo) or Shift-Cmd-Z (redo) would step next, if any. */
export function nextEntry(j: Journal, which: 'undo' | 'redo'): JournalEntry | null {
  return j[which].at(-1) ?? null;
}

/** The journal after stepping its next `which` entry: it moves to the other stack. */
export function stepped(j: Journal, which: 'undo' | 'redo'): Journal {
  const entry = j[which].at(-1);
  if (entry == null) {
    return j;
  }
  const other = which === 'undo' ? 'redo' : 'undo';
  return {[which]: j[which].slice(0, -1), [other]: [...j[other], entry]} as Journal;
}

/** The journal without its next `which` entry (one that can no longer step: its objects are gone). */
export function dropped(j: Journal, which: 'undo' | 'redo'): Journal {
  return {...j, [which]: j[which].slice(0, -1)};
}

/**
 * The person stepped `objectId` back (or forward) from its own controls, not
 * Cmd-Z: the newest seed entry naming it moves stacks too, so the next Cmd-Z
 * does not step that object a second time.
 */
export function steppedObject(j: Journal, which: 'undo' | 'redo', objectId: number): Journal {
  const from = j[which];
  let i = from.length - 1;
  while (i >= 0 && !(from[i].kind === 'seed' && (from[i] as {objectIds: number[]}).objectIds.includes(objectId))) i--;
  if (i < 0) {
    return j;
  }
  const other = which === 'undo' ? 'redo' : 'undo';
  return {[which]: [...from.slice(0, i), ...from.slice(i + 1)], [other]: [...j[other], from[i]]} as Journal;
}

/** `clips` with `clip` put back at `place` (no place: last). */
function insertAt(clips: EffectClip[], clip: EffectClip, place: ClipPlace | undefined): EffectClip[] {
  let i = clips.length;
  if (place?.next != null) {
    const next = clips.findIndex(x => x.id === place.next);
    i = next >= 0 ? next : Math.min(place.index, clips.length);
  }
  return [...clips.slice(0, i), clip, ...clips.slice(i)];
}

/** `doc` with an effect entry's clips put back as they were before it (undo) or after it (redo), by clip id, a re-added one in its place. */
export function applyEntry(doc: EffectDoc, changes: ClipChange[], which: 'undo' | 'redo'): EffectDoc {
  let clips = doc.clips;
  for (const c of which === 'undo' ? [...changes].reverse() : changes) {
    const snapshot = which === 'undo' ? c.before : c.after;
    const rest = clips.filter(x => x.id !== c.id);
    const at = clips.findIndex(x => x.id === c.id);
    clips = snapshot == null ? rest : at < 0 ? insertAt(clips, snapshot, c.place) : clips.map(x => (x.id === c.id ? snapshot : x));
  }
  return {...doc, clips};
}

/** Whether an object's seed history can step now: yes, it is gone (or has nothing to step), or a reason it must wait. */
export type SeedStatus = 'ok' | 'gone' | {blocked: string};

/**
 * What Cmd-Z (or Shift-Cmd-Z) does next: the newest entry that can still
 * step, with entries whose objects are all gone (removed, or stepped back
 * elsewhere) dropped on the way. An effect entry keeps only the changes to
 * clips of objects still here; a seed entry names the objects to step on the
 * backend. A seed entry whose object is busy (tracking) stops the step and
 * stays, with the reason. `entry` null and no reason: nothing of this
 * window's is left to step. `exists` says whether an object is still here.
 */
export function takeStep(
  j: Journal,
  which: 'undo' | 'redo',
  status: (objectId: number) => SeedStatus,
  exists: (objectId: number) => boolean,
): {journal: Journal; entry: JournalEntry | null; blocked?: string} {
  for (;;) {
    const top = nextEntry(j, which);
    if (top == null) {
      return {journal: j, entry: null};
    }
    if (top.kind === 'effect') {
      const changes = top.changes.filter(c => {
        const t = (c.before ?? c.after)!.target;
        return t.kind === 'background' || exists(t.id);
      });
      if (changes.length > 0) {
        return {journal: stepped(j, which), entry: {...top, changes}};
      }
    } else {
      const states = top.objectIds.map(status);
      const busy = states.find((s): s is {blocked: string} => typeof s === 'object');
      if (busy != null) {
        return {journal: j, entry: null, blocked: busy.blocked};
      }
      const live = top.objectIds.filter((_, i) => states[i] === 'ok');
      if (live.length > 0) {
        return {journal: stepped(j, which), entry: {...top, objectIds: live}};
      }
    }
    j = dropped(j, which);
  }
}
