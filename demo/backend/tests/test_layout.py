# sam-ui (Apache-2.0). New file, not from SAM 2.
"""The object layout (issue #21): the objects' order and their groups, per
video, in tracks/<video>/layout.json, outside every seeds hash."""
import json

import pytest

from test_api import Harness
from tracks import layout as lay
from tracks.store import TRACKED


@pytest.fixture
def h(tmp_path):
    return Harness(tmp_path)


def get(h):
    r = h.client.post("/object_layout", json={"session_id": "s"})
    assert r.status_code == 200
    return r.get_json()["layout"]


def put(h, layout):
    return h.client.post("/set_object_layout", json={"session_id": "s", "layout": layout})


def group(gid, members, name="Cast", color="#ff4fa3", collapsed=False, hidden=False):
    return {"id": gid, "name": name, "color": color, "members": members, "collapsed": collapsed, "hidden": hidden}


def test_a_video_with_no_layout_keeps_creation_order_and_no_groups(h):
    h.click(3), h.click(1), h.click(2)
    assert get(h) == {"order": [1, 2, 3], "groups": []}
    assert not (h.root / h.video / "layout.json").exists()


def test_a_layout_persists_across_a_restart_next_to_the_objects(h):
    h.click(1), h.click(2), h.click(3)
    r = put(h, {"order": [3, 1, 2], "groups": [group("g1", [1, 2])]})
    assert r.status_code == 200
    h.new_service()
    assert get(h) == {"order": [3, 1, 2], "groups": [group("g1", [1, 2])]}
    stored = json.loads((h.root / h.video / "layout.json").read_text())
    assert stored["order"] == [3, 1, 2] and stored["groups"][0]["members"] == [1, 2]


def test_reordering_and_regrouping_never_make_a_track_stale(h):
    h.click(1), h.click(2)
    h.track()
    before = {o: h.service.seeds.hash(h.video, o) for o in (1, 2)}
    history = {o: h.service.versions_info(h.video, o) for o in (1, 2)}
    put(h, {"order": [2, 1], "groups": [group("g1", [2])]})
    assert {o: h.service.seeds.hash(h.video, o) for o in (1, 2)} == before
    assert h.state(1) == TRACKED and h.state(2) == TRACKED
    assert h.track() == ("", [])  # nothing re-runs
    # and no undo step: layout is not a seed change
    assert {o: h.service.versions_info(h.video, o) for o in (1, 2)} == history


def test_objects_missing_from_the_layout_follow_in_creation_order(h):
    h.click(1), h.click(2), h.click(4)
    put(h, {"order": [4, 9], "groups": [group("g1", [9, 1])]})  # 9 never existed
    assert get(h) == {"order": [4, 1, 2], "groups": [group("g1", [1])]}
    h.click(3)  # a new object goes last
    assert get(h)["order"] == [4, 1, 2, 3]


def test_an_object_belongs_to_at_most_one_group(h):
    h.click(1), h.click(2)
    r = put(h, {"order": [1, 2], "groups": [group("a", [1]), group("b", [1, 2], name="Props")]})
    assert r.get_json()["layout"]["groups"] == [group("a", [1]), group("b", [2], name="Props")]


def test_a_groups_members_sit_together_in_the_order(h):
    h.click(1), h.click(2), h.click(3)
    put(h, {"order": [1, 3, 2], "groups": [group("g1", [2, 1])]})
    # the group sits where its first member is; members keep their relative order
    assert get(h) == {"order": [1, 2, 3], "groups": [group("g1", [1, 2])]}


def test_bad_layouts_are_refused(h):
    h.click(1)
    assert put(h, {"order": "1,2", "groups": []}).status_code == 400
    assert put(h, {"order": [1], "groups": [group("g 1", [1])]}).status_code == 400
    assert put(h, {"order": [1], "groups": [group("g1", [1], color="red")]}).status_code == 400
    assert put(h, {"order": [1], "groups": [group("g1", [1]), group("g1", [])]}).status_code == 400
    assert put(h, {"order": [True], "groups": []}).status_code == 400
    assert get(h) == {"order": [1], "groups": []}


def test_group_names_are_trimmed_capped_and_defaulted(h):
    h.click(1)
    r = put(h, {"order": [1], "groups": [group("g1", [1], name="  " + "x" * 80), group("g2", [], name="  ")]})
    groups = r.get_json()["layout"]["groups"]
    assert groups[0]["name"] == "x" * 64 and groups[1]["name"] == "Group"


