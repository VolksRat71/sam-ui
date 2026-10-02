# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Track versions and seed undo (issue #18): every finished track is kept as a
version of its object, keyed by its seeds hash, so undoing a seed change
brings the earlier track back from disk with no track job."""
import json
import os
import shutil
import time

import pytest

from test_api import Harness
from tracks import versions as ver
from tracks.engine import FakeEngine
from tracks.ranges import ABSENT
from tracks.service import NothingToUndo, ObjectBusy
from tracks.store import STALE, TRACKED, UNTRACKED

N = 30


@pytest.fixture
def h(tmp_path):
    # influence: a negative click moves the fake's masks near it, so versions differ
    return Harness(tmp_path, engine=FakeEngine(n_frames=N, influence=3))


def masks_bytes(h, obj=1, engine="fake"):
    return (h.root / h.video / str(obj) / engine / "masks.jsonl").read_bytes()


def accident(h, frame=12, obj=1):
    """A click that landed on the wrong object: a lone negative, which the fake reacts to."""
    h.click(obj, frame=frame, points=[[0.3, 0.3]], labels=(0,))


def history(h, obj=1):
    return h.service.versions_info(h.video, obj)


def calls(h):
    return len(h.engine.calls) + len(h.engine.stretches)


# -- versions are kept ----------------------------------------------------------------

def test_a_finished_track_is_kept_as_a_version_without_copying_its_masks(h):
    h.click(1, frame=0)
    h.track()
    vs = history(h)["versions"]
    assert len(vs) == 1
    v = vs[0]
    assert v["engine"] == "fake" and v["model"] == "fake-1" and v["current"] is True
    assert v["clicks"] == 1 and v["seed_frames"] == 1 and v["n_frames"] == N and v["created"]
    assert v["key"] == h.service.seeds.hash(h.video, 1)
    # the version shares the track's file: a hard link, not a second copy
    track = h.root / h.video / "1" / "fake" / "masks.jsonl"
    kept = h.root / h.video / "1" / "versions" / v["key"] / "fake" / "masks.jsonl"
    assert os.path.samefile(track, kept)


def test_each_new_track_adds_a_version_newest_first(h):
    h.click(1, frame=0)
    h.track()
    accident(h)
    h.track()
    vs = history(h)["versions"]
    assert [v["clicks"] for v in vs] == [2, 1]
    assert [v["current"] for v in vs] == [True, False]


# -- undo and redo ----------------------------------------------------------------------

def test_undoing_an_accidental_click_restores_the_earlier_track_with_no_job(h):
    h.click(1, frame=0)
    h.track()
    original = masks_bytes(h)
    accident(h)
    h.track()  # the accident got re-tracked: the current track is the wrong one
    assert masks_bytes(h) != original
    ran = calls(h)
    info = h.service.undo(h.video, 1)
    assert info["state"] == TRACKED
    assert masks_bytes(h) == original  # byte for byte, from the version
    assert calls(h) == ran and h.service.jobs.running() == []  # no job ran
    assert sorted(info["seeds"]) == [0]
    assert h.track() == ("", [])  # nothing is dirty


def test_undo_before_any_retrack_is_tracked_at_once(h):
    h.click(1, frame=0)
    h.track()
    original = masks_bytes(h)
    seeds = h.service.seeds.seeds(h.video, 1)
    accident(h)
    assert h.state(1) == STALE
    info = h.service.undo(h.video, 1)
    assert info["state"] == TRACKED and info["seeds"] == seeds
    assert masks_bytes(h) == original


def test_redo_brings_the_change_and_its_track_back(h):
    h.click(1, frame=0)
    h.track()
    accident(h)
    h.track()
    corrected = masks_bytes(h)
    h.service.undo(h.video, 1)
    assert history(h)["can_redo"] is True
    ran = calls(h)
    info = h.service.redo(h.video, 1)
    assert info["state"] == TRACKED and sorted(info["seeds"]) == [0, 12]
    assert masks_bytes(h) == corrected and calls(h) == ran
    assert history(h)["can_redo"] is False


def test_a_new_change_after_an_undo_clears_redo(h):
    h.click(1, frame=0)
    accident(h)
    h.service.undo(h.video, 1)
    h.click(1, frame=5)
    assert history(h)["can_redo"] is False
    with pytest.raises(NothingToUndo):
        h.service.redo(h.video, 1)


def test_undo_to_seeds_never_tracked_leaves_the_object_stale(h):
    h.click(1, frame=0)
    accident(h)
    h.track()  # only the seeds with the accident were ever tracked
    info = h.service.undo(h.video, 1)
    assert info["state"] == STALE and sorted(info["seeds"]) == [0]
    assert h.track()[0] == "1"  # a normal re-track
    assert h.state(1) == TRACKED


def test_taking_the_accidental_click_off_by_hand_also_brings_the_track_back(h):
    """Any seed change that lands on kept seeds restores their track, not only undo."""
    h.click(1, frame=0)
    h.track()
    original = masks_bytes(h)
    accident(h)
    h.track()
    h.service.clear_frame(h.video, 1, 12)  # removing the click, not undoing it
    assert h.state(1) == TRACKED and masks_bytes(h) == original


def test_a_change_during_a_job_never_swaps_the_track_under_it(h):
    h.click(1, frame=0)
    h.track()
    accident(h)
    h.track()
    job = h.service.jobs.claim("s", h.video, [1], engine="fake")
    before = masks_bytes(h)
    h.service.clear_frame(h.video, 1, 12)  # clicks go on during jobs; the swap waits
    assert masks_bytes(h) == before
    h.service.jobs.release(job)


def test_undoing_an_objects_first_click_keeps_the_object_listed_with_its_redo(h):
    h.click(1, frame=0)
    h.service.undo(h.video, 1)
    h.new_service()  # a reload
    assert 1 in h.service.seeds.objects(h.video)
    assert history(h)["can_redo"] is True
    assert sorted(h.service.redo(h.video, 1)["seeds"]) == [0]


def test_a_failed_restore_leaves_the_seeds_and_history_as_they_were(h, monkeypatch):
    h.click(1, frame=0)
    h.track()
    accident(h)
    h.track()
    seeds, before = h.service.seeds.seeds(h.video, 1), history(h)

    def boom(*args, **kw):
        raise OSError("disk full")

    monkeypatch.setattr(h.service.tracks, "adopt", boom)
    with pytest.raises(OSError):
        h.service.undo(h.video, 1)
    assert h.service.seeds.seeds(h.video, 1) == seeds and history(h) == before


def test_removing_an_object_mid_job_leaves_no_versions_behind(h):
    h.click(1, frame=0)
    it = h.service.track(h.video, str(h.video_path), [1])
    next(it)
    h.service.remove_object(h.video, 1)
    list(it)
    assert not (h.root / h.video / "1" / "versions").exists()


def test_nothing_to_undo_is_an_error_and_changes_nothing(h):
    h.click(1, frame=0)
    h.service.undo(h.video, 1)  # back to no clicks
    assert h.service.seeds.seeds(h.video, 1) == {}
    with pytest.raises(NothingToUndo):
        h.service.undo(h.video, 1)


def test_undo_covers_range_edits(h):
    h.click(1, frame=0)
    h.track()
    original = masks_bytes(h)
    h.service.set_range(h.video, 1, 20, 25, ABSENT)
    h.track()
    info = h.service.undo(h.video, 1)
    assert info["ranges"] == [] and info["state"] == TRACKED
    assert masks_bytes(h) == original
    info = h.service.redo(h.video, 1)
    assert info["ranges"] == [{"start": 20, "end": 25, "state": ABSENT}] and info["state"] == TRACKED


def test_clearing_the_last_click_can_be_undone_with_its_track(h):
    h.click(1, frame=0)
    h.track()
    original = masks_bytes(h)
    h.service.clear_frame(h.video, 1, 0)
    assert h.state(1) == UNTRACKED
    info = h.service.undo(h.video, 1)
    assert info["state"] == TRACKED and masks_bytes(h) == original


def test_restoring_a_version_from_the_list_is_itself_undoable(h):
    h.click(1, frame=0)
    h.track()
    original = masks_bytes(h)
    accident(h, 12)
    h.track()
    accident(h, 20)
    h.track()
    oldest = history(h)["versions"][-1]
    info = h.service.restore_version(h.video, 1, oldest["key"])
    assert info["state"] == TRACKED and sorted(info["seeds"]) == [0] and masks_bytes(h) == original
    assert history(h)["versions"][0]["current"] is True  # in use again: listed first
    info = h.service.undo(h.video, 1)
    assert sorted(info["seeds"]) == [0, 12, 20] and info["state"] == TRACKED
    with pytest.raises(KeyError):
        h.service.restore_version(h.video, 1, "0" * 64)


def test_the_seed_record_is_restored_as_stored(h):
    """A field this branch does not know (a sibling's text prompt) comes back too."""
    h.click(1, frame=0)
    p = h.root / h.video / "1" / "seeds.json"
    record = json.loads(p.read_text())
    record["0"]["text"] = "dog"
    p.write_text(json.dumps(record, sort_keys=True))
    h.track()
    accident(h)
    h.service.undo(h.video, 1)
    assert json.loads(p.read_text()) == record


# -- the restored track's provenance -------------------------------------------------------

def test_an_undo_across_a_bounded_retrack_keeps_each_tracks_own_provenance(h):
    h.click(1, frame=0)
    h.track()
    first = h.service.provenance(h.video, 1)
    accident(h, 15)
    h.track()  # a bounded pass around frame 15
    bounded = h.service.provenance(h.video, 1)
    assert bounded["bounded"]
    h.service.undo(h.video, 1)
    got = h.service.provenance(h.video, 1)
    assert got["passes"] == first["passes"] and got["provenance"] == first["provenance"] and got["bounded"] == []
    meta = h.service.tracks.meta(h.video, 1, "fake")
    assert meta["restored"]["from"] == "versions"  # it came back with no job, and says so
    h.service.redo(h.video, 1)
    got = h.service.provenance(h.video, 1)
    assert got["passes"] == bounded["passes"] and got["bounded"] == bounded["bounded"]


def test_a_correction_after_an_undo_retracks_bounded_against_the_restored_track(h):
    h.click(1, frame=0)
    h.track()
    accident(h, 15)
    h.track()
    h.service.undo(h.video, 1)
    stretches = len(h.engine.stretches)
    accident(h, 22)
    h.track()
    assert len(h.engine.stretches) == stretches + 1  # bounded, from the restored track's seed keys
    assert h.state(1) == TRACKED


# -- eviction and persistence --------------------------------------------------------------

def test_only_the_last_versions_are_kept_per_object_and_engine(h, monkeypatch):
    monkeypatch.setattr(ver, "KEEP", 3)
    h.click(1, frame=0)
    h.track()
    first = history(h)["versions"][0]["key"]
    for f in (5, 10, 15, 20):
        accident(h, f)
        h.track()
    vs = history(h)["versions"]
    assert len(vs) == 3 and vs[0]["current"] is True
    assert first not in {v["key"] for v in vs}
    assert not (h.root / h.video / "1" / "versions" / first / "fake").exists()


def test_a_version_made_current_again_is_evicted_last(h, monkeypatch):
    monkeypatch.setattr(ver, "KEEP", 3)
    h.click(1, frame=0)
    h.track()
    for f in (5, 10):
        accident(h, f)
        h.track()
    oldest = history(h)["versions"][-1]["key"]
    h.service.restore_version(h.video, 1, oldest)  # back to the first track: it is in use again
    assert history(h)["versions"][0]["key"] == oldest
    accident(h, 20)
    h.track()
    assert oldest in {v["key"] for v in history(h)["versions"]}


def test_removing_an_object_drops_its_versions_and_history(h):
    h.click(1, frame=0)
    h.track()
    accident(h)
    h.service.remove_object(h.video, 1)
    assert not (h.root / h.video / "1").exists()
    assert history(h) == {"can_undo": False, "can_redo": False, "versions": []}


def test_clearing_a_track_drops_that_engines_versions(h):
    h.click(1, frame=0)
    h.track()
    accident(h)
    h.service.clear_track(h.video, 1)
    assert history(h)["versions"] == []
    info = h.service.undo(h.video, 1)  # the clicks still undo
    assert info["state"] == UNTRACKED


def test_versions_and_history_survive_a_restart(h):
    h.click(1, frame=0)
    h.track()
    original = masks_bytes(h)
    accident(h)
    h.track()
    before = history(h)
    h.new_service()
    assert history(h) == before
    assert h.service.object_info(h.video, 1)["history"] == before
    info = h.service.undo(h.video, 1)
    assert info["state"] == TRACKED and masks_bytes(h) == original


def test_a_track_from_before_versions_loads_and_is_kept_on_the_next_change(h):
    h.click(1, frame=0)
    hash_ = h.service.seeds.hash(h.video, 1)
    masks = {f: FakeEngine.mask(1, f) for f in range(N)}
    h.service.tracks.save(h.video, 1, "fake", "fake-1", hash_, masks, 0.1)  # as an older sam-ui wrote it
    (h.root / h.video / "1" / "history.json").unlink()  # which kept no history and no versions
    shutil.rmtree(h.root / h.video / "1" / "versions")
    h.new_service()
    assert h.state(1) == TRACKED and history(h) == {"can_undo": False, "can_redo": False, "versions": []}
    original = masks_bytes(h)
    accident(h)
    h.track()
    assert len(history(h)["versions"]) == 2  # the old track was kept before the change
    info = h.service.undo(h.video, 1)
    assert info["state"] == TRACKED and masks_bytes(h) == original


# -- locks -------------------------------------------------------------------------------

def test_undo_is_refused_while_a_job_holds_the_object(h):
    h.click(1, frame=0)
    h.track()
    accident(h)
    seeds = h.service.seeds.seeds(h.video, 1)
    job = h.service.jobs.claim("s", h.video, [1], engine="fake")
    for op in (lambda: h.service.undo(h.video, 1), lambda: h.service.redo(h.video, 1),
               lambda: h.service.restore_version(h.video, 1, history(h)["versions"][0]["key"])):
        with pytest.raises(ObjectBusy):
            op()
    assert h.service.seeds.seeds(h.video, 1) == seeds
    h.service.jobs.release(job)
    h.service.undo(h.video, 1)



# -- the interactive session ----------------------------------------------------------------

from test_inference_api import click, start, world  # noqa: E402,F401  (world is a fixture)


def cond_frames(api, sid, obj):
    st = api.session_states[sid]["state"]
    i = st["obj_id_to_idx"].get(obj)
    return set() if i is None else set(st["temp_output_dict_per_obj"][i]["cond_frame_outputs"])


def test_undo_and_redo_keep_the_sessions_sam2_state_in_step(world):
    make, stub, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 0, [[0.5, 0.5]], [1])
    click(a, sid, 1, 3, [[0.2, 0.2]], [1])  # the accident
    assert cond_frames(a, sid, 1) == {0, 3}
    st = a.session_states[sid]["state"]
    i = st["obj_id_to_idx"][1]
    st["output_dict_per_obj"][i]["cond_frame_outputs"][3] = {"consolidated": True}  # as after a preflight
    info = a.undo_seeds(sid, 1)
    assert sorted(info["seeds"]) == [0]
    assert cond_frames(a, sid, 1) == {0}  # SAM 2 forgot the click too
    assert 3 not in st["output_dict_per_obj"][i]["non_cond_frame_outputs"]  # nothing left to refine
    stub.mask_calls.clear()
    info = a.redo_seeds(sid, 1)
    assert sorted(info["seeds"]) == [0, 3]
    assert stub.mask_calls == [(3, 1)]  # conditioned on the restored seed's approved mask
    assert cond_frames(a, sid, 1) == {0, 3}


