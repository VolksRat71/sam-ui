# sam-ui (Apache-2.0). New file, not from SAM 2.
"""The audit queue (draft 7): a short, ranked list of the places in a track a
person should look at, instead of every frame. The measure is how many frames
a person had to inspect before trusting the track.

Everything here is pure and reads only what a track already has: its cached
RLE masks (no model runs), its ranges, its provenance and, where two engines
track the object, their disagreement. studio/src/state/audit.ts is the same
code for the browser engine, and the two must agree.

1. frame_stats(): each frame's area, bounding box, centroid and number of
   pieces, read from the RLE runs without decoding the mask. Pieces are
   8-connected; one smaller than COMPONENT_MIN_FRACTION of the mask (or
   COMPONENT_MIN_PX) is a speck and is not counted.
2. signals(): the reasons a frame is worth a look, each with a strength in
   (0, 1] and a sentence saying why:
     flag       the user flagged it for a correction (#17);
     disagree   two engines' masks disagree (IoU under the threshold);
     start      the track starts after the clip's first frame;
     stop       the track stops (the object leaves, or the tracker loses it);
     reappear   it comes back after a gap or an absent range;
     area       the mask's area changes by AREA_JUMP or more in one frame;
     jump       the centroid lands JUMP_REL of the object's size away from
                where its recent motion puts it, or the box barely overlaps
                the predicted one (BOX_SURPRISE): a steady move is no jump;
     components the number of pieces changes;
     retrack    a bounded re-track (#19) starts or stops here (its seams),
                or, weaker (RETRACK_INSIDE), made this frame;
     candidate  an unconfirmed candidate range (draft 5) starts here, or
                resumes here after frames confirmed present or marked
                not here.
   Frames inside an absent range raise nothing, and nothing is compared
   across one. On a seed frame only a flag counts: the user drew that mask.
   A seed that asserts the object (a positive click, or a text seed:
   tracks/seeds.py confirmed()) confirms its frame present, and a cleared
   seed marks its frame not here: either way the user has checked that
   frame, so inside a candidate it is out of the queue and the candidate's
   review item sits on its first frame that is neither. Only the clicked
   frame counts, and nothing is stored: the queue derives it from the seeds.
   A cleared seed does not resolve the candidate (it stays a candidate in
   the timeline and a review item on its next unchecked frame), and when
   every frame of it is checked it raises nothing. A seed that is neither
   (a legacy anchor-trimmed one) can still hold the item: the one reason a
   seed frame keeps that it did not raise itself.
   A cleared seed ("not on this frame": negatives only, an empty mask) is
   no disappearance: its frame is passed over, so the frames either side
   of it are compared with each other (SAM 2 blanks that frame by design),
   and the track stopping into a cleared frame or an absent range (SAM 3
   keeps a cleared look-alike out for a while) is no stop. Coming back
   after one is still a reappearance.
3. locations(): per frame, a score (the WEIGHTS sum of its reasons), then
   non-maximum suppression: the best frame takes every frame with a reason
   within NMS_RADIUS of it (never across an absent range) into one location,
   which keeps each kind of reason once, at its strongest. A location's score
   is the weighted sum of those. Locations under MIN_SCORE are dropped and at
   most QUEUE_CAP are kept per object, so the queue ends.
4. rank(): every object's locations in one list, best first.
"""
import math
from collections import defaultdict
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from tracks import ranges as rng

# a frame's reasons, weighted: what it costs to miss each kind
WEIGHTS = {
    "flag": 3.0,
    "disagree": 2.0,
    "reappear": 1.5,
    "candidate": 1.5,
    "start": 1.0,
    "stop": 1.0,
    "area": 1.0,
    "jump": 1.0,
    "components": 1.0,
    "retrack": 1.0,
}
KINDS = tuple(WEIGHTS)

COMPONENT_MIN_FRACTION = 0.05  # a piece smaller than this share of the mask is a speck
COMPONENT_MIN_PX = 4
AREA_JUMP, AREA_FULL = 0.25, 0.75  # relative change of area: flagged from, full strength at
JUMP_REL, JUMP_FULL = 0.25, 1.0  # centroid off its predicted place, in object diagonals
BOX_SURPRISE, BOX_FULL = 0.5, 0.9  # 1 - IoU of the box with the predicted box
JUMP_HISTORY = 3  # recent frame-to-frame moves whose median predicts the next
DISAGREE_IOU = 0.8  # as TrackService.disagreement's default
RETRACK_INSIDE = 0.25  # strength on a frame a bounded pass made, between its seams
NMS_RADIUS = 10  # frames one location takes in, each way
QUEUE_CAP = 15  # locations kept per object
MIN_SCORE = 0.5

