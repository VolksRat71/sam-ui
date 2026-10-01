# sam-ui (Apache-2.0). New file, not from SAM 2.
"""End-to-end check of the per-object track cache against a running backend.

Uses synthetic videos (moving squares, generated in a temp folder), never
footage. It never writes into the backend's data folder: each clip goes in
through the uploadVideo mutation, and the script closes its sessions and
deletes its uploads (with their tracks) when it finishes, pass or fail. Point
it at a scratch backend; --api is required so it never defaults to one in use.

    python tools/track_cache_e2e.py --api http://127.0.0.1:7373               # phase 1
    # restart that backend, then:
    python tools/track_cache_e2e.py --api http://127.0.0.1:7373 --after-restart

    python tools/track_cache_e2e.py --api http://127.0.0.1:7373 --correction  # any time
    python tools/track_cache_e2e.py --api http://127.0.0.1:7373 --responsive  # any time
    python tools/track_cache_e2e.py --api http://127.0.0.1:7373 --absent      # any time
    python tools/track_cache_e2e.py --api http://127.0.0.1:7373 --bounded     # any time
    python tools/track_cache_e2e.py --api http://127.0.0.1:7373 --undo        # any time

Phase 1 leaves its upload for phase 2 (remembered in ~/.cache/sam-ui-e2e/),
which deletes it. A phase 1 that finds a leftover from an earlier run deletes
that first.

Phase 1: track A and B; add C and Track again (only C may run); clear B.
Phase 2: a new session must bring back A and C tracked and B untracked.
Correction: a two-tone bar tracked as one object, and its red half as a
second. On a frame only the job tracked, a lone negative click on the orange
half must cut just that half, and so must one on a second frame once the
first correction has made the track stale; the re-track must carry it to
later frames. A lone positive on the orange half must grow the red-only track
to the whole bar. (Plain SAM 2 empties a frame whose clicks are all negative;
the backend adds an anchor click inside the cached mask, tracks/anchor.py.)
Responsive: while a track job runs, a click on another object must answer in
well under a frame's worth of the job, and the job must still finish.
Absent: a red square leaves the shot on frame 12 and comes back elsewhere on
frame 20, while a look-alike stands in for it. Clicked once on each side and
marked absent 12-19 (setObjectRange), the job must stream the gap empty,
track both sides, refuse a click inside the gap, and re-track only the far
side after a far-side click. /export must write empty mattes for the gap.
Bounded: a red square crosses a look-alike mid-clip (160 frames). One negative
click on the frame where the cached track holds most of the look-alike must
re-track a bounded stretch (Objects-Bounded, /track_provenance), stream every
frame once, answer clicks on another object within 2 s while it runs, and
match a full re-track of the same seeds (full: true) within BOUNDED_MIN_IOU
on every frame and BOUNDED_MEAN_IOU on average. It prints frames re-tracked, both wall times
and the IoU against the full re-track.
Undo: square A tracked from one click; an accidental click on square B goes
to A and is re-tracked. undoSeeds must make A tracked again at once, with no
track job (the next job id follows the last one, and a Track press has
nothing to do), and its cached masks byte for byte the first track's; redo
brings the accidental track back the same way. A new session (a reload) must
still list both versions. An accidental click left stale must undo the same
way, and moveClicks must hand it to B while A gets its first track back.
"""
import argparse
import json
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "demo" / "backend" / "server"))
from tracks import rle  # noqa: E402

API = ""  # set from --api
REL = ""  # the uploaded clip's path, set by use_clip()
WORK = Path(tempfile.gettempdir()) / "sam-ui-e2e"
STATE = Path.home() / ".cache" / "sam-ui-e2e" / "state.json"
OPEN_SESSIONS = []
HEADERS = {}  # the last post_stream's response headers
N, H, W, S = 24, 240, 320, 50
SQUARES = {0: (20, 10, (220, 40, 40)), 1: (95, 260, (40, 60, 220)), 2: (170, 10, (40, 200, 60))}
A, B, C = 0, 1, 2


