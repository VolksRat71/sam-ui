# sam-ui (Apache-2.0). New file, not from SAM 2.
"""InferenceAPI with a stub SAM 2 predictor (no model): seeds recorded from
clicks, replay on a new session, corrections refining a tracked frame, and
track jobs sharing the session's decoded video. One slow test (SAM_UI_SLOW=1)
checks lone correction clicks on the real model."""
import os
from collections import OrderedDict
from pathlib import Path

import numpy as np
import pytest
import torch

from inference.data_types import (
    AddPointsRequest,
    ClearPointsInFrameRequest,
    ClearPointsInVideoRequest,
    RemoveObjectRequest,
    StartSessionRequest,
)
from inference.predictor import InferenceAPI
from tracks import rle
from tracks.engine import FakeEngine
from tracks.store import TRACKED, UNTRACKED

H = W = 16
R = 2  # a click paints (or cuts) a (2R)x(2R) square around it


def square(x, y):
    m = torch.zeros(H, W, dtype=torch.bool)
    cx, cy = int(x * W), int(y * H)
    m[max(cy - R, 0):cy + R, max(cx - R, 0):cx + R] = True
    return m


class StubPredictor:
    """SAM 2's video-predictor surface with simple mask rules that keep its
    real behaviour: a click refines the mask already on that frame (the
    previous output) or starts from empty; a positive point outside the mask
    adds a square, a negative one cuts it; and a frame whose points are all
    negative comes out empty, as it does in SAM 2 even with a mask prompt."""

    def __init__(self):
        self.init_calls, self.mask_calls, self.point_calls = 0, [], []

    def init_state(self, path, offload_video_to_cpu=False):
        self.init_calls += 1
        return {"images": object(), "num_frames": 6, "video_height": H, "video_width": W, "device": "cpu",
                "storage_device": "cpu", "offload_video_to_cpu": False, "offload_state_to_cpu": False,
                "point_inputs_per_obj": {}, "mask_inputs_per_obj": {}, "cached_features": {}, "constants": {},
                "obj_id_to_idx": OrderedDict(), "obj_idx_to_id": OrderedDict(), "obj_ids": [],
                "output_dict_per_obj": {}, "temp_output_dict_per_obj": {}, "frames_tracked_per_obj": {}}

    def _idx(self, st, obj_id):
        if obj_id not in st["obj_id_to_idx"]:
            i = len(st["obj_ids"])
            st["obj_id_to_idx"][obj_id], st["obj_idx_to_id"][i] = i, obj_id
            st["obj_ids"].append(obj_id)
            st["point_inputs_per_obj"][i] = {}
            st["temp_output_dict_per_obj"][i] = {"cond_frame_outputs": {}, "non_cond_frame_outputs": {}}
            st["output_dict_per_obj"][i] = {"cond_frame_outputs": {}, "non_cond_frame_outputs": {}}
        return st["obj_id_to_idx"][obj_id]

    @staticmethod
    def _logits(mask):
        return mask.float()[None, None] * 2 - 1  # [1, 1, H, W], >0 where the mask is, like pred_masks

    def _mask(self, st, i, frame):
        out = st["temp_output_dict_per_obj"][i]["cond_frame_outputs"].get(frame)
        return torch.zeros(H, W, dtype=torch.bool) if out is None else out["pred_masks"][0, 0] > 0

    def _out(self, st, frame):
        logits = torch.cat([self._logits(self._mask(st, st["obj_id_to_idx"][o], frame)) for o in st["obj_ids"]])
        return frame, list(st["obj_ids"]), logits

    def add_new_mask(self, inference_state, frame_idx, obj_id, mask):
        self.mask_calls.append((frame_idx, obj_id))
        i = self._idx(inference_state, obj_id)
        inference_state["point_inputs_per_obj"][i].pop(frame_idx, None)
        out = {"pred_masks": self._logits(torch.as_tensor(mask).bool())}
        inference_state["temp_output_dict_per_obj"][i]["cond_frame_outputs"][frame_idx] = out
        return self._out(inference_state, frame_idx)

    def add_new_points_or_box(self, inference_state, frame_idx, obj_id, points, labels, clear_old_points,
                              normalize_coords):
        assert normalize_coords is False
        self.point_calls.append((frame_idx, obj_id, [list(map(float, p)) for p in points], list(map(int, labels))))
        i = self._idx(inference_state, obj_id)
        old = inference_state["point_inputs_per_obj"][i].get(frame_idx)
        all_labels = ([] if clear_old_points or old is None else old["point_labels"][0].tolist()) + list(labels)
        inference_state["point_inputs_per_obj"][i][frame_idx] = {"point_labels": torch.tensor([all_labels])}
        m = self._mask(inference_state, i, frame_idx).clone()
        if 1 not in all_labels:
            m[:] = False
        else:
            for (x, y), l in zip(points, labels):
                if l == 0:
                    m &= ~square(x, y)
                elif not m[min(int(y * H), H - 1), min(int(x * W), W - 1)]:
                    m |= square(x, y)
        inference_state["temp_output_dict_per_obj"][i]["cond_frame_outputs"][frame_idx] = {"pred_masks": self._logits(m)}
        return self._out(inference_state, frame_idx)

    def clear_all_prompts_in_frame(self, st, frame_idx, obj_id):
        i = st["obj_id_to_idx"].get(obj_id)
        if i is not None:
            st["temp_output_dict_per_obj"][i]["cond_frame_outputs"].pop(frame_idx, None)
            st["point_inputs_per_obj"][i].pop(frame_idx, None)
        return self._out(st, frame_idx)

    def remove_object(self, st, obj_id):
        return list(st["obj_ids"]), []

    def reset_state(self, st):
        for k in ("obj_ids", "point_inputs_per_obj", "mask_inputs_per_obj", "output_dict_per_obj",
                  "temp_output_dict_per_obj", "obj_id_to_idx", "obj_idx_to_id"):
            st[k].clear()


