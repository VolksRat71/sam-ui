// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The audit queue (draft 7), the studio twin of the backend's
// tracks/audit.py: a short, ranked list of the places in a track worth a
// look, so a person inspects a few frames instead of the whole clip. With a
// backend, its engines' queues come from POST /review_queue; the browser
// engine's (and every queue with no backend) are computed here, from the
// masks the tab already holds. The two must agree: same statistics, signals,
// weights and ranking. See tracks/audit.py for the reasoning.
//
// Each frame's area, box, centroid and number of pieces are read from the RLE
// runs; signals turn them into reasons (a jump, a change of area or of pieces,
// a start, stop or reappearance, an engine disagreement, a candidate's start,
// a bounded re-track's seams, a review flag); locations() scores frames by the
// WEIGHTS and merges neighbours by non-maximum suppression into a capped queue.
//
// A "looks right" mark is kept per object, outside the seeds key, and holds
// while the mask on its frame is the one reviewed (its fingerprint). The
// backend also checks the pass that made the frame (#19's provenance); the
// browser engine has no bounded passes, so the mask is all there is.
import type {RLEObject} from '@/jscocotools/mask';
import {ABSENT, CANDIDATE, type TimelineRange, absentAt, normalizeRanges, rangeWindows, inWindow} from './ranges';

export const WEIGHTS = {
  flag: 3.0,
  disagree: 2.0,
  reappear: 1.5,
  candidate: 1.5,
  start: 1.0,
  stop: 1.0,
  area: 1.0,
  jump: 1.0,
  components: 1.0,
  retrack: 1.0,
} as const;
export type ReasonKind = keyof typeof WEIGHTS;

export const COMPONENT_MIN_FRACTION = 0.05;
export const COMPONENT_MIN_PX = 4;
export const AREA_JUMP = 0.25;
export const AREA_FULL = 0.75;
export const JUMP_REL = 0.25;
export const JUMP_FULL = 1.0;
export const BOX_SURPRISE = 0.5;
export const BOX_FULL = 0.9;
export const JUMP_HISTORY = 3;
export const DISAGREE_IOU = 0.8;
export const RETRACK_INSIDE = 0.25;
export const NMS_RADIUS = 10;
export const QUEUE_CAP = 15;
export const MIN_SCORE = 0.5;

type Box = [number, number, number, number];
export type FrameStats = {area: number; bbox: Box | null; centroid: [number, number] | null; components: number};
export type Reason = {kind: ReasonKind; frame: number; strength: number; detail: string};
export type Location = {frame: number; start: number; end: number; score: number; reasons: Reason[]};
/** A queue stop: a location of one object, and whether a valid mark reviewed it. */
export type QueueEntry = Location & {objectId: number; reviewed: boolean; reviewedAt: string | null};
type RleLike = {readonly size: ReadonlyArray<number>; readonly counts: string};

// -- statistics from RLE ----------------------------------------------------------

/** COCO's compressed RLE string as run lengths (pycocotools' rleFrString). */
export function rleCounts(s: string): number[] {
  const out: number[] = [];
  let p = 0;
  while (p < s.length) {
    let x = 0;
    let k = 0;
    let more = true;
    while (more) {
      const c = s.charCodeAt(p) - 48;
      x |= (c & 0x1f) << (5 * k);
      more = (c & 0x20) !== 0;
      p++;
      k++;
      if (!more && (c & 0x10) !== 0) {
        x |= -1 << (5 * k);
      }
    }
    if (out.length > 2) {
      x += out[out.length - 2];
    }
    out.push(x);
  }
  return out;
}

/** The mask's runs as [x, y0, y1] column segments, split where a run wraps a column. */
export function segments(rle: RleLike): Array<[number, number, number]> {
  const h = rle.size[0];
  const out: Array<[number, number, number]> = [];
  let p = 0;
  rleCounts(rle.counts).forEach((n, i) => {
    if (i % 2 === 1 && n > 0) {
      const end = p + n;
      let q = p;
      while (q < end) {
        const x = Math.floor(q / h);
        const y0 = q % h;
        const y1 = Math.min(h - 1, y0 + (end - q) - 1);
        out.push([x, y0, y1]);
        q += y1 - y0 + 1;
      }
    }
    p += n;
  });
  return out;
}