def make_video(path: Path):
    import av
    # a fresh background per run: every upload is unique, so no run deletes another's clip
    bg = np.random.default_rng().integers(90, 140, (H, W, 3), dtype=np.uint8)
    out = av.open(str(path), "w")
    st = out.add_stream("libx264", rate=24, options={"crf": "12"})
    st.width, st.height, st.pix_fmt = W, H, "yuv420p"
    for i in range(N):
        img = bg.copy()
        for obj, (y, x0, color) in SQUARES.items():
            x = x0 + 5 * i if x0 < W // 2 else x0 - 5 * i
            img[y:y + S, x:x + S] = color
        for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
            out.mux(pkt)
    for pkt in st.encode():
        out.mux(pkt)
    out.close()


def gql(query, variables=None):
    req = urllib.request.Request(f"{API}/graphql", json.dumps({"query": query, "variables": variables or {}}).encode(),
                                 {"Content-Type": "application/json"})
    out = json.load(urllib.request.urlopen(req))
    if out.get("errors"):
        raise SystemExit(f"graphql error: {out['errors']}")
    return out["data"]


def post_stream(route, body):
    req = urllib.request.Request(f"{API}{route}", json.dumps(body).encode(), {"Content-Type": "application/json"})
    t0 = time.time()
    r = urllib.request.urlopen(req)
    data, ids = r.read(), r.headers.get("Objects-Tracked", "")
    HEADERS.clear()
    HEADERS.update(r.headers.items())
    frames, pos = [], 0
    while (h := data.find(b"Content-Length: ", pos)) != -1:
        n = int(data[h + 16:data.index(b"\r\n", h)])
        start = data.index(b"\r\n\r\n", h) + 4
        d = json.loads(data[start:start + n])
        pos = start + n
        if "done" in d:  # the closing part of a track job
            if not d["done"] or d.get("failed"):
                raise SystemExit(f"FAIL track job reported {d}")
            continue
        frames.append((d["frame_index"], {x["object_id"]: rle.decode(x["mask"]) for x in d["results"]}))
    return ids, frames, time.time() - t0


def upload(path: Path) -> str:
    """uploadVideo, as a multipart GraphQL request; returns uploads/<hash>.mp4."""
    boundary = uuid.uuid4().hex
    parts = [("operations", None, json.dumps({"query": "mutation($f: Upload!) { uploadVideo(file: $f) { path } }",
                                              "variables": {"f": None}}).encode()),
             ("map", None, json.dumps({"0": ["variables.f"]}).encode()),
             ("0", path.name, path.read_bytes())]
    body = b""
    for name, filename, data in parts:
        disp = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else "")
        body += f"--{boundary}\r\nContent-Disposition: {disp}\r\n".encode()
        body += (b"Content-Type: video/mp4\r\n" if filename else b"") + b"\r\n" + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{API}/graphql", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    out = json.load(urllib.request.urlopen(req))
    if out.get("errors"):
        raise SystemExit(f"upload failed: {out['errors']}")
    return out["data"]["uploadVideo"]["path"]


def use_clip(make, name: str) -> str:
    """Generate a clip in the temp folder, upload it, and make it the current one."""
    global REL
    WORK.mkdir(parents=True, exist_ok=True)
    local = WORK / name
    make(local)
    REL = upload(local)
    return REL


def cleanup(rel: str) -> None:
    """Close the sessions this run opened, then delete its upload and tracks."""
    while OPEN_SESSIONS:
        sid = OPEN_SESSIONS.pop()
        try:
            gql('mutation($s: String!) { closeSession(input: {sessionId: $s}) { success } }', {"s": sid})
        except SystemExit:
            pass
    try:
        gql('mutation($p: String!) { deleteVideo(input: {path: $p, purgeTracks: true, closeIdleSessions: true}) '
            '{ purged } }', {"p": rel})
        print(f"cleaned up {rel}")
    except SystemExit as err:
        print(f"WARN could not delete {rel}: {err}")


def start():
    d = gql('mutation($p: String!) { startSession(input: {path: $p}) { sessionId objects { objectId state } } }',
            {"p": REL})["startSession"]
    OPEN_SESSIONS.append(d["sessionId"])
    return d["sessionId"], {o["objectId"]: o["state"] for o in d["objects"]}