def test_moving_a_frames_clicks_to_another_object_is_one_undo_per_object(world):
    make, _, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 0, [[0.5, 0.5]], [1])
    click(a, sid, 2, 0, [[0.2, 0.2]], [1])
    click(a, sid, 1, 3, [[0.8, 0.8]], [1])  # meant for object 2
    out = {o["object_id"]: o for o in a.move_clicks(sid, 3, 1, 2)}
    assert sorted(out[1]["seeds"]) == [0] and sorted(out[2]["seeds"]) == [0, 3]
    assert out[2]["seeds"][3]["points"] == [[0.8, 0.8]] and out[2]["seeds"][3]["mask"]
    assert 3 not in cond_frames(a, sid, 1) and 3 in cond_frames(a, sid, 2)
    assert sorted(a.undo_seeds(sid, 2)["seeds"]) == [0]  # object 2 lets go of them
    assert sorted(a.undo_seeds(sid, 1)["seeds"]) == [0, 3]  # object 1 has them back


def test_moved_clicks_join_the_clicks_the_target_has_on_that_frame(world):
    make, _, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 2, 3, [[0.2, 0.2]], [1])
    click(a, sid, 1, 3, [[0.8, 0.8]], [1])
    out = {o["object_id"]: o for o in a.move_clicks(sid, 3, 1, 2)}
    assert out[2]["seeds"][3]["points"] == [[0.2, 0.2], [0.8, 0.8]] and out[2]["seeds"][3]["labels"] == [1, 1]
    assert out[1]["seeds"] == {}


