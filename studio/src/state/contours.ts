// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Masks as vector outlines, in the per-frame format of the rotoscoping
// skill's contours.py (its default mode), so its After Effects handoff reads
// studio's Vector JSON unchanged:
//
//   {"version": 1, "engine", "model", "object": {"id", "name"}, "fps", "w", "h", "frames": N,
//    "add": [[outline_or_null per frame] per slot],   pieces, largest first
//    "sub": [[outline_or_null per frame] per slot]}   holes, largest first
//
// An outline is [[x, y], ...] in layer pixels (top-left origin). Frame index
// 0 is clip frame 1 (key time = index / fps). Slot k of a frame is its k-th
// largest piece (or hole); a frame without a mask is null in every slot.
//
// As contours.py does with OpenCV: outlines are traced with the border
// following of cv2.findContours (Suzuki and Abe; RETR_CCOMP, so an outer
// border is a piece and a hole border a hole; pieces are 8-connected, holes
// 4-connected; points are the centres of the boundary pixels), measured
// with cv2.contourArea (the shoelace area of those points), dropped under
// minArea (150 px), and simplified with a port of cv2.approxPolyDP (closed,
// eps 1.2 px). Outlines of fewer than 3 points are dropped.

export type Point = [number, number];
export type Outline = Point[];

export type TraceOptions = {eps?: number; minArea?: number};

export const DEFAULT_EPS = 1.2;
export const DEFAULT_MIN_AREA = 150;

export type Traced = {pieces: Outline[]; holes: Outline[]};

// the 8 neighbours, clockwise from east (y grows down): E, SE, S, SW, W, NW, N, NE
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

function dirOf(dx: number, dy: number): number {
  for (let d = 0; d < 8; d++) {
    if (DX[d] === dx && DY[d] === dy) {
      return d;
    }
  }
  throw new Error('not a neighbour');
}

/**
 * Every border of a row-major 0/1 mask, as findContours(RETR_CCOMP,
 * CHAIN_APPROX_NONE) finds them: {points, hole}.
 */
export function findBorders(mask: ArrayLike<number>, w: number, h: number): Array<{points: Outline; hole: boolean}> {
  // a padded label image: 0 background, 1 unlabelled foreground, +-n border n
  const W = w + 2;
  const f = new Int32Array(W * (h + 2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        f[(y + 1) * W + x + 1] = 1;
      }
    }
  }
  const at = (x: number, y: number) => f[y * W + x];
  const borders: Array<{points: Outline; hole: boolean}> = [];
  let nbd = 1;
  for (let y = 1; y <= h; y++) {
    for (let x = 1; x <= w; x++) {
      const v = at(x, y);
      let hole: boolean;
      let fromX: number;
      if (v === 1 && at(x - 1, y) === 0) {
        hole = false;
        fromX = x - 1;
      } else if (v >= 1 && at(x + 1, y) === 0) {
        hole = true;
        fromX = x + 1;
      } else {
        continue;
      }
      nbd++;
      borders.push({points: follow(f, W, x, y, fromX, y, nbd), hole});
    }
  }
  return borders;
}