Stats = Dict  # {"area": int, "bbox": [x0, y0, x1, y1] | None, "centroid": [cx, cy] | None, "components": int}
Reason = Dict  # {"kind", "frame", "strength", "detail"}
Location = Dict  # {"frame", "start", "end", "score", "reasons": [Reason]}


# -- statistics from RLE ----------------------------------------------------------------

def counts(s: str) -> List[int]:
    """COCO's compressed RLE string as run lengths (pycocotools' rleFrString)."""
    out: List[int] = []
    p = 0
    while p < len(s):
        x, k, more = 0, 0, True
        while more:
            c = ord(s[p]) - 48
            x |= (c & 0x1F) << (5 * k)
            more = bool(c & 0x20)
            p += 1
            k += 1
            if not more and c & 0x10:
                x |= -1 << (5 * k)
        if len(out) > 2:
            x += out[-2]
        out.append(x)
    return out


def segments(rle: Dict) -> List[Tuple[int, int, int]]:
    """The mask's runs as (x, y0, y1) column segments, inclusive, in order.
    COCO runs are column-major and may wrap into the next column: split there."""
    h = int(rle["size"][0])
    out = []
    p = 0
    for i, n in enumerate(counts(rle["counts"])):
        if i % 2 == 1 and n > 0:
            end = p + n
            q = p
            while q < end:
                x, y0 = divmod(q, h)
                y1 = min(h - 1, y0 + (end - q) - 1)
                out.append((x, y0, y1))
                q += y1 - y0 + 1
        p += n
    return out


