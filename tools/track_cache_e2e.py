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

Phase 1 leaves its upload for phase 2 (remembered in ~/.cache/sam-ui-e2e/),
which deletes it. A phase 1 that finds a leftover from an earlier run deletes
that first.

Phase 1: track A and B; add C and Track again (only C may run); clear B.
Phase 2: a new session must bring back A and C tracked and B untracked.
Correction: a two-tone bar tracked as one object, and its red half as a
second. On a frame only the job tracked, a positive on the red half with a
negative on the orange half must cut just the orange half, and so must the
same pair on a second frame once the first correction has made the track
stale; the re-track must carry it to later frames. A lone positive on the
orange half must grow the red-only track to the whole bar. (SAM 2 needs a
positive on the frame: a lone negative is refused, see needs_positive.)
Responsive: while a track job runs, a click on another object must answer in
well under a frame's worth of the job, and the job must still finish.
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

    red_half = lambda g: [(30 + 5 * g + 25) / W, 125 / H]
    orange = lambda g: [(30 + 5 * g + 75) / W, 125 / H]
    add(0, 0, [[55 / W, 125 / H], [105 / W, 125 / H]], [1, 1])  # object 0: both halves
    add(1, 0, [[55 / W, 125 / H], [105 / W, 125 / H]], [1, 0])  # object 1: red only
    _, frames, _ = post_stream("/track_objects", {"session_id": sid})
    fr = dict(frames)
    check(sum(halves(fr[10][0], 10)) > 4800, "the job tracks the whole bar to frame 10")
    check(halves(fr[12][1], 12)[1] < 100, "and the red half alone as object 1")
    for g in (10, 15):  # a tracked frame, then one after the first correction made the track stale
        red0, orange0 = halves(fr[g][0], g)
        red, org = halves(add(0, g, [red_half(g), orange(g)], [1, 0]), g)
        check(red > 0.9 * red0 and org < 100,
              f"a positive on red and a negative on orange on frame {g} cut only the orange half "
              f"(red {red0} -> {red}, orange {orange0} -> {org})")
    red0, orange0 = halves(fr[12][1], 12)
    red, org = halves(add(1, 12, [orange(12)], [1]), 12)
    check(red > 0.9 * red0 and org > 2000,
          f"a lone positive on frame 12 grows the red half to the bar (red {red0} -> {red}, orange {orange0} -> {org})")
    _, frames, _ = post_stream("/track_objects", {"session_id": sid})
    fr = dict(frames)
    for g in (10, 15, 19):
        red, org = halves(fr[g][0], g)
        check(red > 2400 and org < 100, f"after the re-track, frame {g} is red only ({red} red, {org} orange px)")


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
    a = ap.parse_args()
    API = a.api.rstrip("/")
    if a.correction or a.responsive:
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
