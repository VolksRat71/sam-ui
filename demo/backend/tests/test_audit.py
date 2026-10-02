# sam-ui (Apache-2.0). New file, not from SAM 2.
"""The audit queue (draft 7), its pure parts: per-frame mask statistics read
from RLE, the review signals built from them, and the ranking that turns
signals into a short queue of places worth a look."""
import numpy as np
import pytest

from tracks import audit, rle
from tracks.audit import WEIGHTS, frame_stats, locations, rank, signals

H, W = 48, 64


def sq(x, y, s=8, shape=(H, W)):
    m = np.zeros(shape, bool)
    m[y:y + s, x:x + s] = True
    return m


def enc(m):
    return rle.encode(m)


def empty():
    return enc(np.zeros((H, W), bool))


def stats_of(masks):
    return {f: frame_stats(enc(m) if isinstance(m, np.ndarray) else m) for f, m in masks.items()}


def moving(n=30, x0=2, y=10, step=1, s=8):
    return {f: sq(x0 + step * f, y, s) for f in range(n)}


def kinds(reasons, frame):
    return sorted(r["kind"] for r in reasons.get(frame, []))


# -- statistics from RLE --------------------------------------------------------

def test_stats_of_a_square():
    st = frame_stats(enc(sq(10, 4, 8)))
    assert st["area"] == 64 and st["components"] == 1
    assert st["bbox"] == [10, 4, 17, 11]  # x0, y0, x1, y1, inclusive
    assert st["centroid"] == pytest.approx([13.5, 7.5])


def test_stats_of_an_empty_mask():
    assert frame_stats(empty()) == {"area": 0, "bbox": None, "centroid": None, "components": 0}


def test_two_squares_are_two_components_and_a_speck_does_not_count():
    two = sq(2, 2) | sq(30, 20)
    assert frame_stats(enc(two))["components"] == 2
    speck = sq(2, 2, 12)
    speck[40, 60] = True  # one pixel: well under COMPONENT_MIN_FRACTION of the mask
    assert frame_stats(enc(speck))["components"] == 1


def test_diagonal_neighbours_are_one_component():
    m = np.zeros((H, W), bool)
    m[5:10, 5:10] = True
    m[10:15, 10:15] = True  # touches the first only at a corner
    assert frame_stats(enc(m))["components"] == 1


def test_a_run_that_wraps_a_column_is_split_at_the_column_edge():
    # a full-height column next to a mask at the top of the next one: COCO's
    # column-major run crosses the edge, and they are still one shape
    m = np.zeros((H, W), bool)
    m[H - 4:, 3] = True
    m[:4, 4] = True
    st = frame_stats(enc(m))
    assert st["area"] == 8 and st["components"] == 2  # bottom and top: not neighbours
    assert st["bbox"] == [3, 0, 4, H - 1]