def click(sid, obj):
    y, x0, _ = SQUARES[obj]
    gql('mutation($i: AddPointsInput!) { addPoints(input: $i) { frameIndex } }',
        {"i": {"sessionId": sid, "frameIndex": 0, "objectId": obj, "clearOldPoints": True, "labels": [1],
               "points": [[(x0 + S / 2) / W, (y + S / 2) / H]]}})


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        raise SystemExit(1)


def phase1():
    sid, _ = start()
    gql('mutation($s: String!) { clearPointsInVideo(input: {sessionId: $s}) { success } }', {"s": sid})
    click(sid, A), click(sid, B)
    ids, frames, t = post_stream("/track_objects", {"session_id": sid})
    check(ids == "0,1" and len(frames) == N, f"first Track runs A and B over {N} frames ({t:.1f} s)")
    check(all(set(m) == {A, B} for _, m in frames), "the stream carries only A and B")
    click(sid, C)
    ids, frames, t2 = post_stream("/track_objects", {"session_id": sid})
    check(ids == "2" and all(set(m) == {C} for _, m in frames), f"second Track runs only C ({t2:.1f} s)")
    ids, frames, _ = post_stream("/track_objects", {"session_id": sid})
    check(ids == "" and frames == [], "a third Track has nothing to do")
    state = gql('mutation($s: String!) { clearTrack(input: {sessionId: $s, objectId: 1}) { state } }',
                {"s": sid})["clearTrack"]["state"]
    check(state == "untracked", "clearing B makes it untracked")
    states = {o["objectId"]: o["state"] for o in gql('query($s: String!) { objectTracks(sessionId: $s) '
                                                     '{ objectId state } }', {"s": sid})["objectTracks"]}
    check(states == {A: "tracked", B: "untracked", C: "tracked"}, f"objectTracks reads {states}")
    print("phase 1 done: restart the backend, then run with --after-restart")


def phase2():
    sid, states = start()
    check(states == {A: "tracked", B: "untracked", C: "tracked"}, f"after a restart startSession reads {states}")
    ids, frames, _ = post_stream("/track_masks", {"session_id": sid})
    check(len(frames) == N and all(set(m) == {A, C} for _, m in frames), "cached tracks for A and C stream back")
    ids, frames, t = post_stream("/track_objects", {"session_id": sid})
    check(ids == "1", f"Track after the restart runs only B ({t:.1f} s)")


def make_twotone(path: Path, n=20):
    import av
    bg = np.random.default_rng().integers(90, 140, (H, W, 3), dtype=np.uint8)
    out = av.open(str(path), "w")
    st = out.add_stream("libx264", rate=24, options={"crf": "12"})
    st.width, st.height, st.pix_fmt = W, H, "yuv420p"
    for i in range(n):
        img = bg.copy()
        x = 30 + 5 * i
        img[100:150, x:x + 50] = (220, 40, 40)
        img[100:150, x + 50:x + 100] = (240, 170, 30)
        for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
            out.mux(pkt)
    for pkt in st.encode():
        out.mux(pkt)
    out.close()