def test_moving_clicks_into_the_targets_absent_range_is_refused(world):
    make, _, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 2, 0, [[0.2, 0.2]], [1])
    click(a, sid, 1, 3, [[0.8, 0.8]], [1])
    a.set_object_range(sid, 2, 2, 4, ABSENT)
    with pytest.raises(ValueError, match="absent"):
        a.move_clicks(sid, 3, 1, 2)
    video = a.session_states[sid]["video"]
    assert sorted(a.tracks.seeds.seeds(video, 1)) == [3] and sorted(a.tracks.seeds.seeds(video, 2)) == [0]


def test_a_move_the_target_refuses_leaves_the_source_untouched(world):
    make, stub, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 3, [[0.8, 0.8]], [1])
    click(a, sid, 2, 0, [[0.2, 0.2]], [1])
    video = a.session_states[sid]["video"]
    before = (a.tracks.seeds.seeds(video, 1), a.tracks.versions_info(video, 1))
    real = stub.add_new_points_or_box

    def boom(*args, **kw):
        raise RuntimeError("MPS backend out of memory")

    stub.add_new_points_or_box = boom
    with pytest.raises(RuntimeError):
        a.move_clicks(sid, 3, 1, 2)
    stub.add_new_points_or_box = real
    assert (a.tracks.seeds.seeds(video, 1), a.tracks.versions_info(video, 1)) == before
    assert 3 in cond_frames(a, sid, 1)


