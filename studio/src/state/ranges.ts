// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Frame ranges on an object's timeline, the studio twin of the backend's
// tracks/ranges.py (issue #20 and draft 5). A range is {start, end, state},
// frames inclusive. Each frame of an object is one of four kinds:
//   unknown    no range: nobody has said;
//   candidate  a model or tool thinks the object is there, unconfirmed; it
//              carries its `source` (e.g. "text:dog@sam3") and maybe a `score`;
//   present    confirmed there by the user;
//   absent     confirmed not in the shot: its frames are empty, never
//              tracked, shown or exported.
//
// Only absent ranges change tracking (they are `FrameRange`, and the only
// ranges the seeds key, windows and exports' blanking read). Present and
// candidate ranges are `Mark`s: annotations that never touch a mask or a
// window. They are layers, shown absent over present over candidate
// (timelineView): a confirmed range hides a candidate under it without
// deleting it, and marking present clears absent there.
//
// Absent ranges split the timeline into windows, the frames between them.
// Each window is tracked on its own from the seeds inside it; a window with
// no seed stays empty. Seeds inside a range are kept but not used.

export const ABSENT = 'absent' as const;
export const PRESENT = 'present' as const;
export const CANDIDATE = 'candidate' as const;
export type RangeState = typeof ABSENT | typeof PRESENT | typeof CANDIDATE;
export const RANGE_STATES: ReadonlyArray<RangeState> = [ABSENT, PRESENT, CANDIDATE];
/** What a frame is: a range state, or unknown (no range). */
export type FrameKind = RangeState | 'unknown';
export const SOURCE_MAX = 128;
/** An absent range: the only kind tracking reads. */
export type FrameRange = {start: number; end: number; state: typeof ABSENT};
/** A present or candidate range: an annotation, never in the seeds key. */
export type Mark = {start: number; end: number; state: typeof PRESENT | typeof CANDIDATE; source?: string; score?: number};
export type TimelineRange = FrameRange | Mark;
/** An object's two layers as stored: what tracking reads, and the annotations. */
export type Layers = {ranges: FrameRange[]; marks: Mark[]};
/** [lo, hi] inclusive; hi null runs to the clip's end. */
export type Window = {lo: number; hi: number | null};

type RawRange = {start: unknown; end: unknown; state: unknown; source?: unknown; score?: unknown};

function valid(r: {start: unknown; end: unknown; state: unknown}): r is FrameRange {
  return (
    Number.isInteger(r.start) && Number.isInteger(r.end) && (r.start as number) >= 0 && (r.end as number) >= (r.start as number) && r.state === ABSENT
  );
}

/** Sorted, with ranges of one state that overlap or touch merged; invalid entries dropped. */
export function normalizeRanges(ranges: ReadonlyArray<{start: unknown; end: unknown; state: unknown}> | null | undefined): FrameRange[] {
  const spans = (ranges ?? []).filter(valid).map(r => ({start: r.start, end: r.end, state: r.state}));
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: FrameRange[] = [];
  for (const r of spans) {
    const last = out[out.length - 1];
    if (last != null && last.state === r.state && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({...r});
    }
  }
  return out;
}

/** Frames start-end set to `state`, whatever they were; null clears them (unmarking a middle splits a range). */
export function paintRange(ranges: ReadonlyArray<FrameRange>, start: number, end: number, state: typeof ABSENT | null): FrameRange[] {
  const [a, b] = start <= end ? [start, end] : [end, start];
  const out: FrameRange[] = [];
  for (const r of normalizeRanges(ranges)) {
    if (r.end < a || r.start > b) {
      out.push(r);
      continue;
    }
    if (r.start < a) {
      out.push({...r, end: a - 1});
    }
    if (r.end > b) {
      out.push({...r, start: b + 1});
    }
  }
  if (state != null) {
    out.push({start: Math.max(0, a), end: b, state});
  }
  return normalizeRanges(out);
}

export function absentAt(ranges: ReadonlyArray<FrameRange> | undefined, frame: number): boolean {
  return ranges?.some(r => r.state === ABSENT && r.start <= frame && frame <= r.end) ?? false;
}