function pieceAreas(segs: ReadonlyArray<[number, number, number]>): number[] {
  const parent = segs.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  let prev: number[] = [];
  let cur: number[] = [];
  let col: number | null = null;
  segs.forEach(([x, y0, y1], i) => {
    if (x !== col) {
      prev = col != null && x === col + 1 ? cur : [];
      cur = [];
      col = x;
    }
    for (const j of prev) {
      const [, b0, b1] = segs[j];
      if (b0 <= y1 + 1 && y0 <= b1 + 1) {
        const ra = find(i);
        const rb = find(j);
        if (ra !== rb) {
          parent[ra] = rb;
        }
      }
    }
    cur.push(i);
  });
  const areas = new Map<number, number>();
  segs.forEach(([, y0, y1], i) => areas.set(find(i), (areas.get(find(i)) ?? 0) + y1 - y0 + 1));
  return [...areas.values()];
}

export function frameStats(rle: RleLike): FrameStats {
  const segs = segments(rle);
  if (segs.length === 0) {
    return {area: 0, bbox: null, centroid: null, components: 0};
  }
  let area = 0;
  let sx = 0;
  let sy = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (const [x, a, b] of segs) {
    const n = b - a + 1;
    area += n;
    sx += x * n;
    sy += (n * (a + b)) / 2;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, a);
    y1 = Math.max(y1, b);
  }
  const floor = Math.max(COMPONENT_MIN_PX, COMPONENT_MIN_FRACTION * area);
  return {
    area,
    bbox: [x0, y0, x1, y1],
    centroid: [sx / area, sy / area],
    components: pieceAreas(segs).filter(a => a >= floor).length,
  };
}

// -- signals ------------------------------------------------------------------------

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function ramp(v: number, lo: number, hi: number): number {
  return round3(0.5 + 0.5 * Math.min(1, Math.max(0, (v - lo) / (hi - lo))));
}

function boxIou(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]) + 1;
  const ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]) + 1;
  if (iw <= 0 || ih <= 0) {
    return 0;
  }
  const inter = iw * ih;
  return inter / ((a[2] - a[0] + 1) * (a[3] - a[1] + 1) + (b[2] - b[0] + 1) * (b[3] - b[1] + 1) - inter);
}

const diag = (b: ReadonlyArray<number>) => Math.hypot(b[2] - b[0] + 1, b[3] - b[1] + 1);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const reason = (kind: ReasonKind, frame: number, strength: number, detail: string): Reason => ({kind, frame, strength: round3(strength), detail});

export type SignalInputs = {
  absent?: ReadonlyArray<{start: number; end: number; state: string}>;
  /** The timeline's ranges: candidates among them count where they start. */
  candidates?: ReadonlyArray<TimelineRange>;
  /** IoU per frame against another engine. */
  disagreement?: ReadonlyMap<number, number>;
  threshold?: number;
  pair?: [string, string];
  bounded?: ReadonlyArray<readonly [number, number]>;
  flags?: ReadonlyArray<number>;
  seeds?: ReadonlyArray<number>;
};