@pytest.fixture
def world(tmp_path):
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"frames")
    stub = StubPredictor()

    def api():
        a = InferenceAPI(predictor=stub, tracks_root=str(tmp_path / "tracks"))
        a.tracks.engine = FakeEngine(n_frames=6, shape=(H, W))  # jobs: deterministic masks
        return a

    return api, stub, str(video)


def start(api, path):
    return api.start_session(StartSessionRequest(type="start_session", path=path)).session_id


def click(api, sid, obj, frame, points, labels, clear=True):
    r = api.add_points(AddPointsRequest(type="add_points", session_id=sid, frame_index=frame, object_id=obj,
                                        points=points, labels=labels, clear_old_points=clear))
    return {v.object_id: rle.decode({"size": v.mask.size, "counts": v.mask.counts}) for v in r.results}


def test_a_click_records_its_points_and_the_mask_it_made(world):
    make, _, path = world
    a = make()
    sid = start(a, path)
    out = click(a, sid, 1, 2, [[0.5, 0.5]], [1])
    seed = a.object_tracks(sid)[0]["seeds"][2]
    assert seed["points"] == [[0.5, 0.5]] and seed["labels"] == [1]
    assert (rle.decode(seed["mask"]) == out[1]).all() and out[1].sum() == (2 * R) ** 2


def test_a_new_session_replays_approved_masks_frame_major(world):
    make, stub, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 2, 3, [[0.5, 0.5]], [1])
    click(a, sid, 1, 3, [[0.2, 0.2]], [1])
    click(a, sid, 1, 0, [[0.8, 0.8]], [1])
    stub.mask_calls.clear()
    b = make()  # a restart
    start(b, path)
    assert stub.mask_calls == [(0, 1), (3, 1), (3, 2)]  # (frame, object) order, as masks


