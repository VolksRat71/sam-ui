# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Bounded re-tracks (issue #19): a correction re-tracks only the stretch of
frames it changes, forward and back from the corrected frame until the new
masks rejoin the cached track, and keeps the cached frames beyond."""
import json

import numpy as np
import pytest

from test_api import Harness, parse, parse_all
from test_engine import _StubPredictor
from tracks import rle
from tracks.bounded import AGREE_IOU, AGREE_RUN, Agreement, Stretch, changed_frames, frame_passes, seed_keys
from tracks.engine import FakeEngine, Sam2Engine
from tracks.ranges import ABSENT
from tracks.service import EngineSpec
from tracks.store import STALE, TRACKED

N = 60
INFLUENCE = 3  # the fake engine's correction changes frames within 2 of it


def seed(x=0.5, y=0.5, label=1):
    return {"points": [[x, y]], "labels": [label]}


def fix(x=0.3):
    """A correction seed: a positive with a negative (a lone negative is a cleared seed)."""
    return {"points": [[0.5, 0.5], [x, x]], "labels": [1, 0]}


NOT_HERE = {"points": [[0.5, 0.5]], "labels": [0]}  # cleared: no positive, no mask


class _NoStretches(FakeEngine):
    """An engine that cannot run a bounded pass (SAM 3, today)."""

    track_stretch = None


@pytest.fixture
def h(tmp_path):
    return Harness(tmp_path, engine=FakeEngine(n_frames=N, influence=INFLUENCE))


def by_frame(frames, obj=1):
    out = {}
    for f, m in frames:
        if obj in m:
            assert f not in out, f"frame {f} sent twice for object {obj}"
            out[f] = m[obj]
    return out


def stored(h, obj=1, engine="fake"):
    return dict(h.service.tracks.masks(h.video, obj, engine))


def meta(h, obj=1, engine="fake"):
    return h.service.tracks.meta(h.video, obj, engine)


def correct(h, frame, obj=1):
    """A positive with a negative: the correction the fake engine reacts to.
    (A lone negative is a cleared seed, 'not on this frame', since #26.)"""
    h.click(obj, frame=frame, points=[[0.5, 0.5], [0.3, 0.3]], labels=(1, 0))


# -- the pieces -------------------------------------------------------------------

def test_agreement_stops_after_a_run_of_frames_that_match_the_cache():
    a = np.zeros((8, 8), bool)
    a[2:6, 2:6] = True
    off = np.roll(a, 1, axis=0)
    cached = {f: rle.encode(a) for f in range(40)}
    stop = Agreement(cached)
    got = [stop(f, False, off if f < 13 else a) for f in range(10, 40)]
    # 10-12 differ; 13 onwards agree, and the 10th agreeing frame (22) ends it
    assert got.index(True) == 22 - 10 and stop.agreed[False]
    # a disagreement resets the run; each direction counts on its own
    stop = Agreement(cached, run=3)
    assert [stop(f, True, m) for f, m in [(9, a), (8, a), (7, off), (6, a), (5, a), (4, a)]] == \
        [False, False, False, False, False, True]
    assert stop.agreed == {True: True, False: False}
    # two empty masks agree (the object is gone in both)
    e = np.zeros((8, 8), bool)
    stop = Agreement({f: rle.encode(e) for f in range(5)}, run=2)
    assert [stop(f, False, e) for f in (1, 2)] == [False, True]
    # the lead-in: frames before the corrected one only check, and only the first `check` of them
    stop = Agreement(cached, start=10, corrected=20, check=3)
    assert [stop(f, False, a) for f in (10, 11, 12)] == [False] * 3 and not stop.failed
    assert stop(13, False, off) is False  # past the check: a lead-in frame may differ
    assert [stop(f, False, a) for f in range(20, 29)] == [False] * 9 and stop(29, False, a) is True
    stop = Agreement(cached, start=10, corrected=20, check=3)
    assert stop(10, False, a) is False and stop(11, False, off) is True and stop.failed
    assert AGREE_IOU == 0.98 and AGREE_RUN == 10


def test_changed_frames_are_the_new_or_edited_seeds_and_a_removal_is_none():
    old = {1: seed(), 5: seed(0.2), 30: seed(0.4)}
    keys = seed_keys(old)
    new = {1: seed(), 5: seed(0.2, label=0), 9: seed(0.6), 30: seed(0.4)}
    assert changed_frames(keys, new, (0, 20)) == [5, 9]  # 30 is in another window
    assert changed_frames(keys, new, (21, None)) == []
    assert changed_frames(keys, {1: seed(), 30: seed(0.4)}, (0, 20)) is None  # 5 went
    # the approved mask is part of a seed: a new mask on the same clicks is a change
    masked = {**old, 1: {**seed(), "mask": {"size": [2, 2], "counts": "04"}}}
    assert changed_frames(keys, masked, (0, None)) == [1]


def test_sam2_engine_runs_a_stretch_in_one_fresh_state_within_its_bounds():
    p = _StubPredictor(n=40)
    e = Sam2Engine(p, model="stub")
    seeds = {2: seed(), 20: fix(), 35: seed(0.6)}
    calls = []

    def stop(f, reverse, m):
        calls.append((f, reverse))
        return f in (24, 17)  # agreed there

    steps = list(e.track_stretch("v.mp4", Stretch(7, seeds, start=20, lo=10, hi=30, reverse=True), stop))
    assert steps[:3] == [None] * 3  # a step after each seed: the caller may let go of the model lock
    got = steps[3:]
    frames = [f for f, _ in got]
    assert frames == [20, 21, 22, 23, 24, 19, 18, 17]  # forward to the stop, then back from the start
    assert all(set(m) == {7} and m[7].dtype == bool for _, m in got)
    assert sorted((o, f) for o, f, *_ in p.added) == [(7, 2), (7, 20), (7, 35)]  # every seed of the window
    assert p.reset == 1
    # a hard bound ends a direction without asking
    p = _StubPredictor(n=40)
    got = [x[0] for x in Sam2Engine(p, model="stub").track_stretch(
        "v.mp4", Stretch(7, seeds, start=20, lo=18, hi=22, reverse=True), lambda *a: False) if x]
    assert got == [20, 21, 22, 19, 18]
    # without reverse: forward only
    p = _StubPredictor(n=40)
    got = [x[0] for x in Sam2Engine(p, model="stub").track_stretch(
        "v.mp4", Stretch(7, seeds, start=12, lo=0, hi=15, corrected=20), lambda *a: False) if x]
    assert got == [12, 13, 14, 15]


class _PrimingStub(_StubPredictor):
    """The stub, with the bits of SAM 2 that priming from the cache uses."""

    image_size = 8

    def __init__(self, n):
        super().__init__(n)
        self.primed = []

    def init_state(self, path, offload_video_to_cpu=False):
        return {"obj_ids": [], "device": "cpu", "output_dict_per_obj": {0: {"non_cond_frame_outputs": {}}}}

    def _obj_id_to_idx(self, state, obj_id):
        return 0

    def _run_single_frame_inference(self, inference_state, output_dict, frame_idx, mask_inputs, **kw):
        import torch
        assert tuple(mask_inputs.shape) == (1, 1, 8, 8) and kw["is_init_cond_frame"] is False
        # upstream runs this only under inference_mode: outside it, on the CPU,
        # the cached backbone features (inference tensors) raise "Inference
        # tensors cannot be saved for backward", and on MPS each primed output
        # keeps an autograd graph alive
        assert torch.is_inference_mode_enabled()
        self.primed.append(frame_idx)
        return {"pred_masks": mask_inputs}, mask_inputs


def test_a_stretch_starting_mid_window_is_primed_from_the_cache():
    p = _PrimingStub(n=60)
    e = Sam2Engine(p, model="stub")
    cached = {f: rle.encode(np.ones((4, 4), bool)) for f in range(60)}
    seeds = {0: seed(), 30: fix(), 22: seed()}
    got = list(e.track_stretch("v.mp4", Stretch(1, seeds, start=25, lo=0, hi=27, corrected=30, cached=cached,
                                                floor=12), lambda *a: False))
    # the PRIME (16) frames before the start, never before the window (12), never a seed frame (22)
    assert p.primed == [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24]
    # a None step after each seed and each primed frame, so the caller can let go of the model lock
    assert got[:15] == [None] * 15 and [f for f, _ in got[15:]] == [25, 26, 27]
    p.primed.clear()
    list(e.track_stretch("v.mp4", Stretch(1, seeds, start=22, lo=0, hi=23, cached=cached), lambda *a: False))
    assert p.primed == []  # a seed frame start has its seed


def test_sam2_engine_releases_the_stretch_state_on_cancel():
    p = _StubPredictor(n=40)
    it = Sam2Engine(p, model="stub").track_stretch("v.mp4", Stretch(7, {5: seed()}, 5, 0, 39), lambda *a: False)
    next(it)
    it.close()
    assert p.reset == 1


# -- the service ------------------------------------------------------------------

def test_a_one_frame_correction_retracks_a_bounded_stretch_and_keeps_the_rest(h):
    h.click(1, frame=0)
    h.track()
    before = stored(h)
    correct(h, 30)
    assert h.state(1) == STALE
    _, frames = h.track()
    got = by_frame(frames)
    assert sorted(got) == list(range(N))  # the stream still carries every frame, once
    # the fake's correction changes 28-32. The pass starts LEAD (20) frames
    # before it, primed from the cache, where its first AGREE_RUN frames
    # (10-19) agree, and runs forward until AGREE_RUN agree after it (33-42)
    assert h.engine.stretches == [(1, 10, 0, N - 1, list(range(10, 43)))]
    after = stored(h)
    assert all(after[f] == before[f] for f in range(N) if not 10 <= f <= 42)  # untouched, byte for byte
    assert all(not (rle.decode(after[f]) == FakeEngine.mask(1, f, h.engine.shape)).all() for f in range(28, 33))
    assert h.state(1) == TRACKED  # tracked for the new seeds


def test_the_bounded_result_matches_a_full_retrack(h):
    h.click(1, frame=0)
    h.track()
    correct(h, 30)
    h.track()
    bounded = stored(h)
    h.track([1])  # a tracked object asked for again: re-tracked whole
    assert len(h.engine.stretches) == 1  # no second bounded pass
    assert stored(h) == bounded


def test_provenance_says_which_pass_made_each_frame(h):
    h.click(1, frame=0)
    h.track()
    first = meta(h)
    assert [p["kind"] for p in first["passes"]] == ["full"]
    assert first["provenance"] == [[0, N - 1, first["passes"][0]["id"]]]
    correct(h, 30)
    h.track()
    m = meta(h)
    full, bounded = m["passes"]
    assert full == first["passes"][0]  # the first job's pass, as it was
    assert bounded["kind"] == "bounded" and bounded["start"] == 30 and bounded["frames"] == [10, 42]
    assert bounded["attempts"] == 1
    assert bounded["seeds_hash"] == m["seeds_hash"] and bounded["window"] == [0, None]
    assert bounded["stops"] == {"forward": "agreed", "backward": "agreed"}
    assert m["provenance"] == [[0, 9, full["id"]], [10, 42, bounded["id"]], [43, N - 1, full["id"]]]
    assert m["seed_keys"] == seed_keys(h.service.seeds.seeds(h.video, 1))
    fp = frame_passes(m)
    assert fp[9] == full["id"] and fp[10] == bounded["id"] and len(fp) == N


def test_a_later_full_retrack_drops_passes_no_frame_uses(h):
    h.click(1, frame=0)
    h.track()
    correct(h, 30)
    h.track()
    h.track([1])
    m = meta(h)
    assert [p["kind"] for p in m["passes"]] == ["full"] and m["provenance"] == [[0, N - 1, m["passes"][0]["id"]]]


def test_a_bounded_pass_stops_at_the_window_edge_and_never_enters_a_gap(h):
    h.click(1, frame=0), h.click(1, frame=50)
    h.service.set_range(h.video, 1, 40, 45, ABSENT)
    h.track()
    before = stored(h)
    correct(h, 36)
    _, frames = h.track()
    (o, start, lo, hi, ran), = h.engine.stretches
    assert (start, lo, hi) == (16, 0, 39) and max(ran) == 39 and not set(ran) & set(range(40, N))
    after = stored(h)
    assert all(after[f] == before[f] for f in range(40, N))  # the gap and the far window: kept
    assert meta(h)["passes"][-1]["stops"] == {"forward": "edge", "backward": "agreed"}
    assert h.engine.units[-1:] == [(46, None, {1: [50]})]  # the far window ran only in the first job
    assert sorted(by_frame(frames)) == list(range(N)) and h.state(1) == TRACKED


def test_two_corrections_near_each_other_recompute_each_frame_once(h):
    h.click(1, frame=0)
    h.track()
    correct(h, 20), correct(h, 26)
    _, frames = h.track()
    (_, s1, lo1, hi1, ran1), (_, s2, lo2, hi2, ran2) = h.engine.stretches
    # the first starts at the first seed (20 - LEAD is no earlier) and stops
    # short of the second correction, whose pass starts where it stopped
    assert (s1, hi1) == (0, 25) and (s2, lo2) == (26, 26)
    assert ran1 == list(range(0, 26)) and ran2 == list(range(26, 39))
    assert sorted(by_frame(frames)) == list(range(N))


def test_a_change_that_reaches_further_back_starts_the_pass_earlier(tmp_path):
    h = Harness(tmp_path, engine=FakeEngine(n_frames=100, influence=15))  # 46-74 change
    h.click(1, frame=0)
    h.track()
    before = stored(h)
    correct(h, 60)
    _, frames = h.track()
    (_, s1, _, _, ran1), (_, s2, _, _, ran2) = h.engine.stretches
    assert (s1, ran1[-1]) == (40, 46)  # the lead-in failed on 46: dropped, unsent
    assert (s2, ran2) == (20, list(range(20, 85)))  # from 20 its first frames agree
    assert sorted(by_frame(frames)) == list(range(100))  # once each, the failed start included
    after = stored(h)
    assert all(after[f] == before[f] for f in range(100) if not 20 <= f <= 84)
    p = meta(h)["passes"][-1]
    assert p["attempts"] == 2 and p["frames"] == [20, 84] and p["stops"] == {"forward": "agreed",
                                                                            "backward": "agreed"}


def test_a_bounded_job_lets_go_of_the_model_lock_on_every_frame_it_holds_back(tmp_path):
    """Lead-in frames are held back until the check passes, and a failed
    lead-in starts again: each of those is still a step of its own (None), so
    the job holds the model lock one frame at a time."""
    eng = FakeEngine(n_frames=100, influence=15)
    h = Harness(tmp_path, engine=eng)
    h.click(1, frame=0)
    h.track()
    correct(h, 60)
    log = []
    run = eng.track_stretch

    def logged(*a, **kw):
        for item in run(*a, **kw):
            log.append("made")
            yield item

    eng.track_stretch = logged
    steps = []
    for item in h.service.track(h.video, str(h.video_path), [1], n_frames=100, steps=True):
        log.append("step")
        steps.append(item)
    assert "made" in log and all(not (x == y == "made") for x, y in zip(log, log[1:]))  # never two at once
    frames = [s for s in steps if s is not None]
    assert sorted(f for f, _ in frames) == list(range(100))  # the frames, once each, as before
    assert steps.count(None) == len(eng.stretches[0][4]) + 10  # the failed start, and the held frames of the kept one
    # without steps (any other caller) there are none
    correct(h, 61)
    assert None not in list(h.service.track(h.video, str(h.video_path), [1], n_frames=100))


def test_the_route_never_counts_or_sends_a_step(tmp_path):
    h = Harness(tmp_path, engine=FakeEngine(n_frames=100, influence=15))
    h.click(1, frame=0)
    h.track()
    correct(h, 60)
    total = h.service.job_frames(h.video, [1], 100)
    _, frames = h.track()
    assert len(frames) == total == 100 and h.closing["tracked"] == [1]


def test_a_correction_of_the_first_seed_also_runs_back_from_it(h):
    h.click(1, frame=30)
    h.track()
    correct(h, 30)  # replaces the only seed: the first seed changed
    _, frames = h.track()
    assert h.engine.stretches == [(1, 30, 0, N - 1, list(range(30, 43)) + list(range(29, 17, -1)))]
    assert sorted(by_frame(frames)) == list(range(N))
    assert meta(h)["passes"][-1]["stops"] == {"forward": "agreed", "backward": "agreed"}


def test_a_removed_seed_retracks_its_window_whole(h):
    h.click(1, frame=0), h.click(1, frame=30)
    h.track()
    h.service.clear_frame(h.video, 1, 30)
    h.track()
    assert h.engine.stretches == [] and len(h.engine.calls) == 2


def test_an_engine_without_stretches_retracks_whole(tmp_path):
    h = Harness(tmp_path, engine=_NoStretches(n_frames=N, influence=INFLUENCE))
    h.click(1, frame=0)
    h.track()
    correct(h, 30)
    _, frames = h.track()
    assert len(h.engine.calls) == 2 and sorted(by_frame(frames)) == list(range(N))
    assert [p["kind"] for p in meta(h)["passes"]] == ["full"]


def test_a_track_from_before_provenance_retracks_whole_then_gains_it(h):
    h.click(1, frame=0)
    h.track()
    p = h.root / h.video / "1" / "fake" / "track.json"
    old = json.loads(p.read_text())
    for k in ("passes", "provenance", "seed_keys"):
        old.pop(k)
    p.write_text(json.dumps(old))  # what an older sam-ui wrote
    assert h.state(1) == TRACKED and len(frame_passes(meta(h))) == N  # it reads as one full pass
    correct(h, 30)
    h.track()
    assert h.engine.stretches == [] and len(h.engine.calls) == 2
    assert "seed_keys" in meta(h) and h.state(1) == TRACKED


def test_the_full_flag_skips_the_bounded_pass(h):
    h.click(1, frame=0)
    h.track()
    correct(h, 30)
    r = h.client.post("/track_objects", json={"session_id": "s", "full": True})
    assert sorted(by_frame(parse(r.data))) == list(range(N))
    assert h.engine.stretches == [] and len(h.engine.calls) == 2 and h.state(1) == TRACKED


def test_the_job_total_counts_every_part_a_bounded_job_sends(h):
    h.click(1, frame=0), h.click(2, frame=4)
    h.track()
    correct(h, 30)
    h.click(3, frame=2)  # a new object: tracked whole, in the same job
    ids = h.service.select(h.video)
    assert ids == [1, 3]
    total = h.service.job_frames(h.video, ids, N)
    _, frames = h.track()
    assert total == len(frames)
    assert sorted(by_frame(frames, 3)) == list(range(N)) and h.state(1) == h.state(3) == TRACKED


def test_the_running_job_says_which_objects_it_retracks_bounded(h):
    h.click(1, frame=0), h.click(2, frame=0)
    h.track()
    correct(h, 30)
    h.click(2, frame=0, points=[[0.4, 0.4]])  # the first seed of 2 changed: bounded too
    assert h.service.bounded_objects(h.video, [1, 2], N) == [1, 2]
    h.service.clear_track(h.video, 2)
    assert h.service.bounded_objects(h.video, [1, 2], N) == [1]
    r = h.client.post("/track_objects", json={"session_id": "s"})
    assert r.headers["Objects-Tracked"] == "1,2" and r.headers["Objects-Bounded"] == "1"
    parse(r.data)
    job = h.service.jobs.claim("s", h.video, [1, 2], N, "fake", bounded=[2, 9])
    assert job.info()["bounded"] == [2]  # only objects the job holds


def test_a_canceled_bounded_job_caches_nothing(h):
    h.click(1, frame=0)
    h.track()
    before = meta(h)
    correct(h, 30)
    it = h.service.track(h.video, str(h.video_path), [1], n_frames=N)
    next(it), next(it)
    it.close()
    assert meta(h) == before and h.state(1) == STALE


def test_the_disagreement_review_lists_the_bounded_stretches(h):
    h.service._specs["sam3"] = EngineSpec("sam3", "fake-1", lambda: _Named("sam3", n_frames=N))
    h.click(1, frame=0)
    h.track()
    correct(h, 30)
    h.track()
    parse(h.client.post("/track_objects", json={"session_id": "s", "engine": "sam3"}).data)
    d = h.service.disagreement(h.video, [1], "fake", "sam3")
    assert d["objects"]["1"]["bounded"] == {"fake": [[10, 42]], "sam3": []}


class _Named(FakeEngine):
    def __init__(self, name, **kw):
        super().__init__(**kw)
        self.name = name


def test_track_provenance_route(h):
    h.click(1, frame=0)
    assert h.client.post("/track_provenance", json={"session_id": "s", "object_id": 1}).status_code == 404
    h.track()
    correct(h, 30)
    h.track()
    got = h.client.post("/track_provenance", json={"session_id": "s", "object_id": 1}).json
    assert got["state"] == TRACKED and got["bounded"] == [[10, 42]]
    assert [p["kind"] for p in got["passes"]] == ["full", "bounded"] and len(got["provenance"]) == 3


# -- cleared seeds ('not on this frame', #26) in bounded passes ------------------------

class _Recording(_PrimingStub):
    """The priming stub, also noting where each propagation starts and every
    predictor method a job calls (`calls`, by name)."""

    def __init__(self, n):
        super().__init__(n)
        self.runs, self.calls = [], []

    def init_state(self, path, offload_video_to_cpu=False):
        self.calls.append("init_state")
        return super().init_state(path, offload_video_to_cpu)

    def add_new_points_or_box(self, *a, **kw):
        self.calls.append("add_new_points_or_box")
        return super().add_new_points_or_box(*a, **kw)

    def add_new_mask(self, *a, **kw):
        self.calls.append("add_new_mask")
        return super().add_new_mask(*a, **kw)

    def _run_single_frame_inference(self, *a, **kw):
        self.calls.append("_run_single_frame_inference")
        return super()._run_single_frame_inference(*a, **kw)

    def propagate_in_video(self, state, start_frame_idx, max_frame_num_to_track=None, reverse=False):
        self.calls.append("propagate_in_video")
        self.runs.append((start_frame_idx, reverse))
        yield from super().propagate_in_video(state, start_frame_idx, max_frame_num_to_track, reverse)

    def reset_state(self, state):
        self.calls.append("reset_state")
        return super().reset_state(state)


def frames_of(steps):
    return {f: m for f, m in (x for x in steps if x is not None)}


def test_a_stretch_never_seeds_a_cleared_frame_and_blanks_it_both_ways():
    """As a full pass (Sam2Engine.track, strip_cleared): SAM 2 is never handed
    an empty seed, and the frame comes out empty, to the caller and to stop."""
    p = _StubPredictor(n=40)
    seen = {}

    def stop(f, reverse, m):
        seen[f] = m.any()
        return False

    seeds = {2: seed(), 15: NOT_HERE, 20: fix(), 25: NOT_HERE}
    got = frames_of(Sam2Engine(p, model="stub").track_stretch(
        "v.mp4", Stretch(7, seeds, start=20, lo=10, hi=30, reverse=True), stop))
    assert [a[:2] for a in p.added] == [(7, 2), (7, 20)]  # 15 and 25 never reach the predictor
    assert sorted(got) == list(range(10, 31))
    assert not got[25][7].any() and not got[15][7].any()  # ahead of the start, and behind it
    assert all(got[f][7].all() for f in got if f not in (15, 25))
    assert seen[25] is np.False_ and seen[15] is np.False_ and seen[24] and seen[16]
    assert p.reset == 1


def test_a_stretch_whose_only_seed_is_cleared_yields_nothing():
    """As track() does for an object with only a cleared seed: no state, no frames."""
    p = _StubPredictor(n=40)
    got = list(Sam2Engine(p, model="stub").track_stretch(
        "v.mp4", Stretch(7, {20: NOT_HERE}, start=20, lo=10, hi=30, reverse=True), lambda *a: False))
    assert got == [] and p.added == [] and p.reset == 0


@pytest.fixture
def h3(tmp_path):
    """The service over the real Sam2Engine on a stub predictor that primes."""
    e = Sam2Engine(_Recording(n=N), model="stub")
    e.n_frames = N  # the clip's length, which a live session's video handle gives
    return Harness(tmp_path, engine=e)


def full_retrack(h, obj=1):
    """The same seeds re-tracked whole (a tracked object asked for again)."""
    bounded = stored(h, obj, "sam2")
    h.track([obj])
    assert [p["kind"] for p in meta(h, obj, "sam2")["passes"]][-1] == "full"
    return bounded, stored(h, obj, "sam2")


def blank_only(h, c, before, frames):
    """The job after clearing frame c: no model ran, c went out and is stored
    empty, every other frame is the cache byte for byte, and frame c is
    recorded as a bounded pass of its own over that one frame."""
    p = h.engine.predictor
    assert p.calls == []  # not a single predictor method
    got = by_frame(frames)
    after = stored(h, engine="sam2")
    assert sorted(got) == sorted(after) == sorted(before)
    assert not got[c].any() and not rle.decode(after[c]).any()
    assert all(after[f] == before[f] for f in before if f != c)
    m = meta(h, engine="sam2")
    last = m["passes"][-1]
    assert last["kind"] == "bounded" and last["start"] == c and last["frames"] == [c, c] and last["attempts"] == 0
    assert frame_passes(m)[c] == last["id"] and c in m["cleared_seeds"]
    return last


def test_a_cleared_seed_after_the_first_kept_seed_blanks_only_its_frame(h3):
    """Under SAM 2 a cleared seed never conditions the model, so a full
    re-track would change its frame only: the job blanks it and runs nothing."""
    p = h3.engine.predictor
    h3.click(1, frame=0)
    h3.track()
    before = stored(h3, engine="sam2")
    h3.click(1, frame=30, labels=(0,))  # 'not on this frame'
    p.calls.clear()
    _, frames = h3.track()
    blank_only(h3, 30, before, frames)
    assert h3.state(1) == TRACKED
    bounded, full = full_retrack(h3)
    assert bounded == full


def test_a_cleared_seed_before_the_first_kept_seed_blanks_only_its_frame(h3):
    """Before the window's first kept seed too: a full pass makes that frame
    in reverse from the seed, but blanks it, and nothing else depends on it."""
    p = h3.engine.predictor
    h3.click(1, frame=10)
    h3.track()
    before = stored(h3, engine="sam2")
    h3.click(1, frame=5, labels=(0,))
    p.calls.clear()
    _, frames = h3.track()
    blank_only(h3, 5, before, frames)
    bounded, full = full_retrack(h3)
    assert bounded == full


def test_editing_a_cleared_seed_still_blanks_only_its_frame(h3):
    """The track records which seeds were cleared (cleared_seeds), so moving
    a cleared seed's click is known not to have touched the conditioning."""
    p = h3.engine.predictor
    h3.click(1, frame=0), h3.click(1, frame=30, labels=(0,))
    h3.track()
    before = stored(h3, engine="sam2")
    h3.click(1, frame=30, points=[[0.2, 0.7]], labels=(0,))
    p.calls.clear()
    _, frames = h3.track()
    blank_only(h3, 30, before, frames)


def test_a_real_seed_that_becomes_cleared_retracks_its_window_whole(h3):
    """A positive seed made cleared leaves the conditioning, which moves other
    frames too: the window re-runs whole, as for a removed seed."""
    p = h3.engine.predictor
    h3.click(1, frame=0), h3.click(1, frame=30)
    h3.track()
    h3.click(1, frame=30, labels=(0,))
    p.calls.clear(), p.added.clear()
    _, frames = h3.track()
    m = meta(h3, engine="sam2")
    assert [x["kind"] for x in m["passes"]] == ["full"] and "propagate_in_video" in p.calls
    assert [f for _, f, *_ in p.added] == [0]  # 30 is not seeded
    assert not by_frame(frames)[30].any()


def test_a_cleared_seed_on_an_engine_that_conditions_on_it_still_runs_a_bounded_pass(h):
    """Only an engine that skips cleared seeds (SAM 2) takes the blank-only
    path; others (the fake here, SAM 3) keep their bounded pass."""
    h.click(1, frame=0)
    h.track()
    h.click(1, frame=30, labels=(0,))
    h.track()
    assert len(h.engine.stretches) == 1 and h.engine.stretches[0][1] == 10


def test_a_cleared_seed_inside_an_absent_window_blanks_only_its_frame(h3):
    p = h3.engine.predictor
    h3.click(1, frame=0), h3.click(1, frame=50)
    h3.service.set_range(h3.video, 1, 40, 45, ABSENT)
    h3.track()
    before = stored(h3, engine="sam2")
    h3.click(1, frame=55, labels=(0,))  # cleared, in the window (46, end) after the gap
    p.calls.clear()
    _, frames = h3.track()
    last = blank_only(h3, 55, before, frames)
    assert last["window"] == [46, None]
    got = by_frame(frames)
    assert not any(got[f].any() for f in range(40, 46))  # the gap stays empty
    bounded, full = full_retrack(h3)
    assert all(bounded[f] == full[f] for f in range(46, N)) and bounded == full


def test_a_cleared_first_seed_does_not_decide_where_a_bounded_pass_starts(h3):
    """A full pass starts at the window's first kept seed and runs back from
    it (Sam2Engine.plan). A bounded pass that reaches that seed does too,
    rather than starting earlier, primed, toward a cleared frame."""
    p = h3.engine.predictor
    h3.click(1, frame=2, labels=(0,))  # cleared, the window's first seed
    h3.click(1, frame=10)
    h3.track()
    assert p.runs == [(10, False), (10, True)]
    p.runs.clear()
    h3.click(1, frame=25, points=[[0.5, 0.5], [0.3, 0.3]], labels=(1, 0))
    _, frames = h3.track()
    assert p.runs == [(10, False), (10, True)] and p.primed == []  # from the first kept seed, back from it too
    got = by_frame(frames)
    assert not got[2].any() and got[3].all()
    bounded, full = full_retrack(h3)
    assert bounded == full


# -- the real model ---------------------------------------------------------------------

import os  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

CKPT = Path(__file__).resolve().parents[3] / "checkpoints" / "sam2.1_hiera_large.pt"
CN, CH, CW, CS = 160, 240, 320, 40
# bounded against a full re-track of the same seeds: on every frame, and on average
# (measured on MPS: min 0.933 on one frame of the crossing, mean 0.9985)
MIN_IOU_VS_FULL, MEAN_IOU_VS_FULL = 0.9, 0.99


def cross_obj(i):
    return 100, int(10 + (CW - 60) * i / (CN - 1))


def cross_video(path):
    """A red square moving right; a look-alike moving down crosses it mid-clip,
    where a track from one click on frame 0 takes in some of the look-alike."""
    import av
    bg = np.random.default_rng(3).integers(90, 140, (CH, CW, 3), dtype=np.uint8)
    truth = []
    out = av.open(str(path), "w")
    st = out.add_stream("libx264", rate=24, options={"crf": "12"})
    st.width, st.height, st.pix_fmt = CW, CH, "yuv420p"
    for i in range(CN):
        img = bg.copy()
        y, x = 100 + 3 * (i - CN // 2), cross_obj(CN // 2)[1]
        if -CS < y < CH:
            img[max(y, 0):y + CS, x:x + CS] = (215, 45, 45)
        y, x = cross_obj(i)
        img[y:y + CS, x:x + CS] = (220, 40, 40)
        m = np.zeros((CH, CW), bool)
        m[y:y + CS, x:x + CS] = True
        truth.append(m)
        for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
            out.mux(pkt)
    for pkt in st.encode():
        out.mux(pkt)
    out.close()
    return truth


@pytest.mark.slow
@pytest.mark.skipif(not CKPT.exists() or os.environ.get("SAM_UI_SLOW") != "1",
                    reason="set SAM_UI_SLOW=1 with the large checkpoint in checkpoints/")
def test_real_sam2_bounded_retrack_matches_a_full_retrack(tmp_path):
    import torch
    from sam2.build_sam import build_sam2_video_predictor

    from inference.predictor import InferenceAPI
    from test_inference_api import click, start
    from tracks.bounded import mask_iou
    from tracks.routes import _run_job

    truth = cross_video(tmp_path / "cross.mp4")
    dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    pred = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_l.yaml", str(CKPT), device=dev)
    a = InferenceAPI(predictor=pred, device=torch.device(dev), tracks_root=str(tmp_path / "tracks"))
    sid = start(a, str(tmp_path / "cross.mp4"))

    def track(full=False):
        """A job as /track_objects runs it (routes._run_job): the lock taken
        per step, no inference_mode around it."""
        ctx = a.track_context(sid)
        job = ctx.service.jobs.claim(sid, ctx.video, [1], None, "sam2")
        t0 = time.perf_counter()
        frames, closing = parse_all(b"".join(_run_job(ctx, job, full)))
        assert closing["done"] and closing["tracked"] == [1], closing
        got = {}
        for f, m in frames:
            assert f not in got
            got[f] = m[1]
        return got, time.perf_counter() - t0

    assert not torch.is_inference_mode_enabled()  # as in a job: the engine must bring its own
    y, x = cross_obj(0)
    click(a, sid, 1, 0, [[(x + CS / 2) / CW, (y + CS / 2) / CH]], [1])
    old, _ = track()
    extra = {f: int((old[f] & ~truth[f]).sum()) for f in range(CN)}
    c = max(extra, key=extra.get)
    if extra[c] > 50:  # cut the look-alike away where the track holds most of it
        # SAM 2 needs a positive on the frame (needs_positive): one on the square, the negative on the look-alike
        ys, xs = np.nonzero(old[c] & ~truth[c])
        y, x = cross_obj(c)
        click(a, sid, 1, c, [[(x + CS / 2) / CW, (y + CS / 2) / CH], [(xs.mean() + .5) / CW, (ys.mean() + .5) / CH]],
              [1, 0])
    else:  # a clean track: refine mid-clip
        c = CN // 2
        y, x = cross_obj(c)
        click(a, sid, 1, c, [[(x + CS / 2) / CW, (y + CS / 2) / CH]], [1])
    bnd, t_b = track()
    video = a.track_context(sid).video
    prov = a.tracks.provenance(video, 1)
    full, t_f = track(full=True)
    spans = prov["bounded"]
    inside = {f for s, e in spans for f in range(s, e + 1)}
    v = [mask_iou(bnd[f], full[f]) for f in range(CN)]
    print(f"\nbounded re-track: correction on frame {c} ({extra[c]} look-alike px in the cached mask); "
          f"re-tracked {len(inside)}/{CN} frames {spans} in {t_b:.1f} s against {t_f:.1f} s for a full "
          f"re-track; IoU vs full min {min(v):.4f} (frame {int(np.argmin(v))}) mean {np.mean(v):.4f}; "
          f"vs truth: bounded min {min(mask_iou(bnd[f], truth[f]) for f in range(CN)):.3f}, "
          f"full {min(mask_iou(full[f], truth[f]) for f in range(CN)):.3f}")
    assert prov["state"] == TRACKED and c in inside and 0 < len(inside) < CN
    assert all((bnd[f] == old[f]).all() for f in range(CN) if f not in inside)  # outside: the cache, untouched
    assert min(v) > MIN_IOU_VS_FULL and np.mean(v) > MEAN_IOU_VS_FULL

    # A mid-clip 'not on this frame' seed, stored as SAM 3 stores a lone negative
    # (its mask empty). SAM 2 never conditions on it, so the job blanks that frame
    # and runs no model, and a full re-track must agree on it and its neighbours.
    g = 3 * CN // 4 if abs(3 * CN // 4 - c) > 10 else CN // 4
    y, x = cross_obj(g)
    a.tracks.record_points(video, 1, g, [[(x + CS / 2) / CW, (y + CS / 2) / CH]], [0], True,
                           mask=rle.encode(np.zeros((CH, CW), bool)))
    blank, t_g = track()
    prov_g = a.tracks.provenance(video, 1)
    full_g, t_fg = track(full=True)
    near = [f for f in range(g - 5, g + 6) if f != g]
    w = [mask_iou(blank[f], full_g[f]) for f in near]
    print(f"cleared seed on frame {g}: blanked in {t_g:.2f} s (passes {prov_g['bounded']}) against "
          f"{t_fg:.1f} s for a full re-track; frame {g} area {int(full[g].sum())} -> bounded {int(blank[g].sum())}, "
          f"full {int(full_g[g].sum())}; neighbours {near[0]}-{near[-1]} IoU vs full min {min(w):.4f}")
    last = prov_g["passes"][-1]
    assert last["kind"] == "bounded" and last["frames"] == [g, g] and last["attempts"] == 0
    assert prov_g["bounded"] == [[g, g]] and full[g].any()
    assert not blank[g].any() and not full_g[g].any()
    assert all((blank[f] == full[f]).all() for f in range(CN) if f != g)  # the cache, kept
    assert min(w) > MIN_IOU_VS_FULL