/** Suzuki-Abe border following from (x, y), entered from its neighbour (fx, fy). */
function follow(f: Int32Array, W: number, x: number, y: number, fx: number, fy: number, nbd: number): Outline {
  const at = (px: number, py: number) => f[py * W + px];
  const points: Outline = [];
  // 3.1: clockwise around (x, y) from (fx, fy), the first non-zero pixel
  const start = dirOf(fx - x, fy - y);
  let found = -1;
  for (let k = 0; k < 8; k++) {
    const d = (start + k) % 8;
    if (at(x + DX[d], y + DY[d]) !== 0) {
      found = d;
      break;
    }
  }
  if (found < 0) {
    f[y * W + x] = -nbd; // a lone pixel
    return [[x - 1, y - 1]];
  }
  const x1 = x + DX[found];
  const y1 = y + DY[found];
  let x2 = x1;
  let y2 = y1;
  let x3 = x;
  let y3 = y;
  for (;;) {
    points.push([x3 - 1, y3 - 1]);
    // 3.3: counter-clockwise around (x3, y3), from the one after (x2, y2)
    const from = dirOf(x2 - x3, y2 - y3);
    let x4 = 0;
    let y4 = 0;
    let eastSeenZero = false;
    for (let k = 1; k <= 8; k++) {
      const d = (from - k + 16) % 8;
      const nx = x3 + DX[d];
      const ny = y3 + DY[d];
      if (at(nx, ny) !== 0) {
        x4 = nx;
        y4 = ny;
        break;
      }
      if (d === 0) {
        eastSeenZero = true;
      }
    }
    // 3.4
    if (eastSeenZero) {
      f[y3 * W + x3] = -nbd;
    } else if (at(x3, y3) === 1) {
      f[y3 * W + x3] = nbd;
    }
    // 3.5
    if (x4 === x && y4 === y && x3 === x1 && y3 === y1) {
      return points;
    }
    x2 = x3;
    y2 = y3;
    x3 = x4;
    y3 = y4;
  }
}

/** cv2.contourArea: the shoelace area of the outline's points. */
export function outlineArea(points: Outline): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

/**
 * cv2.approxPolyDP(points, eps, closed=True), ported from OpenCV's
 * approx.cpp (approxPolyDP_): the two roughly farthest points (three
 * passes), Douglas-Peucker between them, then its clean-up of points left
 * on almost straight lines. The same vertices as OpenCV, in its order.
 */
export function simplifyClosed(src: Outline, epsilon: number): Outline {
  let count = src.length;
  if (count === 0) {
    return [];
  }
  const eps = epsilon * epsilon;
  const dst: Outline = [];
  const stack: Array<[number, number]> = [];
  let pos = 0;
  let rightStart = 0;
  let startPt: Point = [-1e6, -1e6];
  let leEps = false;
  const read = (): Point => {
    const pt = src[pos];
    if (++pos >= count) {
      pos = 0;
    }
    return pt;
  };
  // 1. two roughly farthest points
  for (let i = 0; i < 3; i++) {
    let maxDist = 0;
    pos = (pos + rightStart) % count;
    startPt = read();
    for (let j = 1; j < count; j++) {
      const pt = read();
      const dx = pt[0] - startPt[0];
      const dy = pt[1] - startPt[1];
      const dist = dx * dx + dy * dy;
      if (dist > maxDist) {
        maxDist = dist;
        rightStart = j;
      }
    }
    leEps = maxDist <= eps;
  }
  // 2. the stack
  if (!leEps) {
    const sliceStart = pos % count;
    const mid = (rightStart + sliceStart) % count;
    stack.push([mid, sliceStart], [sliceStart, mid]);
  } else {
    dst.push(startPt);
  }
  // 3. the recursion
  while (stack.length > 0) {
    const [sStart, sEnd] = stack.pop()!;
    const endPt = src[sEnd];
    pos = sStart;
    startPt = read();
    let split = 0;
    if (pos !== sEnd) {
      let maxDist = 0;
      const dx = endPt[0] - startPt[0];
      const dy = endPt[1] - startPt[1];
      while (pos !== sEnd) {
        const pt = read();
        const dist = Math.abs((pt[1] - startPt[1]) * dx - (pt[0] - startPt[0]) * dy);
        if (dist > maxDist) {
          maxDist = dist;
          split = (pos + count - 1) % count;
        }
      }
      leEps = maxDist * maxDist <= eps * (dx * dx + dy * dy);
    } else {
      leEps = true;
      startPt = src[sStart];
    }
    if (leEps) {
      dst.push(startPt);
    } else {
      stack.push([split, sEnd], [sStart, split]);
    }
  }
  // 4. clean-up: drop points on almost straight lines
  count = dst.length;
  let newCount = count;
  pos = count - 1;
  const readDst = (): Point => {
    const pt = dst[pos];
    if (++pos >= count) {
      pos = 0;
    }
    return pt;
  };
  startPt = readDst();
  let wpos = pos;
  let pt = readDst();
  for (let i = 0; i < count && newCount > 2; i++) {
    const endPt = readDst();
    const dx = endPt[0] - startPt[0];
    const dy = endPt[1] - startPt[1];
    const dist = Math.abs((pt[0] - startPt[0]) * dy - (pt[1] - startPt[1]) * dx);
    const inner = (pt[0] - startPt[0]) * (endPt[0] - pt[0]) + (pt[1] - startPt[1]) * (endPt[1] - pt[1]);
    if (dist * dist <= 0.5 * eps * (dx * dx + dy * dy) && dx !== 0 && dy !== 0 && inner >= 0) {
      newCount--;
      dst[wpos] = startPt = endPt;
      if (++wpos >= count) {
        wpos = 0;
      }
      pt = readDst();
      i++;
      continue;
    }
    dst[wpos] = startPt = pt;
    if (++wpos >= count) {
      wpos = 0;
    }
    pt = endPt;
  }
  return dst.slice(0, newCount);
}