def test_a_correction_on_a_tracked_frame_refines_the_cached_mask(world):
    make, _, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 0, [[0.5, 0.5]], [1])
    ctx = a.track_context(sid)
    list(ctx.service.track(ctx.video, ctx.path, [1], video_handle=ctx.video_handle))
    cached = rle.decode(a.tracks.tracks.mask_at(ctx.video, 1, "fake", 4))
    assert cached.any()
    # one negative click on frame 4, which only the job tracked: it must cut the cached mask, not start empty
    ys, xs = cached.nonzero()
    x, y = (xs[0] + 0.5) / W, (ys[0] + 0.5) / H
    out = click(a, sid, 1, 4, [[x, y]], [0])
    assert out[1].any() and (out[1] <= cached).all() and out[1].sum() < cached.sum()
    assert a.object_tracks(sid)[0]["state"] != TRACKED  # the correction made it stale


def test_a_job_shares_the_sessions_decoded_video_and_seeds_with_masks(world):
    make, stub, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 0, [[0.5, 0.5]], [1])
    from tracks.engine import Sam2Engine

    a.tracks.engine = Sam2Engine(stub, model="stub")
    job_states = []

    def propagate(st, start_frame_idx, reverse=False):
        job_states.append(st)
        return iter(())

    stub.propagate_in_video = propagate
    stub.mask_calls.clear()
    ctx = a.track_context(sid)
    list(ctx.service.track(ctx.video, ctx.path, [1], video_handle=ctx.video_handle))
    session_state = a.session_states[sid]["state"]
    assert stub.init_calls == 1  # the session's; the job cloned it
    assert job_states and job_states[0] is not session_state
    assert job_states[0]["images"] is session_state["images"]  # the same decoded frames, not a copy
    assert stub.mask_calls == [(0, 1)]  # conditioned on the approved mask, not replayed clicks
    assert session_state["obj_ids"] == [1]  # and the session's objects were left alone


def tracked(make, path, obj=1):
    """A session with one click on frame 0 and a finished track of it."""
    a = make()
    sid = start(a, path)
    click(a, sid, obj, 0, [[0.5, 0.5]], [1])
    ctx = a.track_context(sid)
    list(ctx.service.track(ctx.video, ctx.path, [obj], video_handle=ctx.video_handle))
    return a, sid, ctx


def corner(m):
    """A click on the mask's first pixel: its square cuts part of the mask, not all of it."""
    ys, xs = m.nonzero()
    return [(xs[0] + 0.5) / W, (ys[0] + 0.5) / H]


def test_a_correction_on_a_stale_track_still_starts_from_the_cached_mask(world):
    make, stub, path = world
    a, sid, ctx = tracked(make, path)
    click(a, sid, 1, 4, [corner(rle.decode(a.tracks.tracks.mask_at(ctx.video, 1, "fake", 4)))], [0])
    assert a.object_tracks(sid)[0]["state"] != TRACKED  # the first correction made the track stale
    # the next flagged frame is corrected against the same (now stale) track, not from nothing
    cached = rle.decode(a.tracks.tracks.mask_at(ctx.video, 1, "fake", 2))
    stub.mask_calls.clear()
    out = click(a, sid, 1, 2, [corner(cached)], [0])
    assert stub.mask_calls == [(2, 1)]
    assert out[1].any() and (out[1] <= cached).all() and out[1].sum() < cached.sum()


def test_a_lone_positive_on_a_stale_track_grows_the_cached_mask(world):
    make, _, path = world
    a, sid, ctx = tracked(make, path)
    click(a, sid, 1, 4, [[0.9, 0.9]], [1])  # stale now
    cached = rle.decode(a.tracks.tracks.mask_at(ctx.video, 1, "fake", 3))
    out = click(a, sid, 1, 3, [[0.9, 0.9]], [1])
    assert (out[1] >= cached).all() and out[1].sum() > cached.sum()


def test_a_second_negative_on_a_corrected_frame_keeps_refining(world):
    make, _, path = world
    a, sid, ctx = tracked(make, path)
    cached = rle.decode(a.tracks.tracks.mask_at(ctx.video, 1, "fake", 4))
    first = click(a, sid, 1, 4, [corner(cached)], [0])[1]
    ys, xs = first.nonzero()
    last = [(xs[-1] + 0.5) / W, (ys[-1] + 0.5) / H]
    # the client sends the frame's whole point list each time, replacing the old one
    second = click(a, sid, 1, 4, [corner(cached), last], [0, 0])[1]
    assert second.any() and (second <= first).all() and second.sum() < first.sum()


