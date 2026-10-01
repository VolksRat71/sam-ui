# sam-ui (Apache-2.0). New file, not from SAM 2.
import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from test_api import Harness
from tracks.engine import FakeEngine

ROTO_SCRIPTS = Path.home() / "Desktop/projects/.claude/skills/rotoscoping-video-subjects/scripts"


@pytest.fixture
def h(tmp_path, monkeypatch):
    monkeypatch.setenv("SAM_UI_EXPORT_ROOT", str(tmp_path))
    return Harness(tmp_path)


def export(h, **body):
    r = h.client.post("/export", json={"session_id": "s", **body})
    return r.status_code, r.json


def test_tracked_objects_become_a_working_folder(h, tmp_path):
    h.click(1, frame=2, points=[[0.25, 0.5]], labels=(1,))
    h.click(2)
    h.track()
    out = tmp_path / "build"
    code, m = export(h, out_dir=str(out), objects={"1": {"id": "taxi", "prompt": "yellow taxi", "color": "#ffcc00"}, "2": {}})
    assert code == 200 and set(m["products"]) == {"taxi", "object_2"} and m["skipped"] == {}
    products = json.loads((out / "products.json").read_text())["products"]
    taxi = next(p for p in products if p["id"] == "taxi")
    assert taxi == {"id": "taxi", "shots": [1], "prompt": "yellow taxi", "color": "#ffcc00", "status": "confirmed",
                    "meta": {"sam_ui_object": 1}}
    # sam-ui frame i is the working folder's frame i + 1
    files = sorted(p.name for p in (out / "data/mattes_tracked/taxi").iterdir())
    assert files == [f"{i:05d}.png" for i in range(1, 5)]  # 4 fake frames, 0-3 -> 1-4
    png = np.asarray(Image.open(out / "data/mattes_tracked/taxi/00003.png"))
    assert set(np.unique(png)) <= {0, 255} and ((png > 127) == FakeEngine.mask(1, 2)).all()
    # clicks as full-res pixels on the 1-based frame
    anchors = json.loads((out / "anchors.json").read_text())
    assert anchors["taxi"] == {"points": {"3": [[8, 12, 1]]}}  # 0.25 * 32, 0.5 * 24
    assert json.loads((out / "shots.json").read_text()) == {"cuts": [1], "unsure": []}
    assert json.loads((out / "notes/sam-ui-export.json").read_text())["products"]["taxi"]["engine"] == "fake"


def test_untracked_and_stale_objects_are_skipped_unless_asked(h, tmp_path):
    h.click(1), h.click(2), h.click(3)
    h.track()
    h.service.clear_track(h.video, 1)
    h.click(2, points=[[0.9, 0.9]], clear=False)  # stale now
    code, m = export(h, out_dir=str(tmp_path / "a"))
    assert code == 200 and set(m["products"]) == {"object_3"} and m["skipped"] == {"1": "untracked", "2": "stale"}
    code, m = export(h, out_dir=str(tmp_path / "b"), include_stale=True)
    assert set(m["products"]) == {"object_2", "object_3"}


def test_confirmed_decisions_are_not_overwritten_without_force(h, tmp_path):
    h.click(1)
    h.track()
    out = tmp_path / "build"
    out.mkdir()
    (out / "products.json").write_text('{"products": []}')
    code, m = export(h, out_dir=str(out))
    assert code == 400 and "products.json" in m["error"]
    assert (out / "products.json").read_text() == '{"products": []}'
    assert export(h, out_dir=str(out), force=True)[0] == 200


def test_exports_stay_under_the_export_root(h, tmp_path):
    h.click(1)
    h.track()
    code, m = export(h, out_dir=str(tmp_path.parent / "elsewhere"))
    assert code == 400 and "outside the export root" in m["error"]
    code, m = export(h, out_dir=str(tmp_path / ".." / "sneaky"))
    assert code == 400


def test_bad_ids_and_colours_are_refused(h, tmp_path):
    h.click(1), h.click(2)
    h.track()
    assert export(h, out_dir=str(tmp_path / "x"), objects={"1": {"id": "../evil"}})[0] == 400
    assert export(h, out_dir=str(tmp_path / "y"), objects={"1": {"color": "red"}})[0] == 400
    assert export(h, out_dir=str(tmp_path / "z"), objects={"1": {"id": "a"}, "2": {"id": "a"}})[0] == 400