/** One frame's pieces and holes, each largest first, as contours.py keeps them. */
export function traceMask(mask: ArrayLike<number>, w: number, h: number, opts: TraceOptions = {}): Traced {
  const eps = opts.eps ?? DEFAULT_EPS;
  const minArea = opts.minArea ?? DEFAULT_MIN_AREA;
  const pieces: Array<[number, Outline]> = [];
  const holes: Array<[number, Outline]> = [];
  for (const b of findBorders(mask, w, h)) {
    const area = outlineArea(b.points);
    const pts = simplifyClosed(b.points, eps);
    if (area < minArea || pts.length < 3) {
      continue;
    }
    (b.hole ? holes : pieces).push([area, pts]);
  }
  const bySize = (a: [number, Outline], b: [number, Outline]) => b[0] - a[0];
  return {pieces: pieces.sort(bySize).map(p => p[1]), holes: holes.sort(bySize).map(p => p[1])};
}

export type VectorJson = {
  version: 1;
  engine: string;
  model: string;
  object?: {id: number; name: string};
  fps: number;
  w: number;
  h: number;
  frames: number;
  add: Array<Array<Outline | null>>;
  sub: Array<Array<Outline | null>>;
};

/** Slots by size rank: slot k on a frame is its k-th largest outline. */
function slots(perFrame: Array<Outline[] | null>): Array<Array<Outline | null>> {
  const n = perFrame.reduce((m, o) => Math.max(m, o?.length ?? 0), 0);
  return Array.from({length: n}, (_, k) => perFrame.map(o => o?.[k] ?? null));
}

/**
 * An object's track as Vector JSON. `frameMask(i)` is frame i's row-major
 * 0/1 mask, or null where the track has none.
 */
export function vectorJson(
  meta: {engine: string; model: string; object?: {id: number; name: string}; fps: number; w: number; h: number; frames: number},
  frameMask: (index: number) => ArrayLike<number> | null,
  opts: TraceOptions = {},
): VectorJson {
  const traced: Array<Traced | null> = [];
  for (let i = 0; i < meta.frames; i++) {
    const m = frameMask(i);
    traced.push(m == null ? null : traceMask(m, meta.w, meta.h, opts));
  }
  return {
    version: 1,
    engine: meta.engine,
    model: meta.model,
    ...(meta.object != null ? {object: meta.object} : {}),
    fps: meta.fps,
    w: meta.w,
    h: meta.h,
    frames: meta.frames,
    add: slots(traced.map(t => t?.pieces ?? null)),
    sub: slots(traced.map(t => t?.holes ?? null)),
  };
}
