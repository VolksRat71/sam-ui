# sam-ui (Apache-2.0). New file, not from SAM 2.
import os

import numpy as np
import pytest

from tracks import rle
from tracks.seeds import SeedStore, seeds_hash, video_key
from tracks.store import STALE, TRACKED, UNTRACKED, TrackStore

V = "v" * 64  # a video key


def square(h=40, w=60, y=5, x=10, s=12):
    m = np.zeros((h, w), bool)
    m[y:y + s, x:x + s] = True
    return m


def test_rle_round_trip_keeps_every_pixel():
    m = square()
    m[0, 0] = m[-1, -1] = True  # corners, where column-major order bites
    out = rle.decode(rle.encode(m))
    assert out.shape == m.shape and (out == m).all()
    assert isinstance(rle.encode(m)["counts"], str)


def test_seeds_hash_ignores_dict_order_and_sees_any_change():
    a = {3: {"points": [[0.1, 0.2]], "labels": [1]}, 7: {"points": [[0.5, 0.5]], "labels": [0]}}
    b = {7: {"labels": [0], "points": [[0.5, 0.5]]}, 3: {"labels": [1], "points": [[0.1, 0.2]]}}
    assert seeds_hash(a) == seeds_hash(b)
    moved = {**a, 3: {"points": [[0.1, 0.2001]], "labels": [1]}}
    relabelled = {**a, 7: {"points": [[0.5, 0.5]], "labels": [1]}}
    other_frame = {4: a[3], 7: a[7]}
    assert len({seeds_hash(a), seeds_hash(moved), seeds_hash(relabelled), seeds_hash(other_frame)}) == 4


def test_seeds_hash_of_seeds_without_masks_is_unchanged_and_a_mask_changes_it():
    a = {3: {"points": [[0.1, 0.2]], "labels": [1]}}
    assert seeds_hash(a) == seeds_hash({3: {**a[3], "mask": None}})  # tracks from before masks stay tracked
    with_mask = {3: {**a[3], "mask": {"size": [2, 2], "counts": "04"}}}
    other_mask = {3: {**a[3], "mask": {"size": [2, 2], "counts": "13"}}}
    assert len({seeds_hash(a), seeds_hash(with_mask), seeds_hash(other_mask)}) == 3


def test_clearing_a_track_also_drops_leftovers_a_crash_could_resurrect(tmp_path):
    t = TrackStore(tmp_path)
    t.save(V, 1, "sam2", "m", "h1", {0: square()}, 0.1)
    (tmp_path / V / "1" / ".sam2.old-deadbeef").mkdir()  # a crash after the swap, before the rmtree
    t.clear(V, 1, "sam2")
    assert t.meta(V, 1, "sam2") is None


def test_seeds_hash_ignores_a_frame_left_with_no_points():
    a = {3: {"points": [[0.1, 0.2]], "labels": [1]}}
    assert seeds_hash(a) == seeds_hash({**a, 9: {"points": [], "labels": []}})


def test_add_points_appends_or_replaces_like_sam2(tmp_path):
    s = SeedStore(tmp_path)
    s.add_points(V, 1, 0, [[0.1, 0.1]], [1], clear_old_points=True)
    s.add_points(V, 1, 0, [[0.2, 0.2]], [0], clear_old_points=False)
    assert s.seeds(V, 1)[0] == {"points": [[0.1, 0.1], [0.2, 0.2]], "labels": [1, 0]}
    s.add_points(V, 1, 0, [[0.3, 0.3]], [1], clear_old_points=True)
    assert s.seeds(V, 1)[0] == {"points": [[0.3, 0.3]], "labels": [1]}


def test_seed_store_survives_a_new_instance_and_lists_objects(tmp_path):
    SeedStore(tmp_path).add_points(V, 2, 5, [[0.4, 0.6]], [1], True)
    SeedStore(tmp_path).add_points(V, 0, 1, [[0.1, 0.1]], [1], True)
    s = SeedStore(tmp_path)
    assert s.objects(V) == [0, 2]
    assert s.seeds(V, 2) == {5: {"points": [[0.4, 0.6]], "labels": [1]}}
    assert s.objects("unknown") == []