def test_moving_clicks_is_refused_while_either_object_is_tracking(world):
    make, _, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 3, [[0.8, 0.8]], [1])
    click(a, sid, 2, 0, [[0.2, 0.2]], [1])
    video = a.session_states[sid]["video"]
    job = a.tracks.jobs.claim(sid, video, [2], engine="fake")
    with pytest.raises(ObjectBusy):
        a.move_clicks(sid, 3, 1, 2)
    a.tracks.jobs.release(job)
    with pytest.raises(ValueError, match="no clicks"):
        a.move_clicks(sid, 5, 1, 2)
    with pytest.raises(ValueError, match="itself"):
        a.move_clicks(sid, 3, 1, 1)



# -- corrections (#23, #26) under undo ------------------------------------------------------

def undo_depth(a, sid, obj):
    return len(a.tracks.versions.history(a.session_states[sid]["video"], obj)["undo"])


def test_a_refused_click_adds_no_undo_step(world):
    """A lone negative on SAM 2 (needs_positive) and a negative inside an
    absent range are refused before anything is recorded: nothing to undo."""
    make, _, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 0, [[0.5, 0.5]], [1])
    a.set_object_range(sid, 1, 4, 5, ABSENT)
    depth = undo_depth(a, sid, 1)
    with pytest.raises(ValueError, match="^needs_positive: "):
        click(a, sid, 1, 2, [[0.5, 0.5]], [0])
    with pytest.raises(ValueError, match="absent"):
        click(a, sid, 1, 4, [[0.5, 0.5]], [0], engine="sam3")
    assert undo_depth(a, sid, 1) == depth
    assert sorted(a.undo_seeds(sid, 1)["seeds"]) == [0]  # the undo is the range's, not a refused click's
    assert a.object_tracks(sid)[0]["ranges"] == []