def _components(segs: Sequence[Tuple[int, int, int]]) -> List[int]:
    """The area of each 8-connected piece: segments in neighbouring columns
    join when their rows overlap or touch diagonally."""
    parent = list(range(len(segs)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    prev: List[int] = []  # indices of the previous column's segments
    cur: List[int] = []
    col = None
    for i, (x, y0, y1) in enumerate(segs):
        if x != col:
            prev = cur if col is not None and x == col + 1 else []
            cur, col = [], x
        for j in prev:
            _, b0, b1 = segs[j]
            if b0 <= y1 + 1 and y0 <= b1 + 1:
                ra, rb = find(i), find(j)
                if ra != rb:
                    parent[ra] = rb
        cur.append(i)
    areas: Dict[int, int] = defaultdict(int)
    for i, (_, y0, y1) in enumerate(segs):
        areas[find(i)] += y1 - y0 + 1
    return list(areas.values())


def frame_stats(rle: Dict) -> Stats:
    segs = segments(rle)
    if not segs:
        return {"area": 0, "bbox": None, "centroid": None, "components": 0}
    area = sx = sy = 0
    x0 = y0 = math.inf
    x1 = y1 = -1
    for x, a, b in segs:
        n = b - a + 1
        area += n
        sx += x * n
        sy += n * (a + b) / 2
        x0, x1 = min(x0, x), max(x1, x)
        y0, y1 = min(y0, a), max(y1, b)
    floor = max(COMPONENT_MIN_PX, COMPONENT_MIN_FRACTION * area)
    pieces = sum(1 for a in _components(segs) if a >= floor)
    return {"area": int(area), "bbox": [int(x0), int(y0), int(x1), int(y1)], "centroid": [sx / area, sy / area],
            "components": pieces}


# -- signals ------------------------------------------------------------------------------
# Numbers are rounded half up, as JavaScript's Math.round does, so the studio's
# twin writes the same strengths, scores and words (Python's round() goes to even).

def round3(v: float) -> float:
    return math.floor(v * 1000 + 0.5) / 1000


def fmt2(v: float) -> str:
    return f"{math.floor(v * 100 + 0.5) / 100:.2f}"


def pct(v: float) -> int:
    return int(math.floor(v * 100 + 0.5))


def _ramp(v: float, lo: float, hi: float) -> float:
    """0.5 at the threshold, 1 at full: any frame that crosses one counts."""
    return round3(0.5 + 0.5 * min(1.0, max(0.0, (v - lo) / (hi - lo))))


def _box_iou(a: Sequence[float], b: Sequence[float]) -> float:
    iw = min(a[2], b[2]) - max(a[0], b[0]) + 1
    ih = min(a[3], b[3]) - max(a[1], b[1]) + 1
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    union = (a[2] - a[0] + 1) * (a[3] - a[1] + 1) + (b[2] - b[0] + 1) * (b[3] - b[1] + 1) - inter
    return inter / union


def _diag(box: Sequence[float]) -> float:
    return math.hypot(box[2] - box[0] + 1, box[3] - box[1] + 1)


def _median(xs: List[float]) -> float:
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def _reason(kind: str, frame: int, strength: float, detail: str) -> Reason:
    return {"kind": kind, "frame": int(frame), "strength": round3(float(strength)), "detail": detail}


def signals(stats: Dict[int, Stats], n_frames: int, *, absent: Iterable[Dict] = (), candidates: Iterable[Dict] = (),
            disagreement: Optional[Dict[int, float]] = None, threshold: float = DISAGREE_IOU,
            pair: Tuple[str, str] = ("the engines", ""), bounded: Iterable[Sequence[int]] = (),
            flags: Iterable[int] = (), seeds: Iterable[int] = (),
            cleared: Iterable[int] = (), confirmed: Iterable[int] = ()) -> Dict[int, List[Reason]]:
    """{frame: [reason]} for the frames worth a look (see the module doc).
    `stats` is frame_stats() per frame; `absent` the object's absent ranges;
    `candidates` its candidate ranges as the timeline shows them;
    `disagreement` {frame: IoU} against another engine (`pair` names the
    two); `bounded` the [first, last] stretches bounded passes made; `flags`
    the user's flagged frames; `seeds` its frames with clicks; `cleared`
    those whose seed is cleared (tracks/seeds.py cleared()); `confirmed`
    those whose seed confirms the object present (tracks/seeds.py confirmed()).
    A candidate's item skips both."""
    absent = [r for r in rng.normalize(absent) if r["state"] == rng.ABSENT]
    out: Dict[int, List[Reason]] = defaultdict(list)

    def gone(f: int) -> bool:
        return rng.absent_at(absent, f)

    def there(f: int) -> bool:
        return 0 <= f < n_frames and f in stats and stats[f]["area"] > 0 and not gone(f)

    blank = set(int(f) for f in cleared)

    def passed_over(f: int) -> bool:  # a cleared seed's frame (one in an absent range stays a gap)
        return f in blank and not gone(f)

    def before(f: int) -> Optional[int]:
        g = f - 1
        while g >= 0 and passed_over(g):
            g -= 1
        return g if g >= 0 else None

    def after(f: int) -> Optional[int]:
        g = f + 1
        while g < n_frames and passed_over(g):
            g += 1
        return g if g < n_frames else None

    seen = False
    moves: List[Tuple[float, float]] = []  # the current run's frame-to-frame moves
    for f in range(n_frames):
        if passed_over(f):
            continue
        if not there(f):
            moves = []
            continue
        st = stats[f]
        p, q = before(f), after(f)
        if p is not None and not there(p):
            if seen:
                out[f].append(_reason("reappear", f, 1.0, "the object comes back after a gap"))
            else:
                out[f].append(_reason("start", f, 1.0, "the track starts here"))
        if q is not None and not there(q) and not (passed_over(f + 1) or gone(f + 1)):
            out[f].append(_reason("stop", f, 1.0, "the track stops after this frame"))
        seen = True
        if p is None or not there(p):
            continue
        pv, gap = stats[p], f - p
        a0, a1 = pv["area"], st["area"]
        rel = abs(a1 - a0) / max(a0, a1)
        if rel >= AREA_JUMP:
            span = "in one frame" if gap == 1 else f"across {gap - 1} cleared frame{'s' if gap > 2 else ''}"
            out[f].append(_reason("area", f, _ramp(rel, AREA_JUMP, AREA_FULL),
                                  f"the mask {'grows' if a1 > a0 else 'shrinks'} by {pct(rel)}% {span}"))
        if st["components"] != pv["components"]:
            out[f].append(_reason("components", f, 1.0,
                                  f"the mask goes from {pv['components']} to {st['components']} pieces"))
        vx = _median([m[0] for m in moves[-JUMP_HISTORY:]]) if moves else 0.0
        vy = _median([m[1] for m in moves[-JUMP_HISTORY:]]) if moves else 0.0
        vx, vy = vx * gap, vy * gap  # the predicted move, over the cleared frames too
        (cx0, cy0), (cx1, cy1) = pv["centroid"], st["centroid"]
        off = math.hypot(cx1 - (cx0 + vx), cy1 - (cy0 + vy)) / max(_diag(pv["bbox"]), _diag(st["bbox"]))
        b = pv["bbox"]
        surprise = 1 - _box_iou([b[0] + vx, b[1] + vy, b[2] + vx, b[3] + vy], st["bbox"])
        strength = max(_ramp(off, JUMP_REL, JUMP_FULL) if off >= JUMP_REL else 0.0,
                       _ramp(surprise, BOX_SURPRISE, BOX_FULL) if surprise >= BOX_SURPRISE else 0.0)
        if strength > 0:
            out[f].append(_reason("jump", f, strength,
                                  f"the mask moves {fmt2(off)} of its size off its course, and its box overlaps "
                                  f"the expected one by {pct(1 - surprise)}%"))
        moves.append(((cx1 - cx0) / gap, (cy1 - cy0) / gap))

    a_name, b_name = pair
    for f, iou in sorted((disagreement or {}).items()):
        f = int(f)
        if iou < threshold and 0 <= f < n_frames and not gone(f):
            who = f"{a_name} and {b_name}" if b_name else a_name
            out[f].append(_reason("disagree", f, _ramp(threshold - iou, 0, threshold),
                                  f"{who} disagree (IoU {fmt2(iou)})"))

    for a, b in bounded:
        for f in range(int(a), int(b) + 1):
            if gone(f) or not 0 <= f < n_frames:
                continue
            if f in (a, b):
                out[f].append(_reason("retrack", f, 1.0, f"a re-track near a correction {'starts' if f == a else 'stops'}"
                                                          f" here (frames {a + 1}-{b + 1})"))
            else:
                out[f].append(_reason("retrack", f, RETRACK_INSIDE, "made by a re-track near a correction"))

    seed_frames = set(int(f) for f in seeds) | blank
    for f in seed_frames:  # the user drew that mask: only their own flag still counts
        out.pop(f, None)

    sure = set(int(f) for f in confirmed)
    checked = sure | blank  # confirmed present, or marked not here: either way nothing left to look at
    for c in candidates:  # added after the seed frames: only a checked frame is skipped
        if c.get("state") != rng.CANDIDATE:
            continue
        f = next((g for g in range(c["start"], c["end"] + 1) if g not in checked), None)  # first unchecked
        if f is not None and 0 <= f < n_frames and not gone(f):
            score = f", score {fmt2(c['score'])}" if c.get("score") is not None else ""
            k = f - c["start"]
            skipped = range(c["start"], f)
            how = ("confirmed present" if all(g in sure for g in skipped) else
                   "marked not here" if all(g in blank for g in skipped) else
                   "confirmed present or marked not here")
            where = (f"starts here (frames {c['start'] + 1}-{c['end'] + 1})" if k == 0 else
                     f"resumes here (frames {c['start'] + 1}-{c['end'] + 1}; {k} frame{'s' if k > 1 else ''} "
                     f"{how} before it)")
            out[f].append(_reason("candidate", f, 1.0, f"an unconfirmed candidate range from {c.get('source')}{score} "
                                                       f"{where}"))
    for f in sorted(set(int(f) for f in flags)):
        if 0 <= f < n_frames and not gone(f):  # a flag left inside a range marked absent since
            out[f].append(_reason("flag", f, 1.0, "flagged for a correction"))
    return {f: rs for f, rs in sorted(out.items()) if rs}


# -- ranking ------------------------------------------------------------------------------

def frame_score(reasons: Iterable[Reason]) -> float:
    return sum(WEIGHTS[r["kind"]] * r["strength"] for r in reasons)


def locations(reasons: Dict[int, List[Reason]], n_frames: int, absent: Iterable[Dict] = (),
              radius: int = NMS_RADIUS, cap: int = QUEUE_CAP, min_score: float = MIN_SCORE) -> List[Location]:
    """Frames with reasons, merged by non-maximum suppression into a few
    locations, best first (see the module doc)."""
    wins = rng.windows([r for r in absent if r.get("state") == rng.ABSENT])

    def window_of(f: int) -> int:
        return next((i for i, w in enumerate(wins) if rng.in_window(f, w)), -1)

    # a frame inside an absent range is in no window, and never a stop
    scores = {f: frame_score(rs) for f, rs in reasons.items() if rs and window_of(f) >= 0}
    taken = set()
    out = []
    for f in sorted(scores, key=lambda g: (-scores[g], g)):
        if f in taken:
            continue
        w = window_of(f)
        members = [g for g in scores if g not in taken and abs(g - f) <= radius and window_of(g) == w]
        taken.update(members)
        best: Dict[str, Reason] = {}
        for g in sorted(members):
            for r in reasons[g]:
                if r["kind"] not in best or r["strength"] > best[r["kind"]]["strength"]:
                    best[r["kind"]] = r
        kept = sorted(best.values(), key=lambda r: (-WEIGHTS[r["kind"]] * r["strength"], r["frame"]))
        out.append({"frame": int(f), "start": int(min(members)), "end": int(max(members)),
                    "score": round3(frame_score(kept)), "reasons": kept})
    out = [loc for loc in out if loc["score"] >= min_score]
    out.sort(key=lambda loc: (-loc["score"], loc["frame"]))
    return out[:cap]


def rank(by_object: Dict[int, List[Location]]) -> List[Dict]:
    """Every object's locations in one queue, best first."""
    q = [{"object_id": int(o), **loc} for o, locs in by_object.items() for loc in locs]
    return sorted(q, key=lambda e: (-e["score"], e["object_id"], e["frame"]))