def test_clear_frame_drops_only_that_frame(tmp_path):
    s = SeedStore(tmp_path)
    s.add_points(V, 1, 0, [[0.1, 0.1]], [1], True)
    s.add_points(V, 1, 9, [[0.9, 0.9]], [1], True)
    assert list(s.clear_frame(V, 1, 0)) == [9]
    assert list(SeedStore(tmp_path).seeds(V, 1)) == [9]


def test_track_round_trip_and_meta(tmp_path):
    t = TrackStore(tmp_path)
    frames = {i: square(x=10 + i) for i in range(5)}
    meta = t.save(V, 1, "sam2", "hiera_l", "h1", frames, elapsed_s=1.23456)
    assert meta["frames"] == [0, 4] and meta["n_frames"] == 5 and meta["elapsed_s"] == 1.235
    back = dict(TrackStore(tmp_path).masks(V, 1, "sam2"))
    assert sorted(back) == list(range(5))
    assert all((rle.decode(back[i]) == frames[i]).all() for i in frames)


def test_states_untracked_tracked_stale(tmp_path):
    t = TrackStore(tmp_path)
    assert t.state(V, 1, "sam2", "hiera_l", "h1") == UNTRACKED
    t.save(V, 1, "sam2", "hiera_l", "h1", {0: square()}, 0.1)
    assert t.state(V, 1, "sam2", "hiera_l", "h1") == TRACKED
    assert t.state(V, 1, "sam2", "hiera_l", "h2") == STALE  # seeds changed
    assert t.state(V, 1, "sam2", "hiera_t", "h1") == STALE  # model changed
    assert t.state(V, 1, "sam3", "x", "h1") == UNTRACKED  # another engine has its own track


def test_clear_one_object_leaves_the_others_and_the_seeds(tmp_path):
    s, t = SeedStore(tmp_path), TrackStore(tmp_path)
    for obj in (1, 2):
        s.add_points(V, obj, 0, [[0.5, 0.5]], [1], True)
        t.save(V, obj, "sam2", "m", "h", {0: square()}, 0.1)
    t.clear(V, 1)
    assert t.meta(V, 1, "sam2") is None and t.meta(V, 2, "sam2") is not None
    assert s.objects(V) == [1, 2]  # clearing a track keeps the object


def test_remove_object_takes_its_seeds_and_tracks(tmp_path):
    s, t = SeedStore(tmp_path), TrackStore(tmp_path)
    s.add_points(V, 1, 0, [[0.5, 0.5]], [1], True)
    t.save(V, 1, "sam2", "m", "h", {0: square()}, 0.1)
    s.remove_object(V, 1)
    assert s.objects(V) == [] and t.meta(V, 1, "sam2") is None


def test_resaving_replaces_the_track_whole(tmp_path):
    t = TrackStore(tmp_path)
    t.save(V, 1, "sam2", "m", "h1", {i: square() for i in range(10)}, 0.1)
    t.save(V, 1, "sam2", "m", "h2", {0: square()}, 0.1)
    assert [f for f, _ in t.masks(V, 1, "sam2")] == [0] and t.meta(V, 1, "sam2")["seeds_hash"] == "h2"
    leftovers = [p.name for p in (tmp_path / V / "1").iterdir() if p.name.startswith(".")]
    assert leftovers == []


def test_a_crash_mid_write_keeps_the_previous_track(tmp_path, monkeypatch):
    t = TrackStore(tmp_path)
    t.save(V, 1, "sam2", "m", "h1", {0: square()}, 0.1)

    def boom(*a, **k):
        raise RuntimeError("disk full")

    monkeypatch.setattr("tracks.rle.encode", boom)
    with pytest.raises(RuntimeError):
        t.save(V, 1, "sam2", "m", "h2", {0: square()}, 0.1)
    assert t.meta(V, 1, "sam2")["seeds_hash"] == "h1"
    assert len(list(t.masks(V, 1, "sam2"))) == 1
    assert [p.name for p in (tmp_path / V / "1").iterdir() if p.name.startswith(".")] == []


def test_video_key_is_the_file_sha256(tmp_path):
    p = tmp_path / "clip.bin"
    p.write_bytes(os.urandom(3_000_000))  # spans several read chunks
    import hashlib
    assert video_key(str(p)) == hashlib.sha256(p.read_bytes()).hexdigest()