def test_a_positive_that_ends_an_absence_is_one_undo_step_with_its_range(world):
    make, _, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 0, [[0.5, 0.5]], [1])
    a.set_object_range(sid, 1, 2, 5, ABSENT)
    depth = undo_depth(a, sid, 1)
    click(a, sid, 1, 4, [[0.5, 0.5]], [1])  # the object is back on frame 4
    info = a.object_tracks(sid)[0]
    assert info["ranges"] == [{"start": 2, "end": 3, "state": ABSENT}] and sorted(info["seeds"]) == [0, 4]
    assert undo_depth(a, sid, 1) == depth + 1
    info = a.undo_seeds(sid, 1)
    assert sorted(info["seeds"]) == [0] and info["ranges"] == [{"start": 2, "end": 5, "state": ABSENT}]
    info = a.redo_seeds(sid, 1)
    assert sorted(info["seeds"]) == [0, 4] and info["ranges"] == [{"start": 2, "end": 3, "state": ABSENT}]


def test_undo_and_redo_never_condition_the_session_on_a_cleared_seed(world):
    """As start_session: a restored 'not on this frame' seed (a SAM 3 lone
    negative, its mask empty) stays out of the session's SAM 2 state."""
    make, stub, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 0, [[0.5, 0.5]], [1])
    click(a, sid, 1, 3, [[0.5, 0.5]], [0], engine="sam3")
    a.undo_seeds(sid, 1)
    stub.mask_calls.clear()
    stub.point_calls.clear()
    info = a.redo_seeds(sid, 1)
    assert sorted(info["seeds"]) == [0, 3]
    assert stub.mask_calls == [] and stub.point_calls == []
    assert cond_frames(a, sid, 1) == {0}


