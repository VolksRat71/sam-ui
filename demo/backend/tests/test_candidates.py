# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Candidate and confirmed ranges: a frame of an object is unknown (no range),
a candidate (a model or tool thinks the object is there, nobody confirmed it),
confirmed present, or confirmed absent (#20). Only absent changes tracking;
candidates and present ranges are annotations, outside the seeds hash."""
import json

import numpy as np
import pytest
from PIL import Image

from test_api import Harness
from tracks.engine import FakeEngine
from tracks.ranges import ABSENT, CANDIDATE, PRESENT, normalize, paint, state_at, view
from tracks.seeds import SeedStore, seeds_hash
from tracks.store import STALE, TRACKED

V = "v" * 64
DOG = "text:dog@sam3"


def rg(start, end, state, **prov):
    return {"start": start, "end": end, "state": state, **prov}


def cand(start, end, source=DOG, score=None):
    return rg(start, end, CANDIDATE, source=source, **({} if score is None else {"score": score}))


# -- the model ---------------------------------------------------------------------------

def test_candidates_carry_provenance_and_only_identical_provenance_merges():
    got = normalize([cand(0, 4, score=0.9), cand(5, 8, score=0.9), cand(9, 12, score=0.5), cand(13, 14, "text:cat")])
    assert got == [cand(0, 8, score=0.9), cand(9, 12, score=0.5), cand(13, 14, "text:cat")]
    assert normalize([rg(0, 3, PRESENT), rg(4, 6, PRESENT)]) == [rg(0, 6, PRESENT)]


@pytest.mark.parametrize("bad", [
    rg(0, 3, CANDIDATE),  # a candidate says where it came from
    rg(0, 3, CANDIDATE, source=""),
    rg(0, 3, CANDIDATE, source="x" * 129),
    cand(0, 3, score=1.5), cand(0, 3, score=-0.1), cand(0, 3, score=float("nan")), cand(0, 3, score="high"),
    rg(0, 3, PRESENT, source=DOG),  # confirmed ranges are the user's: no source, no score
    rg(0, 3, ABSENT, score=0.4),
    rg(0, 3, "maybe"),
])
def test_bad_ranges_are_refused(bad):
    with pytest.raises(ValueError):
        normalize([bad])


def test_paint_replaces_only_the_states_it_is_told_to():
    layer = [rg(0, 9, PRESENT), cand(5, 15)]
    # a candidate painted over a candidate replaces it, and leaves the present range alone
    assert paint(layer, 8, 12, CANDIDATE, source="text:cat", over=(CANDIDATE,)) == [
        rg(0, 9, PRESENT), cand(5, 7), cand(8, 12, "text:cat"), cand(13, 15)]
    # with no `over`, paint clears every state in the span, as #20's did
    assert paint(layer, 3, 12, None) == [rg(0, 2, PRESENT), cand(13, 15)]


def test_confirmed_ranges_override_candidates_and_absent_overrides_present():
    absent = [rg(10, 14, ABSENT)]
    notes = [rg(12, 20, PRESENT), cand(0, 30, score=0.8)]
    got = view(absent, notes)
    assert got == [cand(0, 9, score=0.8), rg(10, 14, ABSENT), rg(15, 20, PRESENT), cand(21, 30, score=0.8)]
    assert [state_at(got, f) for f in (0, 10, 15, 21, 31)] == [CANDIDATE, ABSENT, PRESENT, CANDIDATE, None]


# -- the seeds hash -----------------------------------------------------------------------

OLD_SEEDS = {3: {"points": [[0.1, 0.2]], "labels": [1], "mask": {"size": [2, 2], "counts": "04"}},
             7: {"points": [[0.5, 0.5]], "labels": [0]}}
# The hash of OLD_SEEDS with two absent ranges as #20 (b41c29e..c7eec57) made it:
# an object with only absent ranges must keep it, or its tracks go stale on upgrade.
ABSENT_ONLY = [rg(10, 20, ABSENT), rg(30, 31, ABSENT)]
ABSENT_HASH = "8821a7c76340b81b76a0a36c824853a0e7f1cdaa60e59284dac0ad83e7fa8599"


def test_an_object_with_only_absent_ranges_keeps_its_hash():
    assert seeds_hash(OLD_SEEDS, ABSENT_ONLY) == ABSENT_HASH


def test_candidate_and_present_ranges_leave_the_hash_alone():
    assert seeds_hash(OLD_SEEDS, ABSENT_ONLY + [rg(0, 5, PRESENT), cand(40, 50, score=0.7)]) == ABSENT_HASH


def test_marking_candidates_and_present_in_the_store_never_changes_the_hash(tmp_path):
    s = SeedStore(tmp_path)
    s.add_points(V, 1, 3, [[0.1, 0.2]], [1], True)
    s.paint_range(V, 1, 10, 20, ABSENT)
    before = s.hash(V, 1)
    s.paint_range(V, 1, 30, 40, CANDIDATE, source=DOG, score=0.6)
    s.paint_range(V, 1, 0, 2, PRESENT)
    assert s.hash(V, 1) == before
    assert json.loads((tmp_path / V / "1" / "ranges.json").read_text()) == {"ranges": [rg(10, 20, ABSENT)]}
    assert s.timeline(V, 1) == [rg(0, 2, PRESENT), rg(10, 20, ABSENT), cand(30, 40, score=0.6)]
    # annotations live apart from the seed record, so undo snapshots never hold them
    assert set(s.record(V, 1)) == {"seeds.json", "ranges.json"}


# -- tracking ----------------------------------------------------------------------------------

@pytest.fixture
def h(tmp_path, monkeypatch):
    monkeypatch.setenv("SAM_UI_EXPORT_ROOT", str(tmp_path))
    return Harness(tmp_path, engine=FakeEngine(n_frames=10))


def masks_bytes(h, obj=1, engine="fake"):
    return (h.root / h.video / str(obj) / engine / "masks.jsonl").read_bytes()


def test_candidates_and_present_ranges_leave_a_track_tracked_with_no_history(h):
    h.click(1, frame=1), h.click(1, frame=8)
    h.service.set_range(h.video, 1, 4, 6, ABSENT)
    h.track()
    masks, units, history = masks_bytes(h), list(h.engine.units), h.service.versions_info(h.video, 1)
    info = h.service.set_range(h.video, 1, 0, 3, CANDIDATE, source=DOG, score=0.9)
    info = h.service.set_range(h.video, 1, 7, 9, PRESENT)
    assert info["state"] == TRACKED and h.state(1) == TRACKED
    assert info["ranges"] == [cand(0, 3, score=0.9), rg(4, 6, ABSENT), rg(7, 9, PRESENT)]
    assert h.service.versions_info(h.video, 1) == history  # nothing to undo: no seed change
    assert h.track() == ("", [])  # nothing to re-track
    h.track([1])  # forced: the very same windows and masks as without them
    assert h.engine.units[len(units):] == units and masks_bytes(h) == masks


def test_a_click_inside_a_candidate_or_present_range_is_a_click(h):
    h.service.set_range(h.video, 1, 0, 9, CANDIDATE, source=DOG)
    h.click(1, frame=2)
    h.service.set_range(h.video, 2, 0, 9, PRESENT)
    h.click(2, frame=2)
    assert not h.service.is_absent(h.video, 1, 2) and not h.service.is_absent(h.video, 2, 2)
    _, frames = h.track()
    assert all(m[1].any() and m[2].any() for _, m in frames)


# -- candidate actions ------------------------------------------------------------------------

def test_confirming_a_candidate_absent_is_a_seed_change_that_undo_takes_back(h):
    h.click(1, frame=1)
    h.track()
    masks = masks_bytes(h)
    h.service.write_candidates(h.video, 1, [cand(5, 8, score=0.4)])
    info = h.service.set_range(h.video, 1, 5, 8, ABSENT)  # confirm absent
    assert info["ranges"] == [rg(5, 8, ABSENT)] and info["state"] == STALE
    assert info["history"]["can_undo"]
    _, frames = h.track()
    assert not any(m[1].any() for f, m in frames if 5 <= f <= 8)
    info = h.service.undo(h.video, 1)
    # the absent range is gone and the candidate it confirmed shows again; the old track is back, no job
    assert info["ranges"] == [cand(5, 8, score=0.4)] and info["state"] == TRACKED
    assert masks_bytes(h) == masks
    assert h.service.redo(h.video, 1)["ranges"] == [rg(5, 8, ABSENT)]


def test_confirming_a_candidate_present_or_rejecting_it(h):
    h.click(1, frame=1)
    h.service.write_candidates(h.video, 1, [cand(2, 5, score=0.8), cand(7, 9, score=0.3)])
    info = h.service.set_range(h.video, 1, 2, 5, PRESENT)
    assert info["ranges"] == [rg(2, 5, PRESENT), cand(7, 9, score=0.3)]
    info = h.service.set_range(h.video, 1, 7, 9, None, clear=[CANDIDATE])  # reject
    assert info["ranges"] == [rg(2, 5, PRESENT)]


def test_present_and_absent_never_overlap(h):
    h.click(1, frame=1)
    h.service.set_range(h.video, 1, 3, 8, ABSENT)
    key = h.service.seeds.hash(h.video, 1)
    info = h.service.set_range(h.video, 1, 6, 9, PRESENT)  # "it is here": the absent frames go
    assert info["ranges"] == [rg(3, 5, ABSENT), rg(6, 9, PRESENT)]
    assert h.service.seeds.hash(h.video, 1) != key  # absent changed, so the hash did
    info = h.service.set_range(h.video, 1, 8, 9, ABSENT)
    assert info["ranges"] == [rg(3, 5, ABSENT), rg(6, 7, PRESENT), rg(8, 9, ABSENT)]
    # undoing the present mark puts the absent frames back over it
    h.service.undo(h.video, 1)
    assert h.service.undo(h.video, 1)["ranges"] == [rg(3, 8, ABSENT), rg(9, 9, PRESENT)]


def test_a_candidate_never_overrides_a_confirmed_range(h):
    h.service.set_range(h.video, 1, 0, 3, PRESENT)
    h.service.set_range(h.video, 1, 6, 7, ABSENT)
    info = h.service.write_candidates(h.video, 1, [cand(0, 9)])
    assert info["ranges"] == [rg(0, 3, PRESENT), cand(4, 5), rg(6, 7, ABSENT), cand(8, 9)]


def test_clearing_with_no_state_makes_the_frames_unknown(h):
    h.service.set_range(h.video, 1, 0, 3, PRESENT)
    h.service.set_range(h.video, 1, 4, 5, ABSENT)
    h.service.write_candidates(h.video, 1, [cand(0, 9)])
    assert h.service.set_range(h.video, 1, 0, 9, None)["ranges"] == []
    h.service.set_range(h.video, 1, 4, 5, ABSENT)
    h.service.write_candidates(h.video, 1, [cand(0, 9)])
    # clearing only the confirmed states uncovers the candidate under them
    assert h.service.set_range(h.video, 1, 0, 9, None, clear=[ABSENT, PRESENT])["ranges"] == [cand(0, 9)]


def test_bad_range_requests_are_refused_and_change_nothing(h):
    h.click(1, frame=1)
    with pytest.raises(ValueError):
        h.service.set_range(h.video, 1, 0, 3, CANDIDATE)  # no source
    with pytest.raises(ValueError):
        h.service.set_range(h.video, 1, 0, 3, PRESENT, source=DOG)
    with pytest.raises(ValueError):
        h.service.set_range(h.video, 1, 0, 3, None, clear=["maybe"])
    with pytest.raises(ValueError):
        h.service.set_range(h.video, 1, 0, 3, PRESENT, clear=[CANDIDATE])  # clear goes with no state
    assert h.service.object_info(h.video, 1)["ranges"] == []


# -- bulk candidates (what a discovery job writes) --------------------------------------------

def test_candidates_are_written_in_bulk_and_replace_drops_the_old_ones(h):
    h.click(1, frame=1)
    h.track()
    undo = h.service.versions.history(h.video, 1)["undo"]
    info = h.service.write_candidates(h.video, 1, [cand(0, 2, score=0.9), cand(6, 8, score=0.7)])
    assert info["ranges"] == [cand(0, 2, score=0.9), cand(6, 8, score=0.7)] and info["state"] == TRACKED
    info = h.service.write_candidates(h.video, 1, [cand(1, 3, "text:dog@sam3#2", 0.5)])
    assert info["ranges"] == [cand(0, 0, score=0.9), cand(1, 3, "text:dog@sam3#2", 0.5), cand(6, 8, score=0.7)]
    h.service.set_range(h.video, 1, 7, 7, PRESENT)
    info = h.service.write_candidates(h.video, 1, [cand(4, 9, score=0.2)], replace=True)
    # the old candidates are gone; the confirmed frame stays and still wins
    assert info["ranges"] == [cand(4, 6, score=0.2), rg(7, 7, PRESENT), cand(8, 9, score=0.2)]
    assert h.service.versions.history(h.video, 1)["undo"] == undo  # annotations are not seed changes
    assert h.state(1) == TRACKED


def test_a_bad_candidate_in_a_batch_writes_none_of_it(h):
    h.service.write_candidates(h.video, 1, [cand(0, 2)])
    with pytest.raises(ValueError):
        h.service.write_candidates(h.video, 1, [cand(4, 5), cand(7, 6)], replace=True)
    assert h.service.object_info(h.video, 1)["ranges"] == [cand(0, 2)]


def test_an_object_with_only_candidates_is_listed_with_them(h):
    h.service.write_candidates(h.video, 5, [cand(2, 4)])
    assert h.service.seeds.objects(h.video) == [5]
    assert h.service.objects(h.video)[0]["ranges"] == [cand(2, 4)]
    assert h.service.select(h.video) == []  # nothing to track: no clicks


# -- exports ---------------------------------------------------------------------------------------

def test_exports_record_every_range_and_only_absent_blanks_a_matte(h, tmp_path):
    h.click(1, frame=1), h.click(1, frame=3)
    h.service.set_range(h.video, 1, 2, 2, ABSENT)
    h.service.set_range(h.video, 1, 3, 4, PRESENT)
    h.service.write_candidates(h.video, 1, [cand(5, 9, score=0.25)])
    h.track()
    r = h.client.post("/export", json={"session_id": "s", "out_dir": str(tmp_path / "out")})
    assert r.status_code == 200, r.json
    mdir = tmp_path / "out/data/mattes_tracked/object_1"
    lit = [np.asarray(Image.open(mdir / f"{f + 1:05d}.png")).any() for f in range(10)]
    assert lit == [True, True, False] + [True] * 7  # candidates and present never blank a matte
    manifest = json.loads((tmp_path / "out/notes/sam-ui-export.json").read_text())
    assert manifest["products"]["object_1"]["ranges"] == [rg(2, 2, ABSENT), rg(3, 4, PRESENT),
                                                         cand(5, 9, score=0.25)]
    anchors = json.loads((tmp_path / "out/anchors.json").read_text())
    assert list(anchors["object_1"]["points"]) == ["2", "4"]  # a click in a present range is kept


# -- data from before candidates ------------------------------------------------------------------

def test_an_object_from_before_candidates_reads_as_it_was(h):
    d = h.root / h.video / "1"
    d.mkdir(parents=True)
    (d / "seeds.json").write_text(json.dumps({"3": {"points": [[0.1, 0.2]], "labels": [1]}}))
    (d / "ranges.json").write_text(json.dumps({"ranges": [rg(5, 6, ABSENT)]}))
    info = h.service.object_info(h.video, 1)
    assert info["ranges"] == [rg(5, 6, ABSENT)]
    assert h.service.seeds.hash(h.video, 1) == seeds_hash({3: {"points": [[0.1, 0.2]], "labels": [1]}},
                                                          [rg(5, 6, ABSENT)])
    assert h.service.seeds.annotations(h.video, 1) == []


def test_set_ranges_stays_absent_only(tmp_path):
    s = SeedStore(tmp_path)
    with pytest.raises(ValueError):
        s.set_ranges(V, 1, [rg(0, 3, PRESENT)])


# -- the GraphQL API and the session ------------------------------------------------------------

from test_inference_api import click, start, world  # noqa: E402,F401  (world is a fixture)


def test_the_session_sets_ranges_by_state_and_writes_candidates(world):
    api_of, _, path = world
    api = api_of()
    sid = start(api, path)
    click(api, sid, 1, 0, [[0.5, 0.5]], [1])
    info = api.write_object_candidates(sid, 1, [cand(2, 4, score=0.5)])
    assert info["ranges"] == [cand(2, 4, score=0.5)]
    info = api.set_object_range(sid, 1, 2, 3, PRESENT)
    assert info["ranges"] == [rg(2, 3, PRESENT), cand(4, 4, score=0.5)]
    info = api.set_object_range(sid, 1, 4, 4, None, clear=[CANDIDATE])
    assert info["ranges"] == [rg(2, 3, PRESENT)]
    info = api.set_object_range(sid, 1, 5, 5, CANDIDATE, source="tool", score=0.1)
    assert info["ranges"][-1] == cand(5, 5, "tool", 0.1)
    click(api, sid, 1, 5, [[0.5, 0.5]], [1])  # a candidate frame takes clicks