/** The absent range holding `frame`, if any. */
export function rangeAt(ranges: ReadonlyArray<FrameRange> | undefined, frame: number): FrameRange | null {
  return ranges?.find(r => r.start <= frame && frame <= r.end) ?? null;
}

/** The frames between absent ranges, in order. */
export function rangeWindows(ranges: ReadonlyArray<FrameRange>): Window[] {
  const out: Window[] = [];
  let lo = 0;
  for (const r of normalizeRanges(ranges)) {
    if (r.start > lo) {
      out.push({lo, hi: r.start - 1});
    }
    lo = r.end + 1;
  }
  out.push({lo, hi: null});
  return out;
}

export function inWindow(frame: number, w: Window): boolean {
  return frame >= w.lo && (w.hi == null || frame <= w.hi);
}

/** The windows holding at least one of `seedFrames`, each with its own. */
export function seededWindows(seedFrames: ReadonlyArray<number>, ranges: ReadonlyArray<FrameRange>): Array<{window: Window; frames: number[]}> {
  return rangeWindows(ranges)
    .map(window => ({window, frames: seedFrames.filter(f => inWindow(f, window)).sort((a, b) => a - b)}))
    .filter(w => w.frames.length > 0);
}

/**
 * Windows inside the clip that no seed reaches: they stay empty. Each says
 * which way the nearest gap is, for the lane's hint ("click the object
 * after the gap"). Only for an object with seeds and ranges: an object with
 * neither is plainly untracked.
 */
export function unseededWindows(
  seedFrames: ReadonlyArray<number>,
  ranges: ReadonlyArray<FrameRange>,
  numFrames: number,
): Array<{lo: number; hi: number; side: 'after' | 'before'}> {
  if (seedFrames.length === 0 || ranges.length === 0 || numFrames <= 0) {
    return [];
  }
  return rangeWindows(ranges)
    .map(w => ({lo: w.lo, hi: Math.min(w.hi ?? numFrames - 1, numFrames - 1)}))
    .filter(w => w.lo <= w.hi && !seedFrames.some(f => f >= w.lo && f <= w.hi))
    .map(w => ({...w, side: w.lo > 0 ? ('after' as const) : ('before' as const)}));
}

/** What a selection covers: all absent, none, or some. */
export function spanState(ranges: ReadonlyArray<FrameRange>, start: number, end: number): 'absent' | 'present' | 'mixed' {
  const [a, b] = start <= end ? [start, end] : [end, start];
  let absent = 0;
  for (const r of normalizeRanges(ranges)) {
    absent += Math.max(0, Math.min(r.end, b) - Math.max(r.start, a) + 1);
  }
  return absent === 0 ? 'present' : absent === b - a + 1 ? 'absent' : 'mixed';
}

/** A stable key of ranges, for the browser engine's track state ('' with none). */
export function rangesKey(ranges: ReadonlyArray<FrameRange>): string {
  const r = normalizeRanges(ranges);
  return r.length === 0 ? '' : JSON.stringify(r.map(x => [x.start, x.end, x.state]));
}

export type Unit<T> = {window: Window; objects: Array<{id: number; seeds: T[]}>};

/**
 * One tracking pass per window: every object's seeds split by its windows,
 * objects sharing a window tracked together (the backend's plan_units,
 * without SAM 2's first-seed split, which the browser engine does not need).
 */
export function planUnits<T extends {frame: number}>(
  objects: ReadonlyArray<{id: number; seeds: ReadonlyArray<T>; ranges: ReadonlyArray<FrameRange>}>,
): Array<Unit<T>> {
  const by = new Map<string, Unit<T>>();
  for (const o of objects) {
    for (const w of rangeWindows(o.ranges)) {
      const mine = o.seeds.filter(s => inWindow(s.frame, w));
      if (mine.length === 0) {
        continue;
      }
      const key = `${w.lo}:${w.hi ?? ''}`;
      const unit = by.get(key) ?? {window: w, objects: []};
      unit.objects.push({id: o.id, seeds: mine});
      by.set(key, unit);
    }
  }
  return [...by.values()].sort((a, b) => a.window.lo - b.window.lo || (a.window.hi ?? Infinity) - (b.window.hi ?? Infinity));
}

// -- present and candidate ranges (draft 5) --------------------------------------

