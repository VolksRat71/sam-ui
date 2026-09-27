# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Object names: metadata beside the seeds, never part of the seeds hash."""
import json

from test_api import Harness
from tracks.store import STALE, TRACKED


def names(h):
    return h.client.post("/object_names", json={"session_id": "s"}).get_json()["names"]


def rename(h, obj, name):
    return h.client.post("/rename_object", json={"session_id": "s", "object_id": obj, "name": name})


def test_a_rename_persists_across_a_restart(tmp_path):
    h = Harness(tmp_path)
    h.click(1), h.click(2)
    r = rename(h, 1, "  red cup  ")
    assert r.status_code == 200 and r.get_json() == {"object_id": 1, "name": "red cup"}
    h.new_service()
    assert names(h) == {"1": "red cup"}


def test_a_rename_leaves_seeds_and_tracks_as_they_were(tmp_path):
    h = Harness(tmp_path)
    h.click(1), h.click(2)
    h.track()
    before = h.service.seeds.hash(h.video, 1)
    rename(h, 1, "cup")
    assert h.service.seeds.hash(h.video, 1) == before
    assert h.state(1) == TRACKED and h.state(2) == TRACKED
    assert h.track() == ("", [])  # nothing went stale, so nothing re-runs
    h.click(1, points=[[0.6, 0.6]], clear=False)  # clicks still do
    assert h.state(1) == STALE and names(h) == {"1": "cup"}


def test_objects_without_a_name_load_fine(tmp_path):
    h = Harness(tmp_path)
    h.click(1), h.click(2)
    assert names(h) == {}
    # an old or damaged metadata file is ignored, not an error
    (h.root / h.video / "2" / "object.json").write_text("not json")
    (h.root / h.video / "1" / "object.json").write_text(json.dumps({"other": 1}))
    h.new_service()
    assert names(h) == {}
    assert {o["object_id"] for o in h.service.objects(h.video)} == {1, 2}


def test_names_are_trimmed_capped_and_cleared_when_empty(tmp_path):
    h = Harness(tmp_path)
    h.click(1)
    assert rename(h, 1, "x" * 80).get_json()["name"] == "x" * 64
    assert rename(h, 1, "   ").get_json()["name"] is None
    assert names(h) == {}
    assert rename(h, 1, 5).status_code == 400


def test_removing_an_object_forgets_its_name(tmp_path):
    h = Harness(tmp_path)
    h.click(1)
    rename(h, 1, "cup")
    h.service.remove_object(h.video, 1)
    assert names(h) == {}