def correction():
    use_clip(make_twotone, "twotone.mp4")
    sid, _ = start()
    gql('mutation($s: String!) { clearPointsInVideo(input: {sessionId: $s}) { success } }', {"s": sid})

    def add(obj, frame, pts, labels):
        d = gql('mutation($i: AddPointsInput!) { addPoints(input: $i) { rleMaskList { objectId rleMask '
                '{ size counts } } } }',
                {"i": {"sessionId": sid, "frameIndex": frame, "objectId": obj, "clearOldPoints": True,
                       "labels": labels, "points": pts}})["addPoints"]["rleMaskList"]
        return {m["objectId"]: rle.decode(m["rleMask"]) for m in d}[obj]

    def halves(m, g):
        xg = 30 + 5 * g
        return int(m[100:150, xg:xg + 50].sum()), int(m[100:150, xg + 50:xg + 100].sum())

    orange = lambda g: [(30 + 5 * g + 75) / W, 125 / H]
    add(0, 0, [[55 / W, 125 / H], [105 / W, 125 / H]], [1, 1])  # object 0: both halves
    add(1, 0, [[55 / W, 125 / H], [105 / W, 125 / H]], [1, 0])  # object 1: red only
    _, frames, _ = post_stream("/track_objects", {"session_id": sid})
    fr = dict(frames)
    check(sum(halves(fr[10][0], 10)) > 4800, "the job tracks the whole bar to frame 10")
    check(halves(fr[12][1], 12)[1] < 100, "and the red half alone as object 1")
    for g in (10, 15):  # a tracked frame, then one after the first correction made the track stale
        red0, orange0 = halves(fr[g][0], g)
        red, org = halves(add(0, g, [orange(g)], [0]), g)
        check(red > 0.9 * red0 and org < 100,
              f"a lone negative on frame {g} cuts only the orange half (red {red0} -> {red}, orange {orange0} -> {org})")
    red0, orange0 = halves(fr[12][1], 12)
    red, org = halves(add(1, 12, [orange(12)], [1]), 12)
    check(red > 0.9 * red0 and org > 2000,
          f"a lone positive on frame 12 grows the red half to the bar (red {red0} -> {red}, orange {orange0} -> {org})")
    _, frames, _ = post_stream("/track_objects", {"session_id": sid})
    fr = dict(frames)
    for g in (10, 15, 19):
        red, org = halves(fr[g][0], g)
        check(red > 2400 and org < 100, f"after the re-track, frame {g} is red only ({red} red, {org} orange px)")


GAP = (12, 19)


def make_gap(path: Path, n=30):
    """tests/test_ranges.py's clip: the square is gone on 12-19, a look-alike is not."""
    import av
    bg = np.random.default_rng().integers(90, 140, (H, W, 3), dtype=np.uint8)
    out = av.open(str(path), "w")
    st = out.add_stream("libx264", rate=24, options={"crf": "12"})
    st.width, st.height, st.pix_fmt = W, H, "yuv420p"
    for i in range(n):
        img = bg.copy()
        if i < GAP[0]:
            img[30:30 + S, 10 + 6 * i:10 + 6 * i + S] = (220, 40, 40)
        elif i > GAP[1]:
            x = 250 - 6 * (i - GAP[1] - 1)
            img[160:160 + S, x:x + S] = (220, 40, 40)
        else:
            img[100:100 + S, 180:180 + S] = (220, 40, 40)  # the look-alike
        for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
            out.mux(pkt)
    for pkt in st.encode():
        out.mux(pkt)
    out.close()


def gap_truth(i):
    m = np.zeros((H, W), bool)
    if i < GAP[0]:
        m[30:30 + S, 10 + 6 * i:10 + 6 * i + S] = True
    elif i > GAP[1]:
        x = 250 - 6 * (i - GAP[1] - 1)
        m[160:160 + S, x:x + S] = True
    return m


