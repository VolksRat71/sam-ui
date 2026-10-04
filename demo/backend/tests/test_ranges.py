# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Absent ranges (issue #20): a span of frames where an object is not in the
shot. The range empties those frames, tracking never runs on them, and it
splits the object's track into segments that are each tracked only from their
own seeds."""
import json

import numpy as np
import pytest
from PIL import Image

from test_api import Harness, parse
from test_engine import _StubPredictor
from tracks import rle
from tracks.engine import FakeEngine, Sam2Engine, plan_units
from tracks.ranges import ABSENT, absent_at, normalize, paint, seeded_windows, windows
from tracks.seeds import SeedStore, seeds_hash
from tracks.store import STALE, TRACKED

V = "v" * 64


def seed(x=0.5, y=0.5, label=1):
    return {"points": [[x, y]], "labels": [label]}


# -- the range model -----------------------------------------------------------

def test_ranges_are_sorted_merged_and_validated():
    got = normalize([{"start": 8, "end": 9, "state": ABSENT}, {"start": 2, "end": 4, "state": ABSENT},
                     {"start": 5, "end": 6, "state": ABSENT}, {"start": 12, "end": 20, "state": ABSENT},
                     {"start": 15, "end": 16, "state": ABSENT}])
    assert got == [{"start": 2, "end": 6, "state": ABSENT}, {"start": 8, "end": 9, "state": ABSENT},
                   {"start": 12, "end": 20, "state": ABSENT}]  # 2-4 and 5-6 touch: one range
    for bad in ({"start": -1, "end": 3, "state": ABSENT}, {"start": 5, "end": 4, "state": ABSENT},
                {"start": 1, "end": 2, "state": "maybe"}, {"start": 1.5, "end": 2, "state": ABSENT}):
        with pytest.raises(ValueError):
            normalize([bad])


def test_paint_marks_and_unmarking_part_of_a_range_splits_it():
    r = paint([], 10, 20, ABSENT)
    assert r == [{"start": 10, "end": 20, "state": ABSENT}]
    assert paint(r, 14, 15, None) == [{"start": 10, "end": 13, "state": ABSENT},
                                      {"start": 16, "end": 20, "state": ABSENT}]
    assert paint(r, 0, 100, None) == []
    assert paint(r, 18, 30, ABSENT) == [{"start": 10, "end": 30, "state": ABSENT}]
    assert absent_at(r, 10) and absent_at(r, 20) and not absent_at(r, 9) and not absent_at(r, 21)


def test_windows_are_the_frames_between_absent_ranges():
    assert windows([]) == [(0, None)]
    r = [{"start": 0, "end": 2, "state": ABSENT}, {"start": 10, "end": 20, "state": ABSENT}]
    assert windows(r) == [(3, 9), (21, None)]


def test_seeded_windows_hold_only_their_own_seeds_and_drop_seeds_inside_a_range():
    seeds = {1: seed(), 5: seed(0.2), 12: seed(0.3), 30: seed(0.4), 40: {"points": [], "labels": []}}
    r = [{"start": 10, "end": 20, "state": ABSENT}]
    got = seeded_windows(seeds, r)
    assert [(w, sorted(s)) for w, s in got] == [((0, 9), [1, 5]), ((21, None), [30])]  # 12 is absent: ignored
    # a window with no seed is not tracked at all
    assert [w for w, _ in seeded_windows({1: seed()}, r)] == [(0, 9)]


# -- the seeds hash --------------------------------------------------------------

# The hash of these seeds before absent ranges existed (b41c29e). An object
# without ranges must keep it exactly, or every cached track goes stale on upgrade.
OLD_SEEDS = {3: {"points": [[0.1, 0.2]], "labels": [1], "mask": {"size": [2, 2], "counts": "04"}},
             7: {"points": [[0.5, 0.5]], "labels": [0]}}
OLD_HASH = "42a2023001e5c84c302cded36ed2a73ad741d0adeb17c12026b91aeb098a093d"


def test_an_object_without_ranges_keeps_its_old_seeds_hash():
    assert seeds_hash(OLD_SEEDS) == OLD_HASH
    assert seeds_hash(OLD_SEEDS, []) == OLD_HASH
    assert seeds_hash(OLD_SEEDS, None) == OLD_HASH


def test_ranges_join_the_seeds_hash(tmp_path):
    a = seeds_hash(OLD_SEEDS, [{"start": 10, "end": 20, "state": ABSENT}])
    b = seeds_hash(OLD_SEEDS, [{"start": 10, "end": 21, "state": ABSENT}])
    assert len({OLD_HASH, a, b}) == 3
    s = SeedStore(tmp_path)
    s.add_points(V, 1, 3, [[0.1, 0.2]], [1], True)
    before = s.hash(V, 1)
    s.paint_range(V, 1, 10, 20, ABSENT)
    assert s.hash(V, 1) != before
    s.paint_range(V, 1, 10, 20, None)
    assert s.hash(V, 1) == before  # unmarking it all is back to the old hash
    assert not (tmp_path / V / "1" / "ranges.json").exists()


def test_ranges_are_stored_apart_from_the_seeds_and_survive_a_new_store(tmp_path):
    s = SeedStore(tmp_path)
    s.add_points(V, 1, 3, [[0.1, 0.2]], [1], True)
    s.paint_range(V, 1, 10, 20, ABSENT)
    seeds_file = json.loads((tmp_path / V / "1" / "seeds.json").read_text())
    assert set(seeds_file) == {"3"}  # seeds.json keeps its layout
    assert SeedStore(tmp_path).ranges(V, 1) == [{"start": 10, "end": 20, "state": ABSENT}]
    # an object with a range and no clicks yet is still listed, so the range is not lost
    s.paint_range(V, 2, 0, 4, ABSENT)
    assert s.objects(V) == [1, 2]


# -- engines ----------------------------------------------------------------------

def test_plan_splits_an_object_into_one_unit_per_seeded_window():
    objects = {1: {2: seed(), 25: seed()}, 2: {2: seed()}}
    units = plan_units(objects, {1: [(0, 9), (21, None)]}, by_first_seed=True)
    assert [(u.lo, u.hi, sorted(u.objects)) for u in units] == [(0, 9, [1]), (0, None, [2]), (21, None, [1])]
    # each unit holds only the seeds inside its window
    assert sorted(units[0].objects[1]) == [2] and sorted(units[2].objects[1]) == [25]
    # without windows, nothing changes: one unit per first-seed frame (the MPS trap, b1b2e65)
    assert [(u.lo, u.hi, sorted(u.objects)) for u in plan_units({1: {2: seed()}, 2: {3: seed()}}, None, True)] == \
        [(0, None, [1]), (0, None, [2])]


class _CountingStub(_StubPredictor):
    """The stub predictor, recording every frame it runs the model on and
    which seeds each state holds."""

    def __init__(self, n):
        super().__init__(n)
        self.forwards, self.states = [], []

    def init_state(self, path, offload_video_to_cpu=False):
        st = super().init_state(path, offload_video_to_cpu)
        st["seeds"] = []
        self.states.append(st["seeds"])
        return st

    def add_new_points_or_box(self, inference_state, frame_idx, obj_id, **kw):
        inference_state["seeds"].append((obj_id, frame_idx))
        return super().add_new_points_or_box(inference_state, frame_idx, obj_id, **kw)

    def propagate_in_video(self, state, start_frame_idx, max_frame_num_to_track=None, reverse=False):
        for f, ids, m in super().propagate_in_video(state, start_frame_idx, max_frame_num_to_track, reverse):
            self.forwards.append(f)
            yield f, ids, m


def test_sam2_never_runs_inside_an_absent_range_and_each_side_has_only_its_seeds():
    p = _CountingStub(n=12)
    e = Sam2Engine(p, model="stub")
    seeds = {7: {1: seed(), 9: seed(0.2)}}
    frames = {}
    for f, m in e.track("v.mp4", seeds, windows={7: [(0, 3), (8, None)]}):
        assert f not in frames
        frames[f] = m
    assert sorted(frames) == [0, 1, 2, 3, 8, 9, 10, 11]
    assert not set(p.forwards) & {4, 5, 6, 7}  # no compute inside the gap
    assert p.states == [[(7, 1)], [(7, 9)]]  # a fresh state per side, seeded from that side only
    assert p.reset == 2


def test_sam2_passes_count_one_per_unit():
    e = Sam2Engine(_StubPredictor(), model="stub")
    assert e.passes({7: {1: seed(), 9: seed()}}, {7: [(0, 3), (8, None)]}) == 2
    assert e.passes({7: {1: seed(), 9: seed()}}) == 1


def test_fake_engine_honours_windows():
    e = FakeEngine(n_frames=10)
    got = list(e.track("v", {1: {1: seed(), 8: seed()}}, windows={1: [(0, 3), (7, None)]}))
    assert [f for f, _ in got] == [0, 1, 2, 3, 7, 8, 9]
    assert e.units == [(0, 3, {1: [1]}), (7, None, {1: [8]})]


# -- the service and its routes ------------------------------------------------------

@pytest.fixture
def h(tmp_path, monkeypatch):
    monkeypatch.setenv("SAM_UI_EXPORT_ROOT", str(tmp_path))
    return Harness(tmp_path, engine=FakeEngine(n_frames=10))


def mark(h, obj, start, end, state=ABSENT):
    return h.service.set_range(h.video, obj, start, end, state)


def test_marking_a_range_empties_it_and_tracking_skips_it(h):
    h.click(1, frame=1), h.click(1, frame=8)
    mark(h, 1, 4, 6)
    _, frames = h.track()
    by = {}
    for f, m in frames:
        assert f not in by  # each frame once
        by[f] = m[1]
    assert sorted(by) == list(range(10))
    assert all(not by[f].any() for f in (4, 5, 6))  # absent: empty
    assert all((by[f] == FakeEngine.mask(1, f)).all() for f in (0, 1, 2, 3, 7, 8, 9))
    assert h.engine.units == [(0, 3, {1: [1]}), (7, None, {1: [8]})]  # nothing ran on 4-6
    assert h.state(1) == TRACKED
    info = h.service.object_info(h.video, 1)
    assert info["ranges"] == [{"start": 4, "end": 6, "state": ABSENT}]


def test_a_segment_with_no_seed_stays_empty(h):
    h.click(1, frame=1)
    mark(h, 1, 4, 5)
    _, frames = h.track()
    by = dict((f, m[1]) for f, m in frames)
    assert sorted(by) == list(range(10))
    assert all(by[f].any() for f in range(4)) and not any(by[f].any() for f in range(4, 10))
    assert h.engine.units == [(0, 3, {1: [1]})]


def test_a_seed_past_the_gap_only_affects_its_own_side(h):
    h.click(1, frame=1), h.click(1, frame=8)
    mark(h, 1, 4, 6)
    h.track()
    h.click(1, frame=9, points=[[0.7, 0.7]])  # a new seed after the gap
    assert h.state(1) == STALE
    _, frames = h.track()
    # only the far side ran again; the near side's frames came from the cache
    assert h.engine.units[-1] == (7, None, {1: [8, 9]})
    assert [u for u in h.engine.units[2:]] == [(7, None, {1: [8, 9]})]
    assert sorted(f for f, _ in frames) == list(range(10)) and h.state(1) == TRACKED


def test_a_forced_retrack_of_a_tracked_object_recomputes_every_segment(h):
    h.click(1, frame=1), h.click(1, frame=8)
    mark(h, 1, 4, 6)
    h.track()
    h.track([1])
    assert h.engine.units[2:] == [(0, 3, {1: [1]}), (7, None, {1: [8]})]


def test_objects_without_ranges_track_as_before(h):
    h.click(1, frame=1), h.click(2, frame=3)
    _, frames = h.track()
    assert h.engine.calls == [[1, 2]] and h.engine.windows == [None]
    assert [f for f, _ in frames] == list(range(10)) and all(set(m) == {1, 2} for _, m in frames)


def test_marking_a_range_makes_the_track_stale_and_the_stream_blanks_it_until_the_retrack(h):
    h.click(1, frame=1)
    h.track()
    mark(h, 1, 2, 3)
    assert h.state(1) == STALE
    frames = dict(parse(h.client.post("/track_masks", json={"session_id": "s"}).data))
    assert frames[1][1].any() and not frames[2][1].any() and not frames[3][1].any() and frames[4][1].any()


def test_the_job_total_counts_every_part_the_stream_sends(h):
    h.click(1, frame=1), h.click(1, frame=8), h.click(2, frame=0)
    mark(h, 1, 4, 6)
    ids = h.service.select(h.video)
    total = h.service.job_frames(h.video, ids, 10)
    _, frames = h.track()
    assert total == len(frames)


def test_exports_leave_the_range_empty_even_from_a_stale_track(h, tmp_path):
    h.click(1, frame=1)
    h.track()
    mark(h, 1, 2, 3)  # stale now: the cached masks on 2-3 are still the old ones
    r = h.client.post("/export", json={"session_id": "s", "out_dir": str(tmp_path / "out"), "include_stale": True})
    assert r.status_code == 200, r.json
    mdir = tmp_path / "out/data/mattes_tracked/object_1"
    assert sorted(p.name for p in mdir.iterdir()) == [f"{i:05d}.png" for i in range(1, 11)]
    assert np.asarray(Image.open(mdir / "00002.png")).any()  # frame 1
    assert not np.asarray(Image.open(mdir / "00003.png")).any()  # frame 2, absent
    assert not np.asarray(Image.open(mdir / "00004.png")).any()  # frame 3, absent


def test_export_leaves_out_anchors_inside_a_range(h, tmp_path):
    h.click(1, frame=1), h.click(1, frame=3)
    mark(h, 1, 3, 4)
    h.track()
    r = h.client.post("/export", json={"session_id": "s", "out_dir": str(tmp_path / "out")})
    anchors = json.loads((tmp_path / "out/anchors.json").read_text())
    assert r.status_code == 200 and list(anchors["object_1"]["points"]) == ["2"]


def test_prime_mask_never_primes_from_an_absent_frame(h):
    h.click(1, frame=1)
    h.track()
    assert h.service.prime_mask(h.video, 1, 2) is not None
    mark(h, 1, 2, 3)
    assert h.service.prime_mask(h.video, 1, 2) is None
    assert h.service.is_absent(h.video, 1, 2) and not h.service.is_absent(h.video, 1, 4)


def test_set_range_marks_unmarks_and_refuses_a_bad_span(h):
    h.click(1, frame=1)
    assert mark(h, 1, 3, 5)["ranges"] == [{"start": 3, "end": 5, "state": ABSENT}]
    assert mark(h, 1, 4, 4, None)["ranges"] == [{"start": 3, "end": 3, "state": ABSENT},
                                                {"start": 5, "end": 5, "state": ABSENT}]
    with pytest.raises(ValueError):
        mark(h, 1, 4, 2)
    with pytest.raises(ValueError):
        mark(h, 1, 1, 2, "candidate")  # not a state yet


# -- the interactive session ---------------------------------------------------------

from test_inference_api import click, start, world  # noqa: E402,F401  (world is a fixture)

start_ = start  # _absent_world takes `start` as a frame


def test_a_click_inside_an_absent_range_is_refused_and_records_nothing(world):
    api_of, stub, path = world
    api = api_of()
    sid = start(api, path)
    click(api, sid, 1, 0, [[0.5, 0.5]], [1])
    api.set_object_range(sid, 1, 2, 4, ABSENT)
    calls = (len(stub.point_calls), len(stub.mask_calls))
    # a lone negative on SAM 2 meets the needs_positive guard first; on SAM 3,
    # which takes it, it reaches the absent check
    with pytest.raises(ValueError, match="needs_positive"):
        click(api, sid, 1, 3, [[0.5, 0.5]], [0])
    with pytest.raises(ValueError, match="marked absent"):
        click(api, sid, 1, 3, [[0.5, 0.5]], [0], engine="sam3")
    assert (len(stub.point_calls), len(stub.mask_calls)) == calls  # SAM never saw it, nothing primed
    video = api.session_states[sid]["video"]
    assert sorted(api.tracks.seeds.seeds(video, 1)) == [0]
    click(api, sid, 1, 5, [[0.5, 0.5]], [1])  # just past the range: fine
    click(api, sid, 2, 3, [[0.5, 0.5]], [1])  # another object on that frame: fine
    info = api.set_object_range(sid, 1, 3, 3, None)
    assert info["ranges"] == [{"start": 2, "end": 2, "state": ABSENT}, {"start": 4, "end": 4, "state": ABSENT}]
    click(api, sid, 1, 3, [[0.5, 0.5]], [1])  # unmarked: clickable again


def test_end_absence_at_trims_the_range_to_the_frame_before_and_never_writes_an_empty_one(h):
    h.click(1, frame=1)
    mark(h, 1, 10, 40), mark(h, 1, 50, 60)
    h.service.end_absence_at(h.video, 1, 25)
    assert h.service.seeds.ranges(h.video, 1) == [{"start": 10, "end": 24, "state": ABSENT},
                                                  {"start": 50, "end": 60, "state": ABSENT}]
    h.service.end_absence_at(h.video, 1, 50)  # at the range's first frame: the range goes, no [50, 49]
    assert h.service.seeds.ranges(h.video, 1) == [{"start": 10, "end": 24, "state": ABSENT}]
    h.service.end_absence_at(h.video, 1, 24)
    assert h.service.seeds.ranges(h.video, 1) == [{"start": 10, "end": 23, "state": ABSENT}]
    h.service.end_absence_at(h.video, 1, 5)  # not absent there: nothing changes
    assert h.service.seeds.ranges(h.video, 1) == [{"start": 10, "end": 23, "state": ABSENT}]


def test_ending_an_absence_makes_the_track_stale(h):
    h.click(1, frame=1), h.click(1, frame=8)
    mark(h, 1, 4, 6)
    h.track()
    assert h.state(1) == TRACKED
    h.service.end_absence_at(h.video, 1, 5)
    assert h.state(1) == STALE


def _absent_world(world, start=10, end=40):
    api_of, stub, path = world
    api = api_of()
    sid = start_(api, path)
    click(api, sid, 1, 0, [[0.5, 0.5]], [1])
    api.set_object_range(sid, 1, start, end, ABSENT)
    return api, stub, sid, api.session_states[sid]["video"]


def test_a_positive_inside_an_absent_range_ends_the_absence_at_that_frame(world):
    api, stub, sid, video = _absent_world(world)
    calls = len(stub.point_calls)
    out = click(api, sid, 1, 25, [[0.5, 0.5]], [1])  # the default engine, the main path
    assert out[1].any() and len(stub.point_calls) == calls + 1
    info = api.object_tracks(sid)[0]
    assert info["ranges"] == [{"start": 10, "end": 24, "state": ABSENT}]
    assert info["seeds"][25]["labels"] == [1] and info["seeds"][25]["mask"]
    # both changes are on disk, where a re-track (and an undo) reads them
    assert api.tracks.seeds.ranges(video, 1) == [{"start": 10, "end": 24, "state": ABSENT}]
    assert sorted(api.tracks.seeds.seeds(video, 1)) == [0, 25]


def test_a_positive_on_the_first_frame_of_a_range_removes_it(world):
    api, _, sid, video = _absent_world(world)
    click(api, sid, 1, 10, [[0.5, 0.5]], [1], engine="sam2")  # has a positive: past SAM 2's guard
    assert api.tracks.seeds.ranges(video, 1) == []
    assert sorted(api.tracks.seeds.seeds(video, 1)) == [0, 10]


def test_a_trim_with_a_positive_inside_a_range_ends_it_on_sam2(world):
    api, _, sid, video = _absent_world(world)
    click(api, sid, 1, 25, [[0.5, 0.5], [0.9, 0.9]], [1, 0], engine="sam2")
    assert api.tracks.seeds.ranges(video, 1) == [{"start": 10, "end": 24, "state": ABSENT}]
    assert api.tracks.seeds.seeds(video, 1)[25]["labels"] == [1, 0]


def test_a_negative_only_click_inside_a_range_is_still_refused_on_either_engine(world):
    api, stub, sid, video = _absent_world(world)
    calls = (len(stub.point_calls), len(stub.mask_calls))
    with pytest.raises(ValueError, match=r"^needs_positive: "):  # the default engine: SAM 2's guard first
        click(api, sid, 1, 25, [[0.5, 0.5]], [0])
    with pytest.raises(ValueError, match="is inside a range where object 1 is marked absent; "
                                         "unmark that part of the range to click here"):
        click(api, sid, 1, 25, [[0.5, 0.5]], [0], engine="sam3")
    assert (len(stub.point_calls), len(stub.mask_calls)) == calls
    assert api.tracks.seeds.ranges(video, 1) == [{"start": 10, "end": 40, "state": ABSENT}]
    assert sorted(api.tracks.seeds.seeds(video, 1)) == [0]


def test_a_positive_that_ends_an_absence_starts_from_the_click_not_the_old_track(world):
    # tracked before the range was marked, the cache still holds a mask on frame 3:
    # the one the user said was not the object. The click must not refine it.
    from test_inference_api import tracked
    api_of, stub, path = world
    a, sid, ctx = tracked(api_of, path)
    assert a.tracks.tracks.mask_at(ctx.video, 1, "fake", 3) is not None
    a.set_object_range(sid, 1, 2, 4, ABSENT)
    stub.mask_calls.clear()
    click(a, sid, 1, 3, [[0.9, 0.9]], [1])
    assert stub.mask_calls == []
    assert a.tracks.seeds.ranges(ctx.video, 1) == [{"start": 2, "end": 2, "state": ABSENT}]


def test_a_positive_that_fails_inside_a_range_leaves_the_range_whole(world):
    api, stub, sid, video = _absent_world(world)
    real = stub.add_new_points_or_box

    def boom(*args, **kw):
        raise RuntimeError("MPS backend out of memory")

    stub.add_new_points_or_box = boom
    with pytest.raises(RuntimeError):
        click(api, sid, 1, 25, [[0.5, 0.5]], [1])
    stub.add_new_points_or_box = real
    assert api.tracks.seeds.ranges(video, 1) == [{"start": 10, "end": 40, "state": ABSENT}]
    assert sorted(api.tracks.seeds.seeds(video, 1)) == [0]


# -- the real model ---------------------------------------------------------------------

from pathlib import Path  # noqa: E402
import os  # noqa: E402

CKPT = Path(__file__).resolve().parents[3] / "checkpoints" / "sam2.1_hiera_large.pt"
GAP = (12, 19)  # frames the object is out of the shot
N, GH, GW, S = 30, 240, 320, 50


def gap_video(path):
    """A red square that leaves the shot on frame 12 and comes back on frame
    20 somewhere else. While it is gone, a look-alike red square stands in
    another spot: what a tracker left running latches onto."""
    import av
    rng = np.random.default_rng(1)
    bg = rng.integers(90, 140, (GH, GW, 3), dtype=np.uint8)
    truth = {}
    out = av.open(str(path), "w")
    st = out.add_stream("libx264", rate=24, options={"crf": "12"})
    st.width, st.height, st.pix_fmt = GW, GH, "yuv420p"
    for i in range(N):
        img = bg.copy()
        m = np.zeros((GH, GW), bool)
        if i < GAP[0]:
            y, x = 30, 10 + 6 * i
        elif i > GAP[1]:
            y, x = 160, 250 - 6 * (i - GAP[1] - 1)
        else:
            y, x = None, None
            img[100:100 + S, 180:180 + S] = (220, 40, 40)  # the look-alike
        if y is not None:
            img[y:y + S, x:x + S] = (220, 40, 40)
            m[y:y + S, x:x + S] = True
        truth[i] = m
        for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
            out.mux(pkt)
    for pkt in st.encode():
        out.mux(pkt)
    out.close()
    return truth


@pytest.mark.slow
@pytest.mark.skipif(not CKPT.exists() or os.environ.get("SAM_UI_SLOW") != "1",
                    reason="set SAM_UI_SLOW=1 with the large checkpoint in checkpoints/")
def test_real_sam2_leaves_an_absent_range_empty_and_tracks_the_far_side_from_its_own_seed(tmp_path):
    import torch
    from sam2.build_sam import build_sam2_video_predictor

    from inference.predictor import InferenceAPI

    truth = gap_video(tmp_path / "gap.mp4")
    dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    pred = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_l.yaml", str(CKPT), device=dev)
    seen = []
    orig = pred._get_image_feature

    def recording(inference_state, frame_idx, batch_size):
        seen.append(int(frame_idx))
        return orig(inference_state, frame_idx, batch_size)

    pred._get_image_feature = recording
    a = InferenceAPI(predictor=pred, device=torch.device(dev), tracks_root=str(tmp_path / "tracks"))
    sid = start(a, str(tmp_path / "gap.mp4"))

    def center(f):
        ys, xs = np.nonzero(truth[f])
        return [[float(xs.mean()) / GW, float(ys.mean()) / GH]]

    def track():
        ctx = a.track_context(sid)
        del seen[:]
        with a.inference_lock, a.autocast_context():
            got = {}
            for f, m in ctx.service.track(ctx.video, ctx.path, [1], video_handle=ctx.video_handle, n_frames=N):
                assert f not in got
                got[f] = rle.decode(m[1])
        return got

    def iou(x, y):
        u = (x | y).sum()
        return 1.0 if u == 0 else float((x & y).sum() / u)

    with torch.inference_mode():
        click(a, sid, 1, 0, center(0), [1])  # near side
        click(a, sid, 1, 24, center(24), [1])  # far side
        free = track()  # no range: the tracker runs through the gap
        free_gap = [int(free[f].sum()) for f in range(GAP[0], GAP[1] + 1)]
        a.set_object_range(sid, 1, GAP[0], GAP[1], ABSENT)
        cut = track()
        ran = sorted(set(seen))
        # the far side alone, from the far seed alone, as its own object: what it must match
        click(a, sid, 2, 24, center(24), [1])
        a.set_object_range(sid, 2, 0, GAP[1], ABSENT)
        ctx = a.track_context(sid)
        with a.inference_lock, a.autocast_context():
            alone = {f: rle.decode(m[2]) for f, m in
                     ctx.service.track(ctx.video, ctx.path, [2], video_handle=ctx.video_handle, n_frames=N)}

    near = [iou(cut[f], truth[f]) for f in range(GAP[0])]
    far = [iou(cut[f], truth[f]) for f in range(GAP[1] + 1, N)]
    same = [iou(cut[f], alone[f]) for f in range(GAP[1] + 1, N)]
    print(f"\nno range: gap frames {GAP[0]}-{GAP[1]} hold {free_gap} px (the look-alike is {S * S})"
          f"\nabsent {GAP[0]}-{GAP[1]}: gap px {[int(cut[f].sum()) for f in range(GAP[0], GAP[1] + 1)]}, "
          f"near IoU min {min(near):.3f}, far IoU min {min(far):.3f}, far vs far-seed-only IoU min {min(same):.4f}"
          f"\nframes the model ran on with the range: {ran[0]}-{GAP[0] - 1} and {GAP[1] + 1}-{ran[-1]}"
          if ran else "")
    assert sorted(cut) == list(range(N))
    assert all(not cut[f].any() for f in range(GAP[0], GAP[1] + 1))  # the gap is empty
    assert not set(ran) & set(range(GAP[0], GAP[1] + 1))  # and the model never ran on it
    assert min(near) > 0.9 and min(far) > 0.9
    assert min(same) > 0.99  # the far side comes from the far seed alone
    assert a.tracks.object_info(a.session_states[sid]["video"], 1)["state"] == TRACKED


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("SAM_UI_SLOW") != "1", reason="set SAM_UI_SLOW=1 (and have the SAM 3 weights)")
def test_real_sam3_tracks_each_window_on_its_own(tmp_path, request):
    from tracks import sam3_engine

    why = sam3_engine.available()
    if why:
        pytest.skip(why)
    truth = gap_video(tmp_path / "gap.mp4")

    def center(f):
        ys, xs = np.nonzero(truth[f])
        return {"points": [[float(xs.mean()) / GW, float(ys.mean()) / GH]], "labels": [1]}

    e = sam3_engine.Sam3Engine()
    request.addfinalizer(e.unload)
    got = {}
    for f, m in e.track(str(tmp_path / "gap.mp4"), {1: {0: center(0), 24: center(24)}},
                        windows={1: [(0, GAP[0] - 1), (GAP[1] + 1, None)]}):
        assert f not in got
        got[f] = m[1]
    ious = {f: float((got[f] & truth[f]).sum() / (got[f] | truth[f]).sum()) for f in got}
    print(f"\nsam3 windows: frames {sorted(got)[0]}-{GAP[0] - 1} and {GAP[1] + 1}-{sorted(got)[-1]}, "
          f"min IoU {min(ious.values()):.3f}")
    assert sorted(got) == [f for f in range(N) if not GAP[0] <= f <= GAP[1]]  # nothing inside the gap
    assert min(ious.values()) > 0.9


# -- cleared seeds ('not on this frame', #23) inside windows --------------------------

_CLEARED = {"points": [[0.5, 0.5]], "labels": [0]}  # no positive, no mask: cleared


def test_a_cleared_seed_opens_no_window_but_joins_the_key_of_the_window_it_is_in():
    r = [{"start": 4, "end": 6, "state": ABSENT}]
    got = seeded_windows({1: seed(), 2: _CLEARED, 8: _CLEARED}, r)
    assert got == [((0, 3), {1: seed(), 2: _CLEARED})]  # (7, None) holds only a cleared seed
    assert seeded_windows({8: _CLEARED}, []) == []
    # a window opened by a positive keeps its cleared seed, so adding one re-tracks that window
    assert seeded_windows({1: seed()}, r)[0][1] != got[0][1]


@pytest.fixture
def h2(tmp_path, monkeypatch):
    """The service over the real Sam2Engine on a stub predictor (it strips cleared seeds)."""
    monkeypatch.setenv("SAM_UI_EXPORT_ROOT", str(tmp_path))
    e = Sam2Engine(_StubPredictor(n=10), model="stub")
    e.n_frames = 10  # the clip's length, which a live session's video handle gives
    return Harness(tmp_path, engine=e)


def test_a_window_whose_only_seed_is_cleared_stays_empty_and_the_track_covers_the_clip(h2):
    h2.click(1, frame=1)
    h2.click(1, frame=8, labels=(0,))  # cleared, past the gap
    h2.click(1, frame=2, labels=(0,))  # cleared, inside the seeded window
    mark(h2, 1, 4, 6)
    total = h2.service.job_frames(h2.video, [1], 10)
    _, frames = h2.track()
    assert total == len(frames)  # the progress total counts what the stream sends
    by = {}
    for f, m in frames:
        assert f not in by
        by[f] = m[1]
    assert sorted(by) == list(range(10))
    assert all(by[f].any() for f in (0, 1, 3))
    assert not any(by[f].any() for f in (2, 4, 5, 6, 7, 8, 9))  # blanked, absent, and the cleared-only side
    assert h2.state(1) == TRACKED
    assert h2.service.tracks.meta(h2.video, 1, "sam2")["n_frames"] == 10