def test_the_anchor_point_is_not_recorded_as_a_seed(world):
    make, stub, path = world
    a, sid, ctx = tracked(make, path)
    p = corner(rle.decode(a.tracks.tracks.mask_at(ctx.video, 1, "fake", 4)))
    click(a, sid, 1, 4, [p], [0])
    _, _, sent, labels = stub.point_calls[-1]
    assert labels == [1, 0] and sent[1] == p  # SAM saw an anchor, then the click
    seed = a.object_tracks(sid)[0]["seeds"][4]
    assert seed["points"] == [p] and seed["labels"] == [0]  # the store keeps only the user's click


def test_an_empty_cached_frame_is_not_used_to_prime_a_click(world):
    make, stub, path = world
    a, sid, ctx = tracked(make, path)
    frames = dict(a.tracks.tracks.masks(ctx.video, 1, "fake"))
    frames[5] = rle.encode(torch.zeros(H, W, dtype=torch.bool).numpy())  # the object left the frame
    meta = a.tracks.tracks.meta(ctx.video, 1, "fake")
    a.tracks.tracks.save(ctx.video, 1, "fake", meta["model"], meta["seeds_hash"], frames, 0.0)
    stub.mask_calls.clear()
    out = click(a, sid, 1, 5, [[0.8, 0.8]], [1])
    assert stub.mask_calls == []  # nothing to refine: SAM starts from the click
    assert out[1].sum() == (2 * R) ** 2


def test_a_click_that_fails_after_a_prime_leaves_no_prime_behind(world):
    make, stub, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 0, [[0.5, 0.5]], [1])
    ctx = a.track_context(sid)
    list(ctx.service.track(ctx.video, ctx.path, [1]))
    real = stub.add_new_points_or_box

    def boom(*args, **kw):
        raise RuntimeError("MPS backend out of memory")

    stub.add_new_points_or_box = boom
    with pytest.raises(RuntimeError):
        click(a, sid, 1, 4, [[0.5, 0.5]], [1])
    stub.add_new_points_or_box = real
    st = a.session_states[sid]["state"]
    assert 4 not in st["temp_output_dict_per_obj"][st["obj_id_to_idx"][1]]["cond_frame_outputs"]
    assert 4 not in a.object_tracks(sid)[0]["seeds"]


def test_clear_frame_remove_object_and_start_over_keep_the_store_in_step(world):
    make, _, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 0, [[0.5, 0.5]], [1])
    click(a, sid, 2, 0, [[0.2, 0.2]], [1])
    a.clear_points_in_frame(ClearPointsInFrameRequest(type="clear_points_in_frame", session_id=sid,
                                                      frame_index=0, object_id=1))
    info = {o["object_id"]: o for o in a.object_tracks(sid)}
    assert info[1]["seeds"] == {} and info[1]["state"] == UNTRACKED
    a.remove_object(RemoveObjectRequest(type="remove_object", session_id=sid, object_id=2))
    assert [o["object_id"] for o in a.object_tracks(sid) if o["seeds"]] == []
    click(a, sid, 3, 1, [[0.5, 0.5]], [1])
    a.clear_points_in_video(ClearPointsInVideoRequest(type="clear_points_in_video", session_id=sid))
    assert a.object_tracks(sid) == []


def test_idle_sessions_expire_but_a_busy_one_is_kept(world, monkeypatch):
    make, _, path = world
    a = make()
    clock = [1000.0]
    monkeypatch.setattr("inference.predictor.time.time", lambda: clock[0])
    monkeypatch.setenv("SAM_UI_SESSION_TTL_MIN", "30")
    idle, busy, fresh = start(a, path), start(a, path), None
    job = a.tracks.jobs.claim(busy, "v", [1])
    clock[0] += 31 * 60
    fresh = start(a, path)  # a new session sweeps the idle ones
    assert set(a.session_states) == {busy, fresh}
    a.tracks.jobs.release(job)
    clock[0] += 29 * 60
    a.object_tracks(fresh)  # touching a session keeps it alive
    clock[0] += 2 * 60
    start(a, path)
    assert busy not in a.session_states and fresh in a.session_states