def absent():
    from PIL import Image

    use_clip(make_gap, "gap.mp4")
    sid, _ = start()
    gql('mutation($s: String!) { clearPointsInVideo(input: {sessionId: $s}) { success } }', {"s": sid})

    def add(frame):
        ys, xs = np.nonzero(gap_truth(frame))
        return gql('mutation($i: AddPointsInput!) { addPoints(input: $i) { frameIndex } }',
                   {"i": {"sessionId": sid, "frameIndex": frame, "objectId": 0, "clearOldPoints": True,
                          "labels": [1], "points": [[xs.mean() / W, ys.mean() / H]]}})

    def iou(a, b):
        u = (a | b).sum()
        return 1.0 if u == 0 else float((a & b).sum() / u)

    add(0), add(24)
    r = gql('mutation($i: SetObjectRangeInput!) { setObjectRange(input: $i) { state ranges { start end state } } }',
            {"i": {"sessionId": sid, "objectId": 0, "start": GAP[0], "end": GAP[1], "state": "absent"}})
    check(r["setObjectRange"]["ranges"] == [{"start": GAP[0], "end": GAP[1], "state": "absent"}],
          f"setObjectRange marks {GAP[0]}-{GAP[1]} absent")
    _, frames, t = post_stream("/track_objects", {"session_id": sid})
    fr = {f: m[0] for f, m in frames}
    check(sorted(f for f, _ in frames) == list(range(30)), f"the job streams every frame once ({t:.1f} s)")
    gap_px = [int(fr[f].sum()) for f in range(GAP[0], GAP[1] + 1)]
    check(not any(gap_px), f"the gap is empty ({gap_px})")
    near = min(iou(fr[f], gap_truth(f)) for f in range(GAP[0]))
    far = min(iou(fr[f], gap_truth(f)) for f in range(GAP[1] + 1, 30))
    check(near > 0.9 and far > 0.9, f"both sides track the square (min IoU near {near:.3f}, far {far:.3f})")
    req = urllib.request.Request(f"{API}/graphql", json.dumps({
        "query": 'mutation($i: AddPointsInput!) { addPoints(input: $i) { frameIndex } }',
        "variables": {"i": {"sessionId": sid, "frameIndex": 15, "objectId": 0, "clearOldPoints": True,
                            "labels": [1], "points": [[0.5, 0.5]]}}}).encode(), {"Content-Type": "application/json"})
    errors = json.load(urllib.request.urlopen(req)).get("errors") or []
    check(any("marked absent" in e.get("message", "") for e in errors), "a click inside the gap is refused")
    add(27)
    _, frames, t = post_stream("/track_objects", {"session_id": sid})
    fr = {f: m[0] for f, m in frames}
    check(sorted(fr) == list(range(30)) and not any(fr[f].any() for f in range(GAP[0], GAP[1] + 1)),
          f"a far-side click re-tracks with the gap still empty ({t:.1f} s, the near side from the cache)")
    out = Path.home() / "Movies" / f"sam-ui-e2e-absent-{uuid.uuid4().hex[:8]}"
    try:
        req = urllib.request.Request(f"{API}/export", json.dumps({"session_id": sid, "out_dir": str(out)}).encode(),
                                     {"Content-Type": "application/json"})
        json.load(urllib.request.urlopen(req))
        mattes = out / "data" / "mattes_tracked" / "object_0"
        lit = {i: int((np.asarray(Image.open(mattes / f"{i + 1:05d}.png")) > 127).sum()) for i in range(30)}
        check(not any(lit[f] for f in range(GAP[0], GAP[1] + 1)) and all(lit[f] for f in (0, 11, 20, 29)),
              "/export writes empty mattes for the gap, full ones on both sides")
    finally:
        import shutil
        shutil.rmtree(out, ignore_errors=True)


CN, CS = 160, 40  # the crossing clip: frames, square side
BOUNDED_MIN_IOU, BOUNDED_MEAN_IOU = 0.8, 0.99  # bounded vs full re-track: on every frame, on average


def cross_obj(i):
    return 100, int(10 + (W - 60) * i / (CN - 1))