/** The frames worth a look, each with its reasons (tracks/audit.py signals). */
export function signals(stats: ReadonlyMap<number, FrameStats>, nFrames: number, inputs: SignalInputs = {}): Map<number, Reason[]> {
  const absent = normalizeRanges(inputs.absent ?? []);
  const out = new Map<number, Reason[]>();
  const add = (r: Reason) => out.set(r.frame, [...(out.get(r.frame) ?? []), r]);
  const gone = (f: number) => absentAt(absent, f);
  const there = (f: number) => f >= 0 && f < nFrames && (stats.get(f)?.area ?? 0) > 0 && !gone(f);

  let seen = false;
  let moves: Array<[number, number]> = [];
  for (let f = 0; f < nFrames; f++) {
    if (!there(f)) {
      moves = [];
      continue;
    }
    const st = stats.get(f)!;
    if (!there(f - 1) && f > 0) {
      add(seen ? reason('reappear', f, 1, 'the object comes back after a gap') : reason('start', f, 1, 'the track starts here'));
    }
    if (!there(f + 1) && f < nFrames - 1) {
      add(reason('stop', f, 1, 'the track stops after this frame'));
    }
    seen = true;
    if (!there(f - 1)) {
      continue;
    }
    const pv = stats.get(f - 1)!;
    const rel = Math.abs(st.area - pv.area) / Math.max(st.area, pv.area);
    if (rel >= AREA_JUMP) {
      add(reason('area', f, ramp(rel, AREA_JUMP, AREA_FULL), `the mask ${st.area > pv.area ? 'grows' : 'shrinks'} by ${Math.round(100 * rel)}% in one frame`));
    }
    if (st.components !== pv.components) {
      add(reason('components', f, 1, `the mask goes from ${pv.components} to ${st.components} pieces`));
    }
    const recent = moves.slice(-JUMP_HISTORY);
    const vx = recent.length > 0 ? median(recent.map(m => m[0])) : 0;
    const vy = recent.length > 0 ? median(recent.map(m => m[1])) : 0;
    const [cx0, cy0] = pv.centroid!;
    const [cx1, cy1] = st.centroid!;
    const b = pv.bbox!;
    const off = Math.hypot(cx1 - (cx0 + vx), cy1 - (cy0 + vy)) / Math.max(diag(b), diag(st.bbox!));
    const surprise = 1 - boxIou([b[0] + vx, b[1] + vy, b[2] + vx, b[3] + vy], st.bbox!);
    const strength = Math.max(off >= JUMP_REL ? ramp(off, JUMP_REL, JUMP_FULL) : 0, surprise >= BOX_SURPRISE ? ramp(surprise, BOX_SURPRISE, BOX_FULL) : 0);
    if (strength > 0) {
      add(
        reason(
          'jump',
          f,
          strength,
          `the mask moves ${off.toFixed(2)} of its size off its course, and its box overlaps the expected one by ${Math.round(100 * (1 - surprise))}%`,
        ),
      );
    }
    moves.push([cx1 - cx0, cy1 - cy0]);
  }

  const threshold = inputs.threshold ?? DISAGREE_IOU;
  const [a, b] = inputs.pair ?? ['the engines', ''];
  for (const [f, iou] of [...(inputs.disagreement ?? new Map<number, number>())].sort((x, y) => x[0] - y[0])) {
    if (iou < threshold && f >= 0 && f < nFrames && !gone(f)) {
      add(reason('disagree', f, ramp(threshold - iou, 0, threshold), `${b !== '' ? `${a} and ${b}` : a} disagree (IoU ${iou.toFixed(2)})`));
    }
  }

  for (const [lo, hi] of inputs.bounded ?? []) {
    for (let f = lo; f <= hi; f++) {
      if (gone(f) || f < 0 || f >= nFrames) {
        continue;
      }
      add(
        f === lo || f === hi
          ? reason('retrack', f, 1, `a re-track near a correction ${f === lo ? 'starts' : 'stops'} here (frames ${lo + 1}-${hi + 1})`)
          : reason('retrack', f, RETRACK_INSIDE, 'made by a re-track near a correction'),
      );
    }
  }

  for (const c of inputs.candidates ?? []) {
    if (c.state === CANDIDATE && c.start >= 0 && c.start < nFrames && !gone(c.start)) {
      const score = c.score != null ? `, score ${c.score.toFixed(2)}` : '';
      add(reason('candidate', c.start, 1, `an unconfirmed candidate range from ${c.source}${score} starts here (frames ${c.start + 1}-${c.end + 1})`));
    }
  }

  for (const f of new Set(inputs.seeds ?? [])) {
    out.delete(f); // the user drew that mask: only their own flag still counts
  }
  for (const f of [...new Set(inputs.flags ?? [])].sort((x, y) => x - y)) {
    if (f >= 0 && f < nFrames) {
      add(reason('flag', f, 1, 'flagged for a correction'));
    }
  }
  return new Map([...out].filter(([, rs]) => rs.length > 0).sort((x, y) => x[0] - y[0]));
}

// -- ranking --------------------------------------------------------------------------

export function frameScore(reasons: ReadonlyArray<Reason>): number {
  return reasons.reduce((s, r) => s + WEIGHTS[r.kind] * r.strength, 0);
}

/** Frames with reasons merged by non-maximum suppression into a few locations, best first. */
export function locations(
  reasons: ReadonlyMap<number, ReadonlyArray<Reason>>,
  _nFrames: number,
  absent: ReadonlyArray<{start: number; end: number; state: string}> = [],
  radius = NMS_RADIUS,
  cap = QUEUE_CAP,
  minScore = MIN_SCORE,
): Location[] {
  const wins = rangeWindows(normalizeRanges(absent.filter(r => r.state === ABSENT)));
  const windowOf = (f: number) => wins.findIndex(w => inWindow(f, w));
  const scores = new Map([...reasons].filter(([, rs]) => rs.length > 0).map(([f, rs]) => [f, frameScore(rs)] as const));
  const taken = new Set<number>();
  const out: Location[] = [];
  for (const f of [...scores.keys()].sort((x, y) => scores.get(y)! - scores.get(x)! || x - y)) {
    if (taken.has(f)) {
      continue;
    }
    const w = windowOf(f);
    const members = [...scores.keys()].filter(g => !taken.has(g) && Math.abs(g - f) <= radius && windowOf(g) === w);
    members.forEach(g => taken.add(g));
    const best = new Map<ReasonKind, Reason>();
    for (const g of [...members].sort((x, y) => x - y)) {
      for (const r of reasons.get(g)!) {
        const had = best.get(r.kind);
        if (had == null || r.strength > had.strength) {
          best.set(r.kind, r);
        }
      }
    }
    const kept = [...best.values()].sort((x, y) => WEIGHTS[y.kind] * y.strength - WEIGHTS[x.kind] * x.strength || x.frame - y.frame);
    out.push({frame: f, start: Math.min(...members), end: Math.max(...members), score: round3(frameScore(kept)), reasons: kept});
  }
  return out
    .filter(l => l.score >= minScore)
    .sort((x, y) => y.score - x.score || x.frame - y.frame)
    .slice(0, cap);
}

