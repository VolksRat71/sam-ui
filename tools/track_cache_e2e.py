# sam-ui (Apache-2.0). New file, not from SAM 2.
"""End-to-end check of the per-object track cache against a running backend.

Uses a synthetic video (three moving squares, generated here), never footage.

    python tools/track_cache_e2e.py --data-path "$DATA_PATH"            # phase 1
    # restart the backend, then:
    python tools/track_cache_e2e.py --data-path "$DATA_PATH" --after-restart

    python tools/track_cache_e2e.py --data-path "$DATA_PATH" --correction   # any time

Phase 1: track A and B; add C and Track again (only C may run); clear B.
Phase 2: a new session must bring back A and C tracked and B untracked.
Correction: a two-tone bar tracked as one object; on a frame only the job
tracked, a negative click on one half plus a positive on the other must keep
just that half, and the re-track must carry it to later frames. (A lone
negative click empties the mask in SAM 2, in Meta's own flow too: a
correction frame needs a positive click.)
"""
import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "demo" / "backend" / "server"))
from tracks import rle  # noqa: E402

API = "http://127.0.0.1:7263"
REL = "gallery/_sam_ui_e2e.mp4"
N, H, W, S = 24, 240, 320, 50
SQUARES = {0: (20, 10, (220, 40, 40)), 1: (95, 260, (40, 60, 220)), 2: (170, 10, (40, 200, 60))}
A, B, C = 0, 1, 2


def make_video(path: Path):
    import av
    bg = np.random.default_rng(0).integers(90, 140, (H, W, 3), dtype=np.uint8)
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


def start():
    d = gql('mutation($p: String!) { startSession(input: {path: $p}) { sessionId objects { objectId state } } }',
            {"p": REL})["startSession"]
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


TWO = "gallery/_sam_ui_twotone.mp4"


def make_twotone(path: Path, n=20):
    import av
    bg = np.random.default_rng(1).integers(90, 140, (H, W, 3), dtype=np.uint8)
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


def correction(data_path: Path):
    if not (data_path / TWO).exists():
        make_twotone(data_path / TWO)
    sid = gql('mutation($p: String!) { startSession(input: {path: $p}) { sessionId } }', {"p": TWO})["startSession"]["sessionId"]
    gql('mutation($s: String!) { clearPointsInVideo(input: {sessionId: $s}) { success } }', {"s": sid})

    def add(frame, pts, labels):
        gql('mutation($i: AddPointsInput!) { addPoints(input: $i) { frameIndex } }',
            {"i": {"sessionId": sid, "frameIndex": frame, "objectId": 0, "clearOldPoints": True,
                   "labels": labels, "points": pts}})

    add(0, [[55 / W, 125 / H], [105 / W, 125 / H]], [1, 1])  # both halves
    _, frames, _ = post_stream("/track_objects", {"session_id": sid})
    f, x = 10, 30 + 5 * 10
    c = dict(frames)[f][0]
    check(c[100:150, x:x + 100].sum() > 4800, "the job tracks the whole bar to frame 10")
    add(f, [[(x + 75) / W, 125 / H], [(x + 25) / W, 125 / H]], [0, 1])  # cut orange, keep red
    _, frames, _ = post_stream("/track_objects", {"session_id": sid})
    fr = dict(frames)
    for g in (10, 15, 19):
        xg = 30 + 5 * g
        red, orange = fr[g][0][100:150, xg:xg + 50].sum(), fr[g][0][100:150, xg + 50:xg + 100].sum()
        check(red > 2400 and orange < 100, f"after the correction, frame {g} is red only ({red} red, {orange} orange px)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-path", required=True, help="the backend's DATA_PATH")
    ap.add_argument("--after-restart", action="store_true")
    ap.add_argument("--correction", action="store_true")
    a = ap.parse_args()
    if a.correction:
        correction(Path(a.data_path))
        sys.exit(0)
    video = Path(a.data_path) / REL
    if not video.exists():
        make_video(video)
    phase2() if a.after_restart else phase1()