def cross_distractor(i):
    return int(100 + 3 * (i - CN // 2)), cross_obj(CN // 2)[1]


def make_cross(path: Path):
    """A red square moving right; a look-alike moving down crosses it mid-clip."""
    import av
    bg = np.random.default_rng().integers(90, 140, (H, W, 3), dtype=np.uint8)
    out = av.open(str(path), "w")
    st = out.add_stream("libx264", rate=24, options={"crf": "12"})
    st.width, st.height, st.pix_fmt = W, H, "yuv420p"
    for i in range(CN):
        img = bg.copy()
        y, x = cross_distractor(i)
        if -CS < y < H:
            img[max(y, 0):y + CS, x:x + CS] = (215, 45, 45)
        y, x = cross_obj(i)
        img[y:y + CS, x:x + CS] = (220, 40, 40)
        for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
            out.mux(pkt)
    for pkt in st.encode():
        out.mux(pkt)
    out.close()


def cross_truth(i):
    m = np.zeros((H, W), bool)
    y, x = cross_obj(i)
    m[y:y + CS, x:x + CS] = True
    return m


def bounded_retrack():
    use_clip(make_cross, "cross.mp4")
    sid, _ = start()
    gql('mutation($s: String!) { clearPointsInVideo(input: {sessionId: $s}) { success } }', {"s": sid})

    def add(frame, pt, label):
        gql('mutation($i: AddPointsInput!) { addPoints(input: $i) { frameIndex } }',
            {"i": {"sessionId": sid, "frameIndex": frame, "objectId": 0, "clearOldPoints": True,
                   "labels": [label], "points": [pt]}})

    def iou(a, b):
        u = (a | b).sum()
        return 1.0 if u == 0 else float((a & b).sum() / u)

    y, x = cross_obj(0)
    add(0, [(x + CS / 2) / W, (y + CS / 2) / H], 1)
    _, frames, t0 = post_stream("/track_objects", {"session_id": sid})
    old = {f: m[0] for f, m in frames}
    check(sorted(old) == list(range(CN)), f"the first track covers all {CN} frames ({t0:.1f} s)")
    extra = {f: int((old[f] & ~cross_truth(f)).sum()) for f in range(CN)}
    c = max(extra, key=extra.get)
    if extra[c] > 50:  # the track holds some of the look-alike: cut it away there
        ys, xs = np.nonzero(old[c] & ~cross_truth(c))
        add(c, [(xs.mean() + .5) / W, (ys.mean() + .5) / H], 0)
        what = f"a negative click on the {extra[c]} look-alike px of frame {c}"
    else:  # a clean track: a refining click mid-clip
        c = CN // 2
        y, x = cross_obj(c)
        add(c, [(x + CS / 2) / W, (y + CS / 2) / H], 1)
        what = f"a refining click on frame {c} (the track held no look-alike)"
    import threading
    box, waits = {}, []

    def run():
        # object 0 only: the clicks below make object 1, which a job without ids would take too
        box["r"] = post_stream("/track_objects", {"session_id": sid, "object_ids": [0]})

    job = threading.Thread(target=run)
    job.start()
    while job.is_alive():  # clicks on another object while the bounded job runs: its lead-in and priming too
        t1 = time.time()
        gql('mutation($i: AddPointsInput!) { addPoints(input: $i) { frameIndex } }',
            {"i": {"sessionId": sid, "frameIndex": 0, "objectId": 1, "clearOldPoints": True, "labels": [1],
                   "points": [[0.9, 0.1]]}})
        waits.append(time.time() - t1)
        time.sleep(0.5)
    job.join()
    _, frames, t_b = box["r"]
    head = HEADERS.get("Objects-Bounded")
    check(head == "0", f"after {what}, the job re-tracks object 0 in a bounded pass ({t_b:.1f} s)")
    check(max(waits) < 2.0, f"{len(waits)} clicks during it answered in at most {max(waits):.2f} s "
                            f"(median {sorted(waits)[len(waits) // 2]:.2f} s; in order {[round(w, 2) for w in waits]})")
    bnd = {f: m[0] for f, m in frames}
    check(len(frames) == CN and sorted(bnd) == list(range(CN)), "and streams every frame once")
    prov = json.load(urllib.request.urlopen(urllib.request.Request(
        f"{API}/track_provenance", json.dumps({"session_id": sid, "object_id": 0}).encode(),
        {"Content-Type": "application/json"})))
    spans = prov["bounded"]
    n_re = sum(b - a + 1 for a, b in spans)
    check(prov["state"] == "tracked" and 0 < n_re < CN,
          f"it re-tracked {n_re} of {CN} frames ({spans}) and the object is tracked")
    _, frames, t_full = post_stream("/track_objects", {"session_id": sid, "object_ids": [0], "full": True})
    full = {f: m[0] for f, m in frames}
    check(sorted(full) == list(range(CN)), f"a full re-track of the same seeds ({t_full:.1f} s)")
    v = [iou(bnd[f], full[f]) for f in range(CN)]
    w = int(np.argmin(v))
    check(min(v) > BOUNDED_MIN_IOU and np.mean(v) > BOUNDED_MEAN_IOU,
          f"bounded vs full re-track: min IoU {min(v):.4f} (frame {w}: IoU vs the square bounded "
          f"{iou(bnd[w], cross_truth(w)):.3f}, full {iou(full[w], cross_truth(w)):.3f}), mean {np.mean(v):.4f} "
          f"over all {CN} frames")


def cached_counts(sid, obj):
    """{frame: RLE counts} of the object's cached track, as /track_masks streams it, undecoded."""
    req = urllib.request.Request(f"{API}/track_masks", json.dumps({"session_id": sid, "object_ids": [obj]}).encode(),
                                 {"Content-Type": "application/json"})
    data, out, pos = urllib.request.urlopen(req).read(), {}, 0
    while (h := data.find(b"Content-Length: ", pos)) != -1:
        n = int(data[h + 16:data.index(b"\r\n", h)])
        start = data.index(b"\r\n\r\n", h) + 4
        d = json.loads(data[start:start + n])
        pos = start + n
        for r in d.get("results", []):
            if r["object_id"] == obj:
                out[d["frame_index"]] = r["mask"]["counts"]
    return out


OBJ = "objectId state seeds { frameIndex } history { canUndo canRedo versions { key engine clicks created current } }"


def undo_check():
    use_clip(make_video, "squares.mp4")
    sid, _ = start()
    gql('mutation($s: String!) { clearPointsInVideo(input: {sessionId: $s}) { success } }', {"s": sid})

    def add(obj, frame, sq):
        y, x0, _ = SQUARES[sq]
        x = x0 + 5 * frame if x0 < W // 2 else x0 - 5 * frame
        gql('mutation($i: AddPointsInput!) { addPoints(input: $i) { frameIndex } }',
            {"i": {"sessionId": sid, "frameIndex": frame, "objectId": obj, "clearOldPoints": True, "labels": [1],
                   "points": [[(x + S / 2) / W, (y + S / 2) / H]]}})

    def obj(o):
        return next(x for x in gql(f'query($s: String!) {{ objectTracks(sessionId: $s) {{ {OBJ} }} }}',
                                   {"s": sid})["objectTracks"] if x["objectId"] == o)

    def step(name, o=A):
        t0 = time.time()
        d = gql(f'mutation($i: SeedHistoryInput!) {{ {name}(input: $i) {{ {OBJ} }} }}',
                {"i": {"sessionId": sid, "objectId": o}})[name]
        return d, time.time() - t0

    add(A, 0, A)
    _, _, t1 = post_stream("/track_objects", {"session_id": sid})
    first_job = HEADERS["Job-Id"]
    original = cached_counts(sid, A)
    check(len(original) == N and obj(A)["state"] == "tracked", f"A is tracked over {N} frames ({t1:.1f} s)")
    add(A, 6, B)  # the accident: a click on B while A is selected
    check(obj(A)["state"] == "stale", "an accidental click on B makes A stale")
    _, _, t2 = post_stream("/track_objects", {"session_id": sid})
    second_job = HEADERS["Job-Id"]
    wrong = cached_counts(sid, A)
    check(wrong != original, f"re-tracked, A's track now takes in B ({t2:.1f} s)")
    vs = obj(A)["history"]["versions"]
    check(len(vs) == 2 and vs[0]["current"] and [v["clicks"] for v in vs] == [2, 1],
          f"A keeps two versions: {[(v['clicks'], v['created']) for v in vs]}")

    d, t = step("undoSeeds")
    check(d["state"] == "tracked" and [s["frameIndex"] for s in d["seeds"]] == [0],
          f"undo makes A tracked at once, with its one click ({t * 1000:.0f} ms)")
    check(json.load(urllib.request.urlopen(urllib.request.Request(
        f"{API}/track_jobs", json.dumps({"session_id": sid}).encode(),
        {"Content-Type": "application/json"})))["jobs"] == [], "no track job is running")
    check(cached_counts(sid, A) == original, "A's cached masks are the first track's, byte for byte")
    d, t = step("redoSeeds")
    check(d["state"] == "tracked" and cached_counts(sid, A) == wrong,
          f"redo brings the accidental track back the same way ({t * 1000:.0f} ms)")
    step("undoSeeds")

    sid2, states = start()  # a reload
    sid, sid_old = sid2, sid
    check(states[A] == "tracked" and len(obj(A)["history"]["versions"]) == 2 and obj(A)["history"]["canRedo"],
          "a new session still lists both versions and can redo")

    add(A, 6, B)  # the same accident again: the same seeds, if SAM 2 gives the same mask
    print(f"NOTE the same accident again reads {obj(A)['state']} (tracked when SAM 2 repeats its mask exactly)")
    step("undoSeeds")
    add(A, 10, B)  # a new accident, never tracked
    check(obj(A)["state"] == "stale", "a new accidental click on frame 10 makes A stale")
    d, t = step("undoSeeds")
    check(d["state"] == "tracked" and cached_counts(sid, A) == original,
          f"undo of a stale accident: tracked, first track's masks ({t * 1000:.0f} ms)")

    add(A, 10, B)
    moved = gql(f'mutation($i: MoveClicksInput!) {{ moveClicks(input: $i) {{ {OBJ} }} }}',
                {"i": {"sessionId": sid, "frameIndex": 10, "fromObjectId": A, "toObjectId": B}})["moveClicks"]
    a, b = moved
    check(a["state"] == "tracked" and [s["frameIndex"] for s in a["seeds"]] == [0] and cached_counts(sid, A) == original,
          "moveClicks takes the click off A, which gets its first track back")
    check([s["frameIndex"] for s in b["seeds"]] == [10] and b["history"]["canUndo"], "and gives it to B, undoably")
    ids, _, t3 = post_stream("/track_objects", {"session_id": sid})
    third_job = HEADERS["Job-Id"]
    n = lambda j: int(j.split("-")[1])
    check(ids == "1" and n(third_job) == n(second_job) + 1,
          f"no job ran for any undo, redo or move: the next one is {third_job} after {second_job} "
          f"(first {first_job}), and it runs only B ({t3:.1f} s)")
    del sid_old


def responsive():
    import threading
    sid, _ = start()
    gql('mutation($s: String!) { clearPointsInVideo(input: {sessionId: $s}) { success } }', {"s": sid})
    click(sid, A), click(sid, B)
    box = {}

    def run():
        box["ids"], box["frames"], box["t"] = post_stream("/track_objects", {"session_id": sid})

    t = threading.Thread(target=run)
    t.start()
    time.sleep(4)  # the job is propagating by now
    t0 = time.time()
    click(sid, C)
    waited = time.time() - t0
    t.join()
    check(len(box["frames"]) == N, f"the job ran all {N} frames ({box['t']:.1f} s)")
    check(waited < 2.0, f"a click during the job answered in {waited:.2f} s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", required=True, help="a scratch backend, e.g. http://127.0.0.1:7373")
    ap.add_argument("--after-restart", action="store_true")
    ap.add_argument("--correction", action="store_true")
    ap.add_argument("--responsive", action="store_true")
    ap.add_argument("--absent", action="store_true")
    ap.add_argument("--bounded", action="store_true")
    ap.add_argument("--undo", action="store_true")
    a = ap.parse_args()
    API = a.api.rstrip("/")
    if a.absent or a.bounded or a.undo:
        try:
            absent() if a.absent else bounded_retrack() if a.bounded else undo_check()
        finally:
            cleanup(REL)
    elif a.correction or a.responsive:
        try:
            correction() if a.correction else (use_clip(make_video, "squares.mp4"), responsive())
        finally:
            cleanup(REL)
    elif a.after_restart:
        if not STATE.exists():
            raise SystemExit("no phase 1 upload recorded: run phase 1 first")
        REL = json.loads(STATE.read_text())["path"]
        try:
            phase2()
        finally:
            cleanup(REL)
            STATE.unlink(missing_ok=True)
    else:
        if STATE.exists():  # a leftover from an earlier run that never reached phase 2
            cleanup(json.loads(STATE.read_text())["path"])
        use_clip(make_video, "squares.mp4")
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps({"path": REL, "api": API}))
        try:
            phase1()
        finally:
            while OPEN_SESSIONS:  # keep the upload for phase 2, but not the sessions
                sid = OPEN_SESSIONS.pop()
                gql('mutation($s: String!) { closeSession(input: {sessionId: $s}) { success } }', {"s": sid})