function spanOk(r: RawRange): boolean {
  return Number.isInteger(r.start) && Number.isInteger(r.end) && (r.start as number) >= 0 && (r.end as number) >= (r.start as number);
}

/** A mark from the wire or a caller, or why it is not one. */
function toMark(r: RawRange): Mark | string {
  if (!spanOk(r)) {
    return `range ${String(r.start)}-${String(r.end)}: frames run from 0, and the end may not come before the start`;
  }
  const start = r.start as number;
  const end = r.end as number;
  if (r.state === PRESENT) {
    return r.source != null || r.score != null ? 'a present range is the user\'s: it takes no source or score' : {start, end, state: PRESENT};
  }
  if (r.state !== CANDIDATE) {
    return `not a present or candidate range: ${String(r.state)}`;
  }
  const source = typeof r.source === 'string' ? r.source.trim() : '';
  if (source === '' || source.length > SOURCE_MAX) {
    return `a candidate range needs a source (1-${SOURCE_MAX} characters, e.g. "text:dog@sam3")`;
  }
  if (r.score != null && (typeof r.score !== 'number' || !Number.isFinite(r.score) || r.score < 0 || r.score > 1)) {
    return `a candidate's score must be a number from 0 to 1, got ${String(r.score)}`;
  }
  return {start, end, state: CANDIDATE, source, ...(r.score == null ? {} : {score: r.score as number})};
}

const markKey = (m: Mark) => `${m.state}|${m.source ?? ''}|${m.score ?? ''}`;

function sortRanges<T extends TimelineRange>(xs: T[]): T[] {
  return xs.sort((a, b) => a.start - b.start || a.end - b.end || a.state.localeCompare(b.state));
}

/**
 * Present and candidate ranges, validated (bad and absent ones dropped),
 * sorted, and merged where one state (and, for candidates, one source and
 * score) overlaps or touches. A candidate may lie under a present range.
 */
export function normalizeMarks(ranges: ReadonlyArray<RawRange> | null | undefined): Mark[] {
  const groups = new Map<string, Mark[]>();
  for (const raw of ranges ?? []) {
    if (raw.state === ABSENT) {
      continue;
    }
    const m = toMark(raw);
    if (typeof m !== 'string') {
      groups.set(markKey(m), [...(groups.get(markKey(m)) ?? []), m]);
    }
  }
  const out: Mark[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: Mark[] = [];
    for (const m of group) {
      const last = merged[merged.length - 1];
      if (last != null && m.start <= last.end + 1) {
        last.end = Math.max(last.end, m.end);
      } else {
        merged.push({...m});
      }
    }
    out.push(...merged);
  }
  return sortRanges(out);
}

/** `xs` with frames a-b cleared from the ranges whose state is in `over`. */
function cut<T extends TimelineRange>(xs: ReadonlyArray<T>, a: number, b: number, over: ReadonlySet<string>): T[] {
  const out: T[] = [];
  for (const r of xs) {
    if (!over.has(r.state) || r.end < a || r.start > b) {
      out.push(r);
      continue;
    }
    if (r.start < a) {
      out.push({...r, end: a - 1});
    }
    if (r.end > b) {
      out.push({...r, start: b + 1});
    }
  }
  return out;
}

function clip<T extends TimelineRange>(xs: ReadonlyArray<T>, by: ReadonlyArray<TimelineRange>): T[] {
  let out = [...xs];
  for (const b of by) {
    out = cut(out, b.start, b.end, new Set(RANGE_STATES));
  }
  return out;
}

/** What the timeline shows: one state per frame, absent over present over candidate. */
export function timelineView(ranges: ReadonlyArray<FrameRange>, marks: ReadonlyArray<Mark>): TimelineRange[] {
  const absent = normalizeRanges(ranges);
  const all = normalizeMarks(marks);
  const present = clip(all.filter(m => m.state === PRESENT), absent);
  const candidates = clip(all.filter(m => m.state === CANDIDATE), [...absent, ...present]);
  return sortRanges<TimelineRange>([...absent, ...present, ...candidates]);
}