@pytest.mark.parametrize("engine", [None, "sam2", "sam-3"])
def test_moving_a_cleared_seed_is_refused_on_sam2_or_with_no_engine(world, engine):
    """The target is held to the rule of the engine on screen: with none, SAM
    2 or one the server does not know, a frame of only negatives is refused,
    and neither object changes or gets an undo step."""
    make, _, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 3, [[0.5, 0.5]], [0], engine="sam3")
    click(a, sid, 2, 0, [[0.2, 0.2]], [1])
    video = a.session_states[sid]["video"]
    before = (a.tracks.seeds.seeds(video, 1), a.tracks.versions_info(video, 1), a.tracks.versions_info(video, 2))
    with pytest.raises(ValueError, match="^needs_positive: "):
        a.move_clicks(sid, 3, 1, 2, engine)
    assert (a.tracks.seeds.seeds(video, 1), a.tracks.versions_info(video, 1),
            a.tracks.versions_info(video, 2)) == before


def test_moving_a_cleared_seed_on_sam3_is_one_undo_step_per_object(world):
    """On SAM 3 a frame of negatives alone is 'not here', so it moves like any
    clicks: the target gets them, as a cleared seed, and each object's change
    is one undo step that its undo reverses."""
    from tracks.seeds import cleared

    make, _, path = world
    a = make()
    sid = start(a, path)
    click(a, sid, 1, 0, [[0.5, 0.5]], [1])
    click(a, sid, 1, 3, [[0.5, 0.5]], [0], engine="sam3")  # meant for object 2
    click(a, sid, 2, 0, [[0.2, 0.2]], [1])
    video = a.session_states[sid]["video"]
    depth = (undo_depth(a, sid, 1), undo_depth(a, sid, 2))
    out = {o["object_id"]: o for o in a.move_clicks(sid, 3, 1, 2, "sam3")}
    assert sorted(out[1]["seeds"]) == [0] and sorted(out[2]["seeds"]) == [0, 3]
    assert out[2]["seeds"][3]["labels"] == [0] and cleared(a.tracks.seeds.seeds(video, 2)[3])
    assert (undo_depth(a, sid, 1), undo_depth(a, sid, 2)) == (depth[0] + 1, depth[1] + 1)
    assert sorted(a.undo_seeds(sid, 2)["seeds"]) == [0]  # object 2 lets go of them
    assert sorted(a.undo_seeds(sid, 1)["seeds"]) == [0, 3]  # object 1 has them back
    assert a.tracks.seeds.seeds(video, 1)[3]["labels"] == [0]