def _label_count(m, min_px):
    """A plain 8-connected flood fill, for the property test."""
    seen = np.zeros_like(m, bool)
    sizes = []
    for y, x in zip(*np.nonzero(m)):
        if seen[y, x]:
            continue
        stack, n = [(y, x)], 0
        seen[y, x] = True
        while stack:
            cy, cx = stack.pop()
            n += 1
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < m.shape[0] and 0 <= nx < m.shape[1] and m[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
        sizes.append(n)
    return sum(1 for s in sizes if s >= min_px)


@pytest.mark.parametrize("seed", range(6))
def test_stats_match_the_decoded_mask(seed):
    r = np.random.default_rng(seed)
    m = r.random((20, 26)) > 0.7
    st = frame_stats(enc(m))
    ys, xs = np.nonzero(m)
    assert st["area"] == m.sum() == rle.area(enc(m))
    assert st["bbox"] == [xs.min(), ys.min(), xs.max(), ys.max()]
    assert st["centroid"] == pytest.approx([xs.mean(), ys.mean()])
    min_px = max(audit.COMPONENT_MIN_PX, audit.COMPONENT_MIN_FRACTION * m.sum())
    assert st["components"] == _label_count(m, min_px)


# -- signals --------------------------------------------------------------------

def test_a_steady_move_raises_nothing():
    assert signals(stats_of(moving()), 30) == {}


def test_a_jump_of_the_centroid_is_flagged_where_it_lands():
    masks = moving()
    for f in range(12, 30):
        masks[f] = sq(2 + f + 20, 10)  # 20 px to the right from frame 12 on
    got = signals(stats_of(masks), 30)
    assert kinds(got, 12) == ["jump"]
    assert set(got) == {12}  # a steady move after it raises nothing more


def test_a_large_change_of_area_is_flagged():
    masks = moving(s=8)
    for f in range(15, 30):
        masks[f] = sq(2 + f, 10, 14)  # 64 px -> 196 px, the corner stays put
    got = signals(stats_of(masks), 30)
    assert "area" in kinds(got, 15)
    assert 0.5 <= next(r for r in got[15] if r["kind"] == "area")["strength"] <= 1


def test_a_split_into_two_pieces_is_flagged_both_ways():
    masks = moving()
    for f in range(10, 16):
        masks[f] = sq(2 + f, 2, 6) | sq(2 + f, 30, 6)
    got = signals(stats_of(masks), 30)
    assert "components" in kinds(got, 10) and "components" in kinds(got, 16)


def test_vanishing_and_reappearing_are_a_stop_and_a_reappearance():
    masks = moving()
    for f in range(10, 15):
        masks[f] = np.zeros((H, W), bool)
    got = signals(stats_of(masks), 30)
    assert kinds(got, 9) == ["stop"] and kinds(got, 15) == ["reappear"]
    assert set(got) == {9, 15}  # nothing on the empty frames, nothing compared across the gap


def test_a_track_that_starts_late_and_ends_early():
    masks = {f: (sq(2 + f, 10) if 5 <= f <= 20 else np.zeros((H, W), bool)) for f in range(30)}
    got = signals(stats_of(masks), 30)
    assert kinds(got, 5) == ["start"] and kinds(got, 20) == ["stop"]
    full = signals(stats_of(moving()), 30)
    assert 0 not in full and 29 not in full  # the clip's own ends are no start or stop


def test_absent_frames_raise_nothing_and_nothing_is_compared_across_them():
    masks = moving()
    for f in range(10, 15):
        masks[f] = sq(40, 30)  # a stale track from before the range: anything at all
    got = signals(stats_of(masks), 30, absent=[{"start": 10, "end": 14, "state": "absent"}])
    assert not any(10 <= f <= 14 for f in got)
    # stopping into the range is what the user marked, no disappearance; coming back still counts
    assert kinds(got, 9) == [] and kinds(got, 15) == ["reappear"]


def test_engine_disagreement_is_a_signal_and_stronger_the_lower_the_iou():
    got = signals(stats_of(moving()), 30, disagreement={4: 0.79, 8: 0.1, 9: 0.95}, threshold=0.8)
    assert kinds(got, 4) == ["disagree"] and kinds(got, 8) == ["disagree"] and 9 not in got
    assert got[8][0]["strength"] > got[4][0]["strength"]


def test_a_bounded_retrack_is_flagged_at_its_seams():
    got = signals(stats_of(moving()), 30, bounded=[[6, 18]])
    assert kinds(got, 6) == ["retrack"] and kinds(got, 18) == ["retrack"]
    assert kinds(got, 12) == ["retrack"]  # inside it: weaker
    assert got[12][0]["strength"] < got[6][0]["strength"]


def test_a_candidate_range_start_is_a_reason():
    got = signals(stats_of(moving()), 30, candidates=[{"start": 7, "end": 12, "state": "candidate",
                                                        "source": "text:dog@sam3"}])
    assert kinds(got, 7) == ["candidate"]
    assert "text:dog@sam3" in got[7][0]["detail"]


def test_flags_join_and_seed_frames_raise_nothing_else():
    masks = moving()
    for f in range(12, 30):
        masks[f] = sq(2 + f + 20, 10)
    got = signals(stats_of(masks), 30, flags=[3, 12], seeds=[12])
    assert kinds(got, 3) == ["flag"]
    assert kinds(got, 12) == ["flag"]  # the user drew that mask: only their flag stays


def test_every_reason_says_why_in_words():
    masks = moving()
    masks[12] = np.zeros((H, W), bool)
    got = signals(stats_of(masks), 30, disagreement={5: 0.3}, flags=[20])
    for rs in got.values():
        for r in rs:
            assert r["kind"] in WEIGHTS and isinstance(r["detail"], str) and r["detail"]
            assert 0 < r["strength"] <= 1


# -- ranking --------------------------------------------------------------------

def R(kind, frame, strength=1.0):
    return {"kind": kind, "frame": frame, "strength": strength, "detail": kind}


def test_adjacent_frames_become_one_location():
    reasons = {10: [R("area", 10)], 11: [R("jump", 11), R("area", 11, 0.6)], 12: [R("components", 12)]}
    got = locations(reasons, 40)
    assert len(got) == 1
    loc = got[0]
    assert loc["frame"] == 11 and (loc["start"], loc["end"]) == (10, 12)
    # each kind counted once, at its strongest
    assert sorted(r["kind"] for r in loc["reasons"]) == ["area", "components", "jump"]
    assert loc["score"] == pytest.approx(WEIGHTS["area"] + WEIGHTS["jump"] + WEIGHTS["components"])


def test_far_apart_frames_are_separate_locations_ranked_by_score():
    reasons = {5: [R("area", 5)], 30: [R("disagree", 30), R("jump", 30)]}
    got = locations(reasons, 40)
    assert [loc["frame"] for loc in got] == [30, 5]
    assert got[0]["score"] > got[1]["score"]


def test_a_location_never_spans_an_absent_range():
    reasons = {9: [R("stop", 9)], 12: [R("reappear", 12)]}
    absent = [{"start": 10, "end": 11, "state": "absent"}]
    assert sorted(loc["frame"] for loc in locations(reasons, 40, absent=absent)) == [9, 12]
    assert len(locations(reasons, 40)) == 1


def test_the_queue_is_capped_and_weak_stretches_are_dropped():
    reasons = {f: [R("jump", f)] for f in range(0, 2000, 50)}
    assert len(locations(reasons, 2000)) == audit.QUEUE_CAP
    weak = {f: [R("retrack", f, 0.25)] for f in range(10, 20)}
    assert locations(weak, 40) == []


def test_rank_merges_objects_by_score():
    q = rank({1: [{"frame": 3, "start": 3, "end": 3, "score": 1.0, "reasons": [R("area", 3)]}],
              2: [{"frame": 8, "start": 8, "end": 8, "score": 4.0, "reasons": [R("flag", 8)]}]})
    assert [(e["object_id"], e["frame"]) for e in q] == [(2, 8), (1, 3)]


# -- the service: queues of real stored tracks, and what a person marks reviewed ------

import json  # noqa: E402

from test_api import Harness  # noqa: E402
from test_bounded import INFLUENCE, N, _Named, correct  # noqa: E402
from tracks.engine import FakeEngine  # noqa: E402
from tracks.engine import blanked, strip_cleared  # noqa: E402
from tracks.ranges import ABSENT, CANDIDATE  # noqa: E402
from tracks.seeds import cleared  # noqa: E402
from tracks.service import EngineSpec  # noqa: E402
from tracks.store import STALE, TRACKED  # noqa: E402

# the fake engine's square moves a pixel a frame and wraps back to the left
# edge every 28 frames: a jump the queue must find, at 28 and 56
WRAPS = (28, 56)


@pytest.fixture
def hs(tmp_path):
    return Harness(tmp_path, engine=FakeEngine(n_frames=N, influence=INFLUENCE))


def tracked(hs, obj=1, frame=0):
    hs.click(obj, frame=frame)
    hs.track()


def queue(hs, **kw):
    return hs.service.review_queue(hs.video, **kw)


def frames_of(q, obj=1):
    return sorted(loc["frame"] for loc in q["objects"][str(obj)]["locations"])


def reviewed_frames(q, obj=1):
    return sorted(loc["frame"] for loc in q["objects"][str(obj)]["locations"] if loc["reviewed"])


def test_a_tracked_object_gets_a_short_queue_with_reasons(hs):
    tracked(hs)
    q = queue(hs)
    assert frames_of(q) == list(WRAPS)
    o = q["objects"]["1"]
    assert o["state"] == TRACKED and o["n_frames"] == N and o["unreviewed"] == 2
    for loc in o["locations"]:
        assert loc["score"] > 0 and loc["reasons"] and loc["reviewed"] is False
        assert {r["kind"] for r in loc["reasons"]} == {"jump"}
    assert [(e["object_id"], e["frame"]) for e in q["queue"]] == [(1, 28), (1, 56)]
    assert q["weights"] == WEIGHTS and q["engine"] == "fake"


def test_untracked_objects_are_skipped_and_stale_ones_say_so(hs):
    tracked(hs)
    hs.click(2)  # never tracked
    q = queue(hs)
    assert q["skipped"] == {"2": "untracked"}
    hs.click(1, frame=5)
    assert queue(hs)["objects"]["1"]["state"] == STALE


def test_flags_and_absent_ranges_shape_the_queue(hs):
    tracked(hs)
    hs.service.set_range(hs.video, 1, 50, 59, ABSENT)
    hs.track()
    q = queue(hs, flags={1: [12]})
    # the flag and the wrap; 56 is absent now, and stopping into the range at 49 is no disappearance
    assert frames_of(q) == [12, 28]
    assert {r["kind"] for r in q["objects"]["1"]["locations"][0]["reasons"]} == {"flag"}


def test_engine_disagreement_joins_the_queue(hs):
    class _Off(_Named):
        """SAM 3, off by a lot on frames 40-41."""

        def _mask(self, obj_id, frame, seeds):
            m = super()._mask(obj_id, frame, seeds)
            return np.roll(m, 6, axis=1) if frame in (40, 41) else m

    hs.service._specs["sam3"] = EngineSpec("sam3", "fake-1", lambda: _Off("sam3", n_frames=N))
    tracked(hs)
    hs.client.post("/track_objects", json={"session_id": "s", "engine": "sam3"}).data
    q = queue(hs)
    loc = next(loc for loc in q["objects"]["1"]["locations"] if loc["start"] <= 40 <= loc["end"])
    assert "disagree" in {r["kind"] for r in loc["reasons"]}
    assert "fake and sam3 disagree" in next(r for r in loc["reasons"] if r["kind"] == "disagree")["detail"]


def test_reviewed_marks_persist_outside_the_seeds_hash(hs):
    tracked(hs)
    before = hs.service.seeds.hash(hs.video, 1)
    hs.service.set_reviewed(hs.video, 1, 28)
    path = hs.root / hs.video / "1" / "review.json"
    stored = json.loads(path.read_text())
    assert [m["frame"] for m in stored["marks"]] == [28] and stored["marks"][0]["engine"] == "fake"
    assert hs.service.seeds.hash(hs.video, 1) == before and hs.state(1) == TRACKED
    assert "review.json" not in hs.service.seeds.RECORD_FILES
    hs.new_service()  # a restart
    q = queue(hs)
    assert reviewed_frames(q) == [28] and q["objects"]["1"]["unreviewed"] == 1
    hs.service.set_reviewed(hs.video, 1, 28, reviewed=False)
    assert reviewed_frames(queue(hs)) == []


def test_a_mark_reviews_the_locations_its_span_overlaps(hs):
    tracked(hs)
    hs.service.set_reviewed(hs.video, 1, 26)  # a frame near the location, with no span: not it
    assert reviewed_frames(queue(hs)) == []
    # the stretch the location covered when it was marked: a re-ranked peak still finds it
    hs.service.set_reviewed(hs.video, 1, 27, span=(27, 28))
    assert reviewed_frames(queue(hs)) == [28]


def test_a_bounded_retrack_invalidates_only_the_marks_it_remade(hs):
    tracked(hs)
    hs.service.set_reviewed(hs.video, 1, 28)
    hs.service.set_reviewed(hs.video, 1, 56)
    correct(hs, 30)  # re-tracks frames 10-42 only (test_bounded)
    hs.track()
    q = queue(hs)
    assert 56 in reviewed_frames(q) and not any(10 <= f <= 42 for f in reviewed_frames(q))
    kinds_near = {r["kind"] for loc in q["objects"]["1"]["locations"] for r in loc["reasons"]}
    assert "retrack" in kinds_near


def test_a_full_retrack_invalidates_every_mark_and_undo_brings_them_back(hs):
    tracked(hs)
    hs.service.set_reviewed(hs.video, 1, 56)
    correct(hs, 30)
    hs.track()
    assert 56 in reviewed_frames(queue(hs))
    hs.service.set_reviewed(hs.video, 1, 28)
    hs.track([1])  # re-tracked whole: every frame made anew
    assert reviewed_frames(queue(hs)) == []
    hs.service.undo(hs.video, 1)  # back to one click: its kept track, as it was reviewed
    assert reviewed_frames(queue(hs)) == [56]


def test_a_track_from_before_provenance_still_gets_a_queue_and_marks(hs):
    tracked(hs)
    d = hs.service.tracks.track_dir(hs.video, 1, "fake")
    meta = json.loads((d / "track.json").read_text())
    for k in ("passes", "provenance", "seed_keys", "windows"):
        meta.pop(k, None)
    (d / "track.json").write_text(json.dumps(meta))
    assert frames_of(queue(hs)) == list(WRAPS)
    hs.service.set_reviewed(hs.video, 1, 28)
    assert reviewed_frames(queue(hs)) == [28]
    hs.track([1])
    assert reviewed_frames(queue(hs)) == []


def test_a_damaged_or_older_review_file_reads_as_no_marks(hs):
    tracked(hs)
    path = hs.root / hs.video / "1" / "review.json"
    for raw in ("not json", json.dumps([1, 2]), json.dumps({"marks": [{"frame": "x"}, 7, {"frame": 28}]})):
        path.write_text(raw)
        assert reviewed_frames(queue(hs)) == []
    hs.service.set_reviewed(hs.video, 1, 28)  # and it is written whole again
    assert reviewed_frames(queue(hs)) == [28]


def test_marking_a_frame_with_no_track_is_refused(hs):
    hs.click(1)
    with pytest.raises(KeyError):
        hs.service.set_reviewed(hs.video, 1, 3)


def test_review_routes(hs):
    tracked(hs)
    r = hs.client.post("/review_queue", json={"session_id": "s", "flags": {"1": [12]}})
    assert r.status_code == 200 and frames_of(r.json) == [12, 28, 56]
    r = hs.client.post("/set_reviewed", json={"session_id": "s", "object_id": 1, "frame": 12})
    assert r.status_code == 200 and r.json["reviewed"] is True
    got = hs.client.post("/review_queue", json={"session_id": "s", "flags": {"1": [12]}}).json
    assert reviewed_frames(got) == [12] and got["objects"]["1"]["unreviewed"] == 2
    assert hs.client.post("/set_reviewed", json={"session_id": "s", "object_id": 9, "frame": 1}).status_code == 404


# -- parity with the studio's twin (studio/src/state/audit.ts) ---------------------------

from pathlib import Path  # noqa: E402

PARITY = Path(__file__).resolve().parents[3] / "studio" / "src" / "state" / "audit.parity.json"


def parity_case():
    """A 40-frame track that does a bit of everything, and what the queue makes of it."""
    masks = {}
    for f in range(40):
        if 14 <= f <= 17:
            m = np.zeros((H, W), bool)  # vanishes
        elif f == 13:
            m = sq(2 + f, 10, 10)  # grows across the cleared frame 12
        elif 8 <= f <= 10:
            m = sq(2 + f, 2, 6) | sq(2 + f, 30, 6)  # splits
        elif f >= 38:
            m = np.zeros((H, W), bool)
            m[10:21, f:f + 9] = True  # 144 px to 99: a change of exactly 0.3125, a rounding tie
        elif f >= 25:
            m = sq(f, 10, 12)  # jumps back and grows
        else:
            m = sq(2 + f, 10)
        masks[f] = enc(m)
    inputs = {"absent": [{"start": 33, "end": 35, "state": "absent"}],
              "candidates": [{"start": 20, "end": 24, "state": "candidate", "source": "text:dog@sam3", "score": 0.7}],
              "disagreement": {"5": 0.4, "6": 0.9, "36": 0.125}, "bounded": [[27, 31]], "flags": [2], "seeds": [0, 12, 14, 20],
              "cleared": [12, 14],  # 12 holds a mask from before the skip; 14 starts the vanishing
              "confirmed": [0, 20]}  # a positive on the candidate's first frame: it resumes at 21
    return masks, inputs


def parity_output(masks, inputs):
    stats = {f: frame_stats(r) for f, r in masks.items()}
    reasons = signals(stats, 40, absent=inputs["absent"], candidates=inputs["candidates"],
                      disagreement={int(f): v for f, v in inputs["disagreement"].items()}, bounded=inputs["bounded"],
                      flags=inputs["flags"], seeds=inputs["seeds"], cleared=inputs["cleared"],
                      confirmed=inputs["confirmed"])
    return {"stats": {str(f): s for f, s in stats.items()},
            "locations": locations(reasons, 40, inputs["absent"])}


def test_the_studio_parity_fixture_is_current():
    """studio's audit.test.ts checks its own code against this file: if this
    fails, the backend's queue changed; regenerate it (SAM_UI_WRITE_PARITY=1)
    and make the studio agree."""
    import os
    masks, inputs = parity_case()
    want = {"masks": {str(f): r for f, r in masks.items()}, "inputs": inputs, "expected": parity_output(masks, inputs)}
    if os.environ.get("SAM_UI_WRITE_PARITY"):
        PARITY.write_text(json.dumps(want, indent=1) + "\n")
    assert json.loads(PARITY.read_text()) == json.loads(json.dumps(want))


# -- review fixes -------------------------------------------------------------------------

def test_a_flag_inside_an_absent_range_is_dropped_not_a_crash():
    absent = [{"start": 10, "end": 14, "state": "absent"}]
    got = signals(stats_of(moving()), 30, absent=absent, flags=[12, 20])
    assert 12 not in got and kinds(got, 20) == ["flag"]
    # and a stray reason inside one never crashes the ranking
    assert locations({12: [R("flag", 12)]}, 30, absent) == []


def test_a_tie_rounds_half_up_as_the_studio_does():
    assert audit.round3(0.5625) == 0.563 and audit.fmt2(0.125) == "0.13" and audit.pct(0.625) == 63


def test_a_mark_stops_holding_when_any_frame_of_its_span_is_remade(hs):
    tracked(hs)
    hs.service.set_reviewed(hs.video, 1, 5, span=(5, 12))  # reviewed a stretch, peak at 5
    meta = hs.service.tracks.meta(hs.video, 1, "fake")
    masks = dict(hs.service.tracks.masks(hs.video, 1, "fake"))
    marks = hs.service._valid_marks(hs.video, 1, "fake", meta, masks)
    assert len(marks) == 1
    masks[11] = masks[40]  # one frame of the span changed, the peak did not
    assert hs.service._valid_marks(hs.video, 1, "fake", meta, masks) == []


def test_a_mark_reviews_only_locations_peaking_inside_its_span(hs):
    tracked(hs)
    q = queue(hs, flags={1: [30]})  # the flag and the wrap at 28 make one stop: peak 30, frames 28-30
    assert [(loc["frame"], loc["start"], loc["end"]) for loc in q["objects"]["1"]["locations"]][0] == (30, 28, 30)
    hs.service.set_reviewed(hs.video, 1, 24, span=(20, 28))  # overlaps it, but its peak was never looked at
    assert reviewed_frames(queue(hs, flags={1: [30]})) == []
    hs.service.set_reviewed(hs.video, 1, 30, span=(28, 30))
    assert reviewed_frames(queue(hs, flags={1: [30]})) == [30]


def test_marking_a_frame_past_the_track_is_refused_but_any_frame_of_it_can_be_marked(hs):
    tracked(hs)
    with pytest.raises(KeyError):
        hs.service.set_reviewed(hs.video, 1, N + 5)
    assert hs.service.set_reviewed(hs.video, 1, N - 1)["reviewed"] is True


# -- with the correction semantics: a cleared frame is no disappearance, a candidate no absence --

def test_a_cleared_frame_sam2_blanked_is_no_stop_and_no_reappearance():
    masks = moving()
    masks[12] = np.zeros((H, W), bool)  # SAM 2 blanks a cleared seed's frame, by design
    assert kinds(signals(stats_of(masks), 30), 11) == ["stop"]  # an empty frame with no seed is one
    got = signals(stats_of(masks), 30, seeds=[0, 12], cleared=[12])
    assert got == {}  # no stop at 11, no reappearance at 13, nothing compared wrongly across 12


def test_a_cleared_frame_sam3_emptying_forward_is_no_stop_but_a_comeback_still_counts():
    masks = moving()
    for f in range(12, 20):
        masks[f] = np.zeros((H, W), bool)  # SAM 3 keeps the cleared look-alike out for a while
    got = signals(stats_of(masks), 30, seeds=[0, 12], cleared=[12])
    assert kinds(got, 11) == [] and set(got) == {20}
    assert kinds(got, 20) == ["reappear"]  # coming back with no click is worth a look (it may be another thing)
    # one empty frame on SAM 3 (the object really there): the same as SAM 2's blank
    masks = moving()
    masks[12] = np.zeros((H, W), bool)
    assert signals(stats_of(masks), 30, seeds=[12], cleared=[12]) == {}


def test_the_frames_either_side_of_a_cleared_frame_are_compared_with_each_other():
    masks = moving()
    masks[12] = sq(40, 30)  # a stray mask on the cleared frame (a track from before the skip): not evidence
    assert signals(stats_of(masks), 30, seeds=[12], cleared=[12]) == {}  # a steady move across it
    masks[13] = sq(2 + 13, 10, 12)  # and a change across it is still found, on the far side
    got = signals(stats_of(masks), 30, seeds=[12], cleared=[12])
    assert "area" in kinds(got, 13)
    assert next(r for r in got[13] if r["kind"] == "area")["detail"] == \
        "the mask grows by 56% across 1 cleared frame"
    assert 12 not in got


def test_a_cleared_frame_inside_an_absent_range_stays_a_gap():
    masks = moving()
    masks[12] = np.zeros((H, W), bool)
    for f in range(13, 30):
        masks[f] = sq(2 + f + 20, 20)  # far away after it: across a gap, that is no jump
    got = signals(stats_of(masks), 30, absent=[{"start": 12, "end": 12, "state": "absent"}], seeds=[12], cleared=[12])
    assert set(got) == {13} and kinds(got, 13) == ["reappear"]


class _Sam2Like(FakeEngine):
    """SAM 2's way with a cleared seed: never conditioned on, its frame blanked."""
    name = "sam2"
    skips_cleared = True

    def track(self, video_path, objects, video_handle=None, windows=None):
        blank = strip_cleared(objects)[1]
        for frame, masks in super().track(video_path, objects, video_handle, windows):
            yield frame, blanked(frame, masks, blank)


class _Sam3Like(FakeEngine):
    """SAM 3's way on footage the object has left: a cleared seed empties its
    frame and the frames after it, up to the object's next seed."""
    name = "sam3"
    skips_cleared = False

    def _mask(self, obj_id, frame, seeds):
        last = max((f for f in seeds if f <= frame), default=None)
        if last is not None and cleared(seeds[last]):
            return np.zeros(self.shape, bool)
        return super()._mask(obj_id, frame, seeds)


@pytest.fixture(params=[_Sam2Like, _Sam3Like], ids=["sam2", "sam3"])
def engine_hs(tmp_path, request):
    return Harness(tmp_path, engine=request.param(n_frames=N))


def lone_negative(hs, frame, obj=1):
    """"Not on this frame": recorded as SAM 3 records it (on SAM 2 the click is refused, but the seed is shared)."""
    hs.click(obj, frame=frame, points=[[0.3, 0.3]], labels=(0,))


def test_a_cleared_seed_is_no_disappearance_in_the_queue(engine_hs):
    hs = engine_hs
    hs.click(1, frame=0)
    lone_negative(hs, 12)
    hs.click(1, frame=20)  # where the object is clicked back
    hs.track()
    masks = dict(hs.service.tracks.masks(hs.video, 1, hs.engine.name))
    assert rle.area(masks[12]) == 0 and rle.area(masks[11]) > 0  # the cleared frame is empty on both
    q = queue(hs)
    assert frames_of(q) == list(WRAPS)  # only the wraps: nothing at 11, 13 or the comeback at 20 (a seed)
    for loc in q["objects"]["1"]["locations"]:
        assert not {"stop", "reappear", "start"} & {r["kind"] for r in loc["reasons"]}


def test_an_absent_range_is_no_disappearance_in_the_queue(engine_hs):
    hs = engine_hs
    hs.click(1, frame=0)
    hs.service.set_range(hs.video, 1, 40, 45, ABSENT)
    hs.click(1, frame=46)
    hs.track()
    q = queue(hs)
    assert frames_of(q) == [28, 56]  # no stop at 39; frames 40-45 raise nothing
    reasons = [r for loc in q["objects"]["1"]["locations"] for r in loc["reasons"]]
    assert not any(39 <= r["frame"] <= 46 for r in reasons)


def test_a_candidate_is_a_review_item_never_an_absence_and_the_queue_never_resolves_it(hs):
    tracked(hs)
    hs.service.set_range(hs.video, 1, 10, 20, CANDIDATE, source="text:dog@sam3", score=0.6)
    q = queue(hs)
    assert frames_of(q) == [10, 28, 56]
    loc = q["objects"]["1"]["locations"][0]
    assert loc["frame"] == 10 and [r["kind"] for r in loc["reasons"]] == ["candidate"]
    assert hs.service.seeds.ranges(hs.video, 1) == []  # it is not absent: nothing is blanked or split
    masks = dict(hs.service.tracks.masks(hs.video, 1, "fake"))
    assert all(rle.area(masks[f]) > 0 for f in range(10, 21))
    hs.service.set_reviewed(hs.video, 1, 10, span=(loc["start"], loc["end"]), reasons=["candidate"])
    timeline = hs.service.object_info(hs.video, 1)["ranges"]
    assert [(r["start"], r["end"], r["state"]) for r in timeline] == [(10, 20, CANDIDATE)]  # still unconfirmed
    assert hs.service.object_info(hs.video, 1)["state"] == TRACKED


# -- the stop before a gap that runs into a range or a cleared frame (case b) -----------

def test_a_stop_followed_by_empty_frames_then_an_absent_range_is_still_a_stop():
    masks = moving()
    for f in range(7, 15):
        masks[f] = np.zeros((H, W), bool)  # the track stops after 6, 7-9 are empty, 10-14 marked absent
    got = signals(stats_of(masks), 30, absent=[{"start": 10, "end": 14, "state": "absent"}])
    assert kinds(got, 6) == ["stop"]  # the track lost it before the range the user marked


def test_a_stop_followed_by_empty_frames_then_a_cleared_frame_is_still_a_stop():
    masks = moving()
    for f in range(10, 13):
        masks[f] = np.zeros((H, W), bool)  # the track stops after 9, 10-11 are empty, 12 is cleared
    got = signals(stats_of(masks), 30, seeds=[0, 12], cleared=[12])
    assert kinds(got, 9) == ["stop"]


# -- a positive inside a candidate confirms that frame present (Nate, 2026-10-02) --------

from tracks.seeds import confirmed  # noqa: E402

CAND = {"start": 10, "end": 14, "state": "candidate", "source": "text:dog@sam3"}


def test_a_seed_confirms_present_with_a_positive_or_a_text_mask_never_when_cleared():
    ones, zeros = enc(np.ones((H, W), bool)), empty()
    assert confirmed({"points": [[0.5, 0.5]], "labels": [1]})
    assert confirmed({"points": [[0.5, 0.5], [0.2, 0.2]], "labels": [0, 1], "mask": zeros})
    assert confirmed({"points": [], "labels": [], "mask": ones})  # a text seed asserts the object
    assert not confirmed({"points": [[0.5, 0.5]], "labels": [0], "mask": zeros})  # cleared
    assert not confirmed({"points": [[0.5, 0.5]], "labels": [0]})  # cleared, no mask
    assert not confirmed({"points": [[0.5, 0.5]], "labels": [0], "mask": ones})  # anchor-trimmed: no positive
    assert not confirmed({"points": [], "labels": [], "mask": zeros})
    assert not confirmed({"points": [], "labels": []})


def test_a_positive_inside_a_candidate_takes_that_frame_out_and_the_next_frame_stays():
    got = signals(stats_of(moving()), 30, candidates=[CAND], seeds=[10], confirmed=[10])
    assert 10 not in got  # confirmed present: out of the queue
    assert kinds(got, 11) == ["candidate"]  # the frame next to it is still an unconfirmed candidate
    assert got[11][0]["detail"] == ("an unconfirmed candidate range from text:dog@sam3 resumes here "
                                    "(frames 11-15; 1 frame confirmed present before it)")


def test_a_positive_anywhere_inside_a_candidate_confirms_only_its_own_frame():
    got = signals(stats_of(moving()), 30, candidates=[CAND], seeds=[12], confirmed=[12])
    assert set(got) == {10} and kinds(got, 10) == ["candidate"]  # the rest is still for review
    assert "starts here (frames 11-15)" in got[10][0]["detail"]
    both = signals(stats_of(moving()), 30, candidates=[CAND], seeds=[10, 11], confirmed=[10, 11])
    assert set(both) == {12} and "2 frames confirmed present" in both[12][0]["detail"]
    every = list(range(10, 15))
    assert signals(stats_of(moving()), 30, candidates=[CAND], seeds=every, confirmed=every) == {}


def test_a_cleared_seed_inside_a_candidate_does_not_confirm_it():
    got = signals(stats_of(moving()), 30, candidates=[CAND], seeds=[0, 10], cleared=[10])
    assert kinds(got, 10) == ["candidate"]  # "not on this frame" is no confirmation: the candidate stays
    assert "starts here" in got[10][0]["detail"]


def test_a_text_seed_inside_a_candidate_confirms_that_frame():
    seeds = {10: {"points": [], "labels": [], "mask": enc(sq(12, 10))}}
    got = signals(stats_of(moving()), 30, candidates=[CAND], seeds=[],
                  confirmed=[f for f, v in seeds.items() if confirmed(v)])
    assert 10 not in got and kinds(got, 11) == ["candidate"]


def candidate_frames(q, obj=1):
    return [r["frame"] for loc in q["objects"][str(obj)]["locations"] for r in loc["reasons"]
            if r["kind"] == "candidate"]


def test_a_positive_inside_a_candidate_confirms_that_frame_in_the_queue(hs):
    tracked(hs)
    hs.service.set_range(hs.video, 1, 10, 20, CANDIDATE, source="text:dog@sam3", score=0.6)
    assert candidate_frames(queue(hs)) == [10]
    hs.click(1, frame=10)  # a positive on the candidate's first frame
    assert candidate_frames(queue(hs)) == [11]  # that frame is confirmed, the one next to it stays
    hs.click(1, frame=15)  # and one further in: confirmed too, the item stays where it was
    assert candidate_frames(queue(hs)) == [11]
    timeline = hs.service.object_info(hs.video, 1)["ranges"]
    assert [(r["start"], r["end"], r["state"]) for r in timeline] == [(10, 20, CANDIDATE)]  # derived, never painted


def test_a_cleared_seed_inside_a_candidate_does_not_confirm_it_in_the_queue(hs):
    tracked(hs)
    hs.service.set_range(hs.video, 1, 10, 20, CANDIDATE, source="text:dog@sam3", score=0.6)
    lone_negative(hs, 10)
    assert cleared(hs.service.seeds.seeds(hs.video, 1)[10])
    assert candidate_frames(queue(hs)) == [10]