/** The marks of a view (or of the wire's ranges, which are one): present and candidate only. */
export function viewMarks(ranges: ReadonlyArray<FrameRange>, marks: ReadonlyArray<Mark>): Mark[] {
  return timelineView(ranges, marks).filter((r): r is Mark => r.state !== ABSENT);
}

export function stateAt(view: ReadonlyArray<TimelineRange>, frame: number): FrameKind {
  return view.find(r => r.start <= frame && frame <= r.end)?.state ?? 'unknown';
}

export type PaintOptions = {source?: string; score?: number; clear?: ReadonlyArray<RangeState>};

function checkSpan(a: number, b: number): void {
  if (!spanOk({start: a, end: b, state: null})) {
    throw new Error(`range ${a}-${b}: frames run from 0, and the end may not come before the start`);
  }
}

/**
 * Frames start-end set to `state`, or cleared (null: every state, or only
 * those in `clear`; [CANDIDATE] rejects a candidate). As the backend's
 * SeedStore.paint_range: absent wins over the marks under it without
 * removing them, present clears absent there, and a candidate goes under
 * whatever is confirmed. Throws on a bad span or a candidate without a source.
 */
export function paintTimeline(layers: Layers, start: number, end: number, state: RangeState | null, opts: PaintOptions = {}): Layers {
  const [a, b] = start <= end ? [start, end] : [end, start];
  checkSpan(a, b);
  const ranges = normalizeRanges(layers.ranges);
  const marks = normalizeMarks(layers.marks);
  if (state == null) {
    const clear = new Set<string>(opts.clear ?? RANGE_STATES);
    return {
      ranges: clear.has(ABSENT) ? paintRange(ranges, a, b, null) : ranges,
      marks: normalizeMarks(cut(marks, a, b, clear)),
    };
  }
  if (state === ABSENT) {
    return {ranges: paintRange(ranges, a, b, ABSENT), marks};
  }
  const m = toMark({start: a, end: b, state, source: opts.source, score: opts.score});
  if (typeof m === 'string') {
    throw new Error(m);
  }
  return {
    ranges: state === PRESENT ? paintRange(ranges, a, b, null) : ranges,
    marks: normalizeMarks([...cut(marks, a, b, new Set([state])), m]),
  };
}

/**
 * Candidates written in bulk, in order (a later one wins where two
 * overlap); `replace` drops the old candidates first. All or nothing: a bad
 * candidate throws and nothing is written.
 */
export function writeCandidates(
  layers: Layers,
  candidates: ReadonlyArray<{start: number; end: number; source: string; score?: number | null}>,
  replace = false,
): Layers {
  let next: Layers = replace ? {ranges: layers.ranges, marks: layers.marks.filter(m => m.state !== CANDIDATE)} : layers;
  for (const c of candidates) {
    checkSpan(c.start, c.end); // a written span, unlike a drag, has a direction: as the backend
    next = paintTimeline(next, c.start, c.end, CANDIDATE, {source: c.source, score: c.score ?? undefined});
  }
  return next;
}

/** Every kind of frame a selection covers (unknown included). */
export function spanKinds(view: ReadonlyArray<TimelineRange>, start: number, end: number): Set<FrameKind> {
  const [a, b] = start <= end ? [start, end] : [end, start];
  const out = new Set<FrameKind>();
  let covered = 0;
  for (const r of view) {
    const n = Math.min(r.end, b) - Math.max(r.start, a) + 1;
    if (n > 0) {
      out.add(r.state);
      covered += n;
    }
  }
  if (covered < b - a + 1) {
    out.add('unknown');
  }
  return out;
}

/** The next range (of `state`, if given) wholly after `frame` (dir 1) or before it (dir -1). */
export function nextRange<T extends TimelineRange>(view: ReadonlyArray<T>, frame: number, dir: 1 | -1, state?: RangeState): T | null {
  const xs = view.filter(r => state == null || r.state === state);
  return dir > 0 ? (xs.find(r => r.start > frame) ?? null) : ([...xs].reverse().find(r => r.end < frame) ?? null);
}

/** A candidate's provenance for the UI: its source and score. */
export function provenanceLabel(m: Mark): string {
  return `${m.source ?? 'unknown source'} · ${m.score == null ? 'no score' : `score ${m.score.toFixed(2)}`}`;
}