/** Every object's locations in one queue, best first. */
export function rank<T extends Location>(byObject: ReadonlyMap<number, ReadonlyArray<T>>): Array<T & {objectId: number}> {
  const q = [...byObject].flatMap(([objectId, locs]) => locs.map(l => ({...l, objectId})));
  return q.sort((a, b) => b.score - a.score || a.objectId - b.objectId || a.frame - b.frame);
}

// -- reviewed marks -------------------------------------------------------------------

/** "Looks right" on one location: the frame looked at, the stretch it covered, and the mask then. */
export type ReviewMark = {frame: number; span: [number, number] | null; engine: string; at: string; mask: string; reasons: ReasonKind[]};

/** A short hash of one frame's mask (cyrb53, hex). The backend's is its own (sha1): they never meet. */
export function fingerprint(rle: RleLike | RLEObject): string {
  const str = `${rle.size[0]}x${rle.size[1]}:${rle.counts}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Whether a mark still holds: the same engine, and the same mask on its frame (null: none there). */
export function markValid(mark: ReviewMark, engine: string, maskNow: string | null): boolean {
  return mark.engine === engine && maskNow != null && mark.mask === maskNow;
}

/** Whether a mark reviewed a location covering frames start-end. */
export function covers(mark: Pick<ReviewMark, 'frame' | 'span'>, start: number, end: number): boolean {
  const [a, b] = mark.span ?? [mark.frame, mark.frame];
  return a <= end && start <= b;
}

/** Stored marks, keeping only well-formed ones. */
export function parseMarks(raw: unknown): ReviewMark[] {
  const list = raw != null && typeof raw === 'object' ? (raw as {marks?: unknown}).marks : null;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter(
    (m): m is ReviewMark =>
      m != null &&
      typeof m === 'object' &&
      Number.isInteger(m.frame) &&
      typeof m.engine === 'string' &&
      typeof m.mask === 'string' &&
      (m.span == null || (Array.isArray(m.span) && m.span.length === 2 && m.span.every(Number.isInteger))),
  );
}

// -- walking the queue ----------------------------------------------------------------

/**
 * The index of the stop after (dir 1) or before (dir -1) `current` in the
 * ranked queue, wrapping; with no current stop, the first (or last). With
 * `unreviewedOnly`, reviewed stops are skipped; null when none is left.
 */
export function stepQueue(
  queue: ReadonlyArray<{reviewed: boolean}>,
  current: number | null,
  dir: 1 | -1,
  unreviewedOnly = false,
): number | null {
  const n = queue.length;
  if (n === 0) {
    return null;
  }
  let i = current == null ? (dir > 0 ? -1 : n) : current;
  for (let k = 0; k < n; k++) {
    i = (((i + dir) % n) + n) % n;
    if (!unreviewedOnly || !queue[i].reviewed) {
      return i;
    }
  }
  return null;
}

/** A location's reasons in words, for a title or a list (never told by colour alone). */
export function describeStop(l: Pick<Location, 'frame' | 'start' | 'end' | 'reasons' | 'score'>): string {
  const where = l.start === l.end ? `frame ${l.frame + 1}` : `frame ${l.frame + 1} (frames ${l.start + 1}-${l.end + 1})`;
  return `${where}: ${l.reasons.map(r => r.detail).join('; ')} · score ${l.score.toFixed(2)}`;
}

/** Short names of the reason kinds, for the list's chips. */
export const KIND_LABELS: Record<ReasonKind, string> = {
  flag: 'flagged',
  disagree: 'engines disagree',
  reappear: 'reappears',
  candidate: 'candidate starts',
  start: 'track starts',
  stop: 'track stops',
  area: 'area jump',
  jump: 'jumps',
  components: 'pieces change',
  retrack: 're-tracked',
};