CKPT = Path(__file__).resolve().parents[3] / "checkpoints" / "sam2.1_hiera_large.pt"


def _twotone(path, n=20, h=240, w=320):
    """A red-and-orange bar moving right: one object whose halves SAM 2 can tell apart."""
    import av

    bg = np.random.default_rng(0).integers(90, 140, (h, w, 3), dtype=np.uint8)
    out = av.open(str(path), "w")
    st = out.add_stream("libx264", rate=24, options={"crf": "12"})
    st.width, st.height, st.pix_fmt = w, h, "yuv420p"
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


@pytest.mark.slow
@pytest.mark.skipif(not CKPT.exists() or os.environ.get("SAM_UI_SLOW") != "1",
                    reason="set SAM_UI_SLOW=1 with the large checkpoint in checkpoints/")
def test_real_sam2_lone_clicks_cut_and_grow_the_tracked_mask(tmp_path):
    from sam2.build_sam import build_sam2_video_predictor

    h, w = 240, 320
    _twotone(tmp_path / "bar.mp4")
    dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    pred = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_l.yaml", str(CKPT), device=dev)
    a = InferenceAPI(predictor=pred, device=torch.device(dev), tracks_root=str(tmp_path / "tracks"))
    sid = start(a, str(tmp_path / "bar.mp4"))
    y = 125 / h

    def halves(m, f):
        x = 30 + 5 * f
        return int(m[100:150, x:x + 50].sum()), int(m[100:150, x + 50:x + 100].sum())

    def track(obj):
        ctx = a.track_context(sid)
        with a.inference_lock, a.autocast_context():
            return {f: rle.decode(m[obj]) for f, m in ctx.service.track(ctx.video, ctx.path, [obj],
                                                                          video_handle=ctx.video_handle)}

    with torch.inference_mode():
        click(a, sid, 0, 0, [[55 / w, y], [105 / w, y]], [1, 1])  # object 0: the whole bar
        bar = track(0)
        click(a, sid, 1, 0, [[55 / w, y], [105 / w, y]], [1, 0])  # object 1: the red half only
        red = track(1)
        results = []
        # a lone negative on the orange half cuts just that half, on a tracked frame and then on
        # a second frame once the first correction has made the track stale
        for f in (10, 15):
            out = click(a, sid, 0, f, [[(30 + 5 * f + 75) / w, y]], [0])[0]
            (r0, o0), (r1, o1) = halves(bar[f], f), halves(out, f)
            keep = np.zeros_like(out)
            keep[:, :30 + 5 * f + 50] = True  # outside the clicked (orange) half
            iou = (out & bar[f] & keep).sum() / max(((out | bar[f]) & keep).sum(), 1)
            results.append(f"neg f{f}: area {bar[f].sum()} -> {out.sum()}, red {r0} -> {r1}, orange {o0} -> {o1}, "
                           f"IoU outside the click {iou:.3f}")
            assert 0 < out.sum() < bar[f].sum() and o1 < 0.05 * o0 and r1 > 0.9 * r0 and iou > 0.9
        # a lone positive on the orange half grows the red-only track to the whole bar
        for f in (12, 17):
            out = click(a, sid, 1, f, [[(30 + 5 * f + 75) / w, y]], [1])[1]
            (r0, o0), (r1, o1) = halves(red[f], f), halves(out, f)
            results.append(f"pos f{f}: area {red[f].sum()} -> {out.sum()}, red {r0} -> {r1}, orange {o0} -> {o1}")
            assert out.sum() > red[f].sum() and r1 > 0.9 * r0 and o1 > 2000
    print("\n" + "\n".join(results))
