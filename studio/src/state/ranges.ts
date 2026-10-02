// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Frame ranges on an object's timeline, the studio twin of the backend's
// tracks/ranges.py (issue #20). A range is {start, end, state}, frames
// inclusive. The only state is "absent": the object is not in the shot, so
// its frames are empty, never tracked, shown or exported. `state` is a field
// so later kinds of range (discovered but unconfirmed ones) join the list.
//
// Absent ranges split the timeline into windows, the frames between them.
// Each window is tracked on its own from the seeds inside it; a window with
// no seed stays empty. Seeds inside a range are kept but not used.

export type RangeState = 'absent';
export const ABSENT: RangeState = 'absent';
export type FrameRange = {start: number; end: number; state: RangeState};
/** [lo, hi] inclusive; hi null runs to the clip's end. */
export type Window = {lo: number; hi: number | null};

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
export function paintRange(ranges: ReadonlyArray<FrameRange>, start: number, end: number, state: RangeState | null): FrameRange[] {
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

/**
 * The object is back at `frame` (a positive click there): the absent range
 * holding it becomes [start, frame - 1], or goes when frame is its start.
 * The backend's TrackService.end_absence_at, mirrored so the worker shows
 * the click's mask before the next sync.
 */
export function endAbsenceAt(ranges: ReadonlyArray<FrameRange> | undefined, frame: number): FrameRange[] {
  const r = normalizeRanges(ranges).find(x => x.state === ABSENT && x.start <= frame && frame <= x.end);
  return r == null ? normalizeRanges(ranges) : paintRange(ranges ?? [], frame, r.end, null);
}

/**
 * [frame, end]: from `frame` up to the frame before the object's next seed
 * after it, else the clip's last frame. "Gone for a while?": the object is
 * absent until the click where it comes back. A seed on `frame` itself is
 * not "next"; a cleared seed (negatives only) is still a seed.
 */
export function absentUntilNextSeed(seedFrames: ReadonlyArray<number>, frame: number, nFrames: number): [number, number] {
  const next = seedFrames.filter(f => f > frame).sort((a, b) => a - b)[0];
  return [frame, next == null ? nFrames - 1 : next - 1];
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
