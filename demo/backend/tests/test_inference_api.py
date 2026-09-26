# sam-ui (Apache-2.0). New file, not from SAM 2.
"""InferenceAPI with a stub SAM 2 predictor (no model): seeds recorded from
clicks, replay on a new session, corrections refining a tracked frame, and
track jobs sharing the session's decoded video."""
from collections import OrderedDict

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
    """SAM 2's video-predictor surface with simple mask rules: a click refines
    the mask already on that frame (the previous output) or starts from empty;
    a positive point adds a square, a negative one cuts it."""

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
            st["temp_output_dict_per_obj"][i] = {"cond_frame_outputs": {}, "non_cond_frame_outputs": {}}
            st["output_dict_per_obj"][i] = {"cond_frame_outputs": {}, "non_cond_frame_outputs": {}}
        return st["obj_id_to_idx"][obj_id]

    def _out(self, st, frame):
        masks = []
        for o in st["obj_ids"]:
            d = st["temp_output_dict_per_obj"][st["obj_id_to_idx"][o]]["cond_frame_outputs"]
            masks.append(d.get(frame, torch.zeros(H, W, dtype=torch.bool)))
        logits = torch.stack(masks).float()[:, None] * 2 - 1  # >0 where the mask is
        return frame, list(st["obj_ids"]), logits

    def add_new_mask(self, inference_state, frame_idx, obj_id, mask):
        self.mask_calls.append((frame_idx, obj_id))
        i = self._idx(inference_state, obj_id)
        inference_state["temp_output_dict_per_obj"][i]["cond_frame_outputs"][frame_idx] = torch.as_tensor(mask).bool()
        return self._out(inference_state, frame_idx)

    def add_new_points_or_box(self, inference_state, frame_idx, obj_id, points, labels, clear_old_points,
                              normalize_coords):
        assert normalize_coords is False
        self.point_calls.append((frame_idx, obj_id))
        i = self._idx(inference_state, obj_id)
        d = inference_state["temp_output_dict_per_obj"][i]["cond_frame_outputs"]
        m = d.get(frame_idx, torch.zeros(H, W, dtype=torch.bool)).clone()
        for (x, y), l in zip(points, labels):
            m = m | square(x, y) if l == 1 else m & ~square(x, y)
        d[frame_idx] = m
        return self._out(inference_state, frame_idx)

    def clear_all_prompts_in_frame(self, st, frame_idx, obj_id):
        i = st["obj_id_to_idx"].get(obj_id)
        if i is not None:
            st["temp_output_dict_per_obj"][i]["cond_frame_outputs"].pop(frame_idx, None)
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
    body = __import__("flask").Flask("x")
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


def test_a_job_shares_the_sessions_decoded_video(world):
    make, stub, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 0, [[0.5, 0.5]], [1])
    from tracks.engine import Sam2Engine

    a.tracks.engine = Sam2Engine(stub, model="stub")
    stub.propagate_in_video = lambda st, start_frame_idx, reverse=False: iter(())
    ctx = a.track_context(sid)
    list(ctx.service.track(ctx.video, ctx.path, [1], video_handle=ctx.video_handle))
    assert stub.init_calls == 1  # the session's; the job cloned it
    assert a.session_states[sid]["state"]["obj_ids"] == [1]  # and left the session's objects alone


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