def test_a_kept_track_from_before_cleared_seeds_were_skipped_is_not_made_current(h):
    """The seeds hash does not say whether a SAM 2 track skipped a cleared
    seed or conditioned on it (the old way, which loses the object around
    it). A kept track that does not list its cleared seeds stays out: the
    undo leaves the object stale, for a re-track."""
    h.engine.skips_cleared = True  # as SAM 2
    h.click(1, frame=0)
    accident(h)  # a lone negative with no mask: a cleared seed
    h.track()
    key = h.service.seeds.hash(h.video, 1)
    kept = h.root / h.video / "1" / "versions" / key / "fake" / "track.json"
    meta = json.loads(kept.read_text())
    assert meta["cleared_seeds"] == [12]
    old = {k: v for k, v in meta.items() if k != "cleared_seeds"}  # as an older sam-ui wrote it
    kept.unlink()
    kept.write_text(json.dumps(old))
    h.click(1, frame=20)
    h.track()
    info = h.service.undo(h.video, 1)
    assert sorted(info["seeds"]) == [0, 12] and info["state"] == STALE
    info = h.service.redo(h.video, 1)  # its own track lists the cleared seed: back at once
    assert sorted(info["seeds"]) == [0, 12, 20] and info["state"] == TRACKED


# -- the real model ---------------------------------------------------------------------

from pathlib import Path  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402

from test_inference_api import CKPT, _twotone  # noqa: E402
from inference.predictor import InferenceAPI  # noqa: E402


def _du(path: Path) -> int:
    """Bytes on disk under path, each hard-linked file counted once."""
    seen, total = set(), 0
    for p in path.rglob("*"):
        if p.is_file():
            st = p.stat()
            if (st.st_dev, st.st_ino) not in seen:
                seen.add((st.st_dev, st.st_ino))
                total += st.st_size
    return total


@pytest.mark.slow
@pytest.mark.skipif(not CKPT.exists() or os.environ.get("SAM_UI_SLOW") != "1",
                    reason="set SAM_UI_SLOW=1 with the large checkpoint in checkpoints/")
def test_real_sam2_undo_of_an_accidental_click_brings_the_track_back_with_no_job(tmp_path):
    from sam2.build_sam import build_sam2_video_predictor

    h, w = 240, 320
    _twotone(tmp_path / "bar.mp4")
    dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    pred = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_l.yaml", str(CKPT), device=dev)
    a = InferenceAPI(predictor=pred, device=torch.device(dev), tracks_root=str(tmp_path / "tracks"))
    sid = start(a, str(tmp_path / "bar.mp4"))
    e, runs = a.tracks.engine, []
    real_track, real_stretch = e.track, e.track_stretch
    e.track = lambda *args, **kw: (runs.append("track"), real_track(*args, **kw))[1]
    e.track_stretch = lambda *args, **kw: (runs.append("stretch"), real_stretch(*args, **kw))[1]
    ctx = a.track_context(sid)
    obj_dir = Path(tmp_path / "tracks" / ctx.video / "0")
    masks = obj_dir / "sam2" / "masks.jsonl"
    y = 125 / h

    def track():
        with a.inference_lock, a.autocast_context():
            list(ctx.service.track(ctx.video, ctx.path, [0], video_handle=ctx.video_handle))

    with torch.inference_mode():
        click(a, sid, 0, 0, [[55 / w, y]], [1])  # the red half
        track()
        original = masks.read_bytes()
        click(a, sid, 0, 10, [[(30 + 50 + 75) / w, y]], [1])  # the accident: a click on the orange half
        track()
        assert masks.read_bytes() != original
        ran = list(runs)
        t0 = time.perf_counter()
        info = a.undo_seeds(sid, 0)
        undo_ms = (time.perf_counter() - t0) * 1000
        assert info["state"] == TRACKED and sorted(info["seeds"]) == [0]
        assert masks.read_bytes() == original and runs == ran  # byte for byte, and no job ran
        # SAM 2's session forgot the accident: a click on frame 10 refines the cached (red) mask
        out = click(a, sid, 0, 10, [[(30 + 50 + 25) / w, y]], [1])[0]
        x = 30 + 50
        assert out[100:150, x + 50:x + 100].sum() < 0.05 * out[100:150, x:x + 50].sum()
    print(f"\nundo in {undo_ms:.0f} ms; a {len(original)} B track ({len(original) // 20} B a frame at {w}x{h}); "
          f"versions dir {_du(obj_dir / 'versions')} B, object dir {_du(obj_dir)} B; engine runs {ran}")