@pytest.mark.skipif(not ROTO_SCRIPTS.exists(), reason="the rotoscoping skill is not on this machine")
def test_the_roto_pipeline_loads_the_export(h, tmp_path):
    h.click(1), h.click(2)
    h.track()
    out = tmp_path / "build"
    export(h, out_dir=str(out))
    sys.path.insert(0, str(ROTO_SCRIPTS))
    try:
        from products import load_products
        from shots import load_cuts
        cuts = load_cuts(str(out / "shots.json"))
        prods = load_products(str(out / "products.json"), cuts)
    finally:
        sys.path.remove(str(ROTO_SCRIPTS))
    assert [p.id for p in prods] == ["object_1", "object_2"]


# -- the object layout (issue #21): order and a folder per group ------------------

def _layout(h, order, groups):
    r = h.client.post("/set_object_layout", json={"session_id": "s", "layout": {"order": order, "groups": groups}})
    assert r.status_code == 200


CAST = {"id": "g1", "name": "The Cast", "color": "#ff4fa3", "members": [3, 1], "collapsed": False, "hidden": False}


def test_an_export_follows_the_layout_order_and_records_groups(h, tmp_path):
    h.click(1), h.click(2), h.click(3)
    h.track()
    _layout(h, [2, 3, 1], [CAST])
    out = tmp_path / "build"
    code, m = export(h, out_dir=str(out))
    assert code == 200
    products = json.loads((out / "products.json").read_text())["products"]
    assert [p["id"] for p in products] == ["object_2", "object_3", "object_1"]
    assert products[0]["meta"] == {"sam_ui_object": 2}  # ungrouped: no group key
    assert products[1]["meta"] == {"sam_ui_object": 3, "group": {"id": "g1", "name": "The Cast"}}
    # the manifest keeps the order, each product's group, and the groups themselves
    notes = json.loads((out / "notes/sam-ui-export.json").read_text())
    assert list(notes["products"]) == ["object_2", "object_3", "object_1"]
    assert notes["products"]["object_1"]["group"] == {"id": "g1", "name": "The Cast"}
    assert notes["products"]["object_2"]["group"] is None
    assert notes["groups"] == [{"id": "g1", "name": "The Cast", "color": "#ff4fa3", "folder": "the_cast",
                                "members": ["object_3", "object_1"], "union": False}]
    # a folder per group; the mattes stay where the roto pipeline reads them
    group_json = json.loads((out / "data/groups/the_cast/group.json").read_text())
    assert group_json["members"] == ["object_3", "object_1"]
    assert not (out / "data/groups/the_cast/union").exists()  # off by default
    assert (out / "data/mattes_tracked/object_3/00001.png").exists()


def test_a_union_matte_per_group_is_optional(h, tmp_path):
    h.click(1), h.click(2), h.click(3)
    h.track()
    _layout(h, [1, 2, 3], [CAST])
    out = tmp_path / "build"
    code, m = export(h, out_dir=str(out), union=True)
    assert code == 200 and m["groups"][0]["union"] is True
    files = sorted(p.name for p in (out / "data/groups/the_cast/union").iterdir())
    assert files == [f"{i:05d}.png" for i in range(1, 5)]
    png = np.asarray(Image.open(out / "data/groups/the_cast/union/00002.png")) > 127
    assert (png == (FakeEngine.mask(1, 1) | FakeEngine.mask(3, 1))).all()
    assert not (png & FakeEngine.mask(2, 1) & ~FakeEngine.mask(1, 1) & ~FakeEngine.mask(3, 1)).any()


def test_a_group_with_no_exported_member_gets_no_folder(h, tmp_path):
    h.click(1), h.click(2), h.click(3)
    h.track()
    h.service.clear_track(h.video, 1)
    h.service.clear_track(h.video, 3)
    _layout(h, [1, 2, 3], [CAST])
    out = tmp_path / "build"
    code, m = export(h, out_dir=str(out), union=True)
    assert code == 200 and m["groups"] == [] and not (out / "data/groups").exists()


def test_a_re_export_drops_group_folders_that_are_gone(h, tmp_path):
    h.click(1), h.click(3)
    h.track()
    _layout(h, [1, 3], [CAST])
    out = tmp_path / "build"
    export(h, out_dir=str(out))
    _layout(h, [1, 3], [])
    export(h, out_dir=str(out), force=True)
    assert not (out / "data/groups").exists()


def test_group_folders_are_unique(h, tmp_path):
    h.click(1), h.click(2)
    h.track()
    _layout(h, [1, 2], [{**CAST, "members": [1]}, {**CAST, "id": "g2", "members": [2]}])
    code, m = export(h, out_dir=str(tmp_path / "b"))
    assert [g["folder"] for g in m["groups"]] == ["the_cast", "the_cast_2"]