def test_deleting_an_object_removes_it_from_the_order_and_its_group(h):
    h.click(1), h.click(2), h.click(3)
    put(h, {"order": [3, 2, 1], "groups": [group("g1", [2, 1])]})
    h.service.remove_object(h.video, 2)
    stored = json.loads((h.root / h.video / "layout.json").read_text())
    assert stored["order"] == [3, 1] and stored["groups"][0]["members"] == [1]
    assert get(h) == {"order": [3, 1], "groups": [group("g1", [1])]}


def test_deleting_a_group_keeps_its_members_ungrouped_in_place():
    layout = {"order": [3, 1, 2], "groups": [group("g1", [1, 2]), group("g2", [3], name="Props")]}
    assert lay.without_group(layout, "g1") == {"order": [3, 1, 2], "groups": [group("g2", [3], name="Props")]}


def test_deleting_a_group_through_the_route(h):
    h.click(1), h.click(2)
    put(h, {"order": [2, 1], "groups": [group("g1", [2, 1])]})
    put(h, {"order": [2, 1], "groups": []})
    assert get(h) == {"order": [2, 1], "groups": []}


def test_start_over_forgets_the_layout(h):
    h.click(1), h.click(2)
    put(h, {"order": [2, 1], "groups": [group("g1", [2])]})
    h.service.clear_video(h.video)
    h.click(1)
    assert get(h) == {"order": [1], "groups": []}


def test_a_damaged_layout_reads_as_none(h):
    h.click(2), h.click(1)
    (h.root / h.video / "layout.json").write_text("not json")
    assert get(h) == {"order": [1, 2], "groups": []}
    (h.root / h.video / "layout.json").write_text(json.dumps({"order": "x", "groups": [5]}))
    assert get(h) == {"order": [1, 2], "groups": []}


def test_a_layout_may_name_objects_not_clicked_yet(h):
    # studio saves the layout as you arrange it, before an object's first click
    h.click(1)
    put(h, {"order": [5, 1], "groups": [group("g1", [5])]})
    h.click(5)
    assert get(h) == {"order": [5, 1], "groups": [group("g1", [5])]}


def test_layouts_past_the_limits_are_refused(h):
    h.click(1)
    many = [group(f"g{i}", []) for i in range(lay.MAX_GROUPS + 1)]
    assert put(h, {"order": [1], "groups": many}).status_code == 400
    assert put(h, {"order": list(range(lay.MAX_IDS + 1)), "groups": []}).status_code == 400
    assert put(h, {"order": [1], "groups": [group("g1", list(range(lay.MAX_IDS + 1)))]}).status_code == 400
    assert put(h, {"order": [-1], "groups": []}).status_code == 400
    assert put(h, {"order": [lay.MAX_ID + 1], "groups": []}).status_code == 400
    assert put(h, {"order": [1], "groups": [group("g1", [1], name="x" * (lay.NAME_LIMIT + 1))]}).status_code == 400
    assert get(h) == {"order": [1], "groups": []}  # nothing was stored
    # at the limits is fine
    ok = put(h, {"order": list(range(lay.MAX_IDS)), "groups": [group(f"g{i}", []) for i in range(lay.MAX_GROUPS)]})
    assert ok.status_code == 200


def test_undo_and_redo_of_a_members_corrections_leave_the_layout_alone(h):
    # #18 x #21 x #23: the layout is outside the seeds history, so stepping a
    # grouped object's clicks (a cleared, negatives-only seed among them) never moves it
    h.click(1), h.click(2)
    h.track()
    layout = {"order": [2, 1], "groups": [group("g1", [1])]}
    put(h, layout)
    h.click(1, frame=2, labels=(0,))  # a "not here" seed, as SAM 3 stores it
    h.service.undo(h.video, 1)
    assert get(h) == layout
    h.service.redo(h.video, 1)
    assert get(h) == layout
    # removing the grouped object still forgets its seeds and its tracks
    assert (h.root / h.video / "1").exists() and 1 in h.service.seeds.objects(h.video)
    h.service.remove_object(h.video, 1)
    assert 1 not in h.service.seeds.objects(h.video)
    assert not (h.root / h.video / "1").exists()
    assert get(h)["order"] == [2]
