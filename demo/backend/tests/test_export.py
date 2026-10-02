# sam-ui (Apache-2.0). New file, not from SAM 2.
import json
import os
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


def test_refusals_and_replies_never_name_the_servers_own_paths(h, tmp_path):
    """The export root and the source video's path are the server's business:
    a refusal names only the folder the caller asked for, and the reply gives
    back that folder as asked, without the video's path (which stays in
    notes/sam-ui-export.json, beside the exported files)."""
    h.click(1)
    h.track()
    code, m = export(h, out_dir=str(tmp_path.parent / "elsewhere"))
    assert code == 400 and str(tmp_path) not in m["error"]
    out = tmp_path / "build"
    out.mkdir()
    (out / "products.json").write_text('{"products": []}')
    code, m = export(h, out_dir=str(out))
    assert code == 400 and m["error"].startswith(repr(str(out)))
    code, m = export(h, out_dir=str(out), force=True)
    assert code == 200 and m["out_dir"] == str(out) and "video_path" not in m
    notes = json.loads((out / "notes" / "sam-ui-export.json").read_text())
    assert notes["video_path"]  # still recorded beside the export


def _tree(d):
    """Every path under d with its bytes (None for a folder), to show nothing changed."""
    return {str(p.relative_to(d)): None if p.is_dir() else p.read_bytes() for p in sorted(d.rglob("*"))}


# (link inside the export folder, whether it points at a folder, frames=)
LINKS = [("data", True, False), ("data/mattes_tracked", True, False), ("data/mattes_tracked/object_1", True, False),
         ("notes", True, False), ("products.json", False, False), ("notes/sam-ui-export.json", False, False),
         ("data/review.json", False, False), ("data/frames", True, True), ("data/clip.mp4", False, True),
         ("data/frames/00001.jpg", False, True)]


@pytest.mark.parametrize("link,is_dir,frames", LINKS)
def test_a_link_inside_the_export_folder_cannot_lead_outside_the_root(h, tmp_path, tmp_path_factory, link, is_dir,
                                                                      frames):
    """Only out_dir was checked against the root, so a link planted inside it
    (out/data -> elsewhere) let export write, or rmtree, outside the root.
    Every path export writes or deletes is checked with links followed, before
    anything is written, so even with force nothing outside changes."""
    h.click(1)
    h.track()
    outside = tmp_path_factory.mktemp("outside")
    (outside / "mattes_tracked" / "object_1").mkdir(parents=True)
    (outside / "mattes_tracked" / "object_1" / "00001.png").write_bytes(b"theirs")
    (outside / "victim").write_text("keep")
    before = _tree(outside)
    out = tmp_path / "build"
    (out / link).parent.mkdir(parents=True, exist_ok=True)
    (out / link).symlink_to(outside if is_dir else outside / "victim")
    code, m = export(h, out_dir=str(out), force=True, frames=frames)
    assert code == 400 and "outside the export root" in m["error"] and link in m["error"]
    assert str(tmp_path) not in m["error"].replace(repr(str(out)), "") and str(outside) not in m["error"]
    assert _tree(outside) == before


def test_a_dangling_link_cannot_create_a_file_outside_the_root(h, tmp_path, tmp_path_factory):
    h.click(1)
    h.track()
    outside = tmp_path_factory.mktemp("outside")
    out = tmp_path / "build"
    (out / "data").mkdir(parents=True)
    (out / "data" / "review.json").symlink_to(outside / "new.json")  # nothing there yet
    code, m = export(h, out_dir=str(out))
    assert code == 400 and "data/review.json" in m["error"] and not (outside / "new.json").exists()


def test_a_link_loop_is_a_refusal_not_a_crash(h, tmp_path):
    h.click(1)
    h.track()
    out = tmp_path / "build"
    out.mkdir()
    (out / "data").symlink_to(out / "data")
    code, m = export(h, out_dir=str(out), force=True)
    assert code == 400 and "data" in m["error"]


def test_a_linked_matte_folder_is_refused_even_inside_the_root(h, tmp_path):
    """The matte folder is rmtree'd and refilled; a link there is refused
    rather than followed, wherever it points."""
    h.click(1)
    h.track()
    elsewhere = tmp_path / "other"
    elsewhere.mkdir()
    (elsewhere / "00001.png").write_bytes(b"theirs")
    out = tmp_path / "build"
    (out / "data" / "mattes_tracked").mkdir(parents=True)
    (out / "data" / "mattes_tracked" / "object_1").symlink_to(elsewhere)
    code, m = export(h, out_dir=str(out), force=True)
    assert code == 400 and "data/mattes_tracked/object_1" in m["error"]
    assert (elsewhere / "00001.png").read_bytes() == b"theirs"


def test_existing_mattes_are_not_replaced_without_force(h, tmp_path):
    """force gates the decision files and each exported object's matte folder;
    notes/sam-ui-export.json and data/frames are sam-ui's own and rewritten."""
    h.click(1)
    h.track()
    out = tmp_path / "build"
    assert export(h, out_dir=str(out))[0] == 200
    for n in ("products.json", "anchors.json", "shots.json"):
        (out / n).unlink()  # no decision clash left: only the mattes
    stale = out / "data" / "mattes_tracked" / "object_1" / "stale.png"
    stale.write_bytes(b"by hand")
    (out / "notes" / "sam-ui-export.json").write_text("{}")
    code, m = export(h, out_dir=str(out))
    assert code == 400 and "data/mattes_tracked/object_1" in m["error"] and "force" in m["error"]
    assert stale.exists() and (out / "notes" / "sam-ui-export.json").read_text() == "{}"
    assert export(h, out_dir=str(out), force=True)[0] == 200
    assert not stale.exists() and (out / "data" / "mattes_tracked" / "object_1" / "00001.png").exists()
    assert json.loads((out / "notes" / "sam-ui-export.json").read_text())["products"]


def _race(monkeypatch, plant):
    """Run plant() right after the pre-flight check passes: a link planted
    while the export runs."""
    import tracks.export as E

    checked = E._check_targets

    def racing(*a, **k):
        checked(*a, **k)
        plant()

    monkeypatch.setattr(E, "_check_targets", racing)


def test_a_link_planted_after_the_check_is_refused_before_anything_is_deleted(h, tmp_path, tmp_path_factory,
                                                                             monkeypatch):
    h.click(1)
    h.track()
    outside = tmp_path_factory.mktemp("outside")
    (outside / "mattes_tracked" / "object_1").mkdir(parents=True)
    (outside / "mattes_tracked" / "object_1" / "00001.png").write_bytes(b"theirs")
    before = _tree(outside)
    out = tmp_path / "build"
    _race(monkeypatch, lambda: (out.mkdir(exist_ok=True), (out / "data").symlink_to(outside)))
    code, m = export(h, out_dir=str(out), force=True)
    assert code == 400 and "outside the export root" in m["error"] and _tree(outside) == before


def test_a_matte_folder_linked_after_the_check_is_not_rmtreed(h, tmp_path, tmp_path_factory, monkeypatch):
    h.click(1)
    h.track()
    outside = tmp_path_factory.mktemp("outside")
    (outside / "00001.png").write_bytes(b"theirs")
    out = tmp_path / "build"

    def plant():
        (out / "data" / "mattes_tracked").mkdir(parents=True)
        (out / "data" / "mattes_tracked" / "object_1").symlink_to(outside)

    _race(monkeypatch, plant)
    code, m = export(h, out_dir=str(out), force=True)
    assert code == 400 and "data/mattes_tracked/object_1" in m["error"]
    assert (outside / "00001.png").read_bytes() == b"theirs"


def test_a_file_linked_after_the_check_is_replaced_not_written_through(h, tmp_path, tmp_path_factory, monkeypatch):
    h.click(1)
    h.track()
    outside = tmp_path_factory.mktemp("outside")
    (outside / "victim").write_text("keep")
    out = tmp_path / "build"
    _race(monkeypatch, lambda: (out.mkdir(exist_ok=True), (out / "products.json").symlink_to(outside / "victim")))
    assert export(h, out_dir=str(out), force=True)[0] == 200
    assert (outside / "victim").read_text() == "keep"
    assert not (out / "products.json").is_symlink() and json.loads((out / "products.json").read_text())["products"]


def test_a_hard_link_is_replaced_not_written_through(h, tmp_path, tmp_path_factory):
    """A hard link resolves inside the root, so only replacing the file (a temp
    file, then os.replace) keeps the other name's contents."""
    h.click(1)
    h.track()
    outside = tmp_path_factory.mktemp("outside")
    (outside / "victim").write_text("keep")
    out = tmp_path / "build"
    (out / "notes").mkdir(parents=True)
    os.link(outside / "victim", out / "notes" / "sam-ui-export.json")
    assert export(h, out_dir=str(out))[0] == 200
    assert (outside / "victim").read_text() == "keep"
    assert json.loads((out / "notes" / "sam-ui-export.json").read_text())["products"]


def test_a_link_inside_the_root_cannot_slip_past_force(h, tmp_path):
    """notes/sam-ui-export.json is always rewritten; a link there to a
    confirmed file must not carry that rewrite onto the confirmed file."""
    h.click(1)
    h.track()
    out = tmp_path / "build"
    out.mkdir()
    (out / "keep.json").write_text("CONFIRMED BY A PERSON")
    (out / "notes").mkdir()
    (out / "notes" / "sam-ui-export.json").symlink_to(out / "keep.json")
    assert export(h, out_dir=str(out))[0] == 200
    assert (out / "keep.json").read_text() == "CONFIRMED BY A PERSON"
    assert not (out / "notes" / "sam-ui-export.json").is_symlink()


def test_new_frames_never_write_through_an_old_frame(h, tmp_path, tmp_path_factory, monkeypatch):
    """ffmpeg -y writes through a link left at a frame's name; the old frames
    are unlinked first (they are sam-ui's own and always rewritten)."""
    import tracks.export as E

    h.click(1)
    h.track()
    outside = tmp_path_factory.mktemp("outside")
    (outside / "victim").write_text("keep")
    out = tmp_path / "build"
    (out / "data" / "frames").mkdir(parents=True)
    (out / "data" / "clip.mp4").write_bytes(b"x")  # already there: not copied again
    (out / "data" / "frames" / "00009.jpg").write_bytes(b"stale")
    _race(monkeypatch, lambda: (out / "data" / "frames" / "00001.jpg").symlink_to(outside / "victim"))

    def ffmpeg(cmd, check):  # writes 00001.jpg as ffmpeg -y does: through whatever is there
        with open(cmd[-1] % 1, "w") as f:
            f.write("frame")

    monkeypatch.setattr(E.subprocess, "run", ffmpeg)
    code, m = export(h, out_dir=str(out), frames=True)
    assert code == 200 and m["frames_on_disk"] == 1 and (outside / "victim").read_text() == "keep"
    assert sorted(p.name for p in (out / "data" / "frames").iterdir()) == ["00001.jpg"]


@pytest.mark.parametrize("rel", ["data", "data/mattes_tracked/object_1", "notes", "data/frames"])
def test_a_file_where_a_folder_belongs_is_a_400(h, tmp_path, rel):
    h.click(1)
    h.track()
    out = tmp_path / "build"
    (out / rel).parent.mkdir(parents=True, exist_ok=True)
    (out / rel).write_text("a file")
    code, m = export(h, out_dir=str(out), force=True, frames=True)
    assert code == 400 and rel in m["error"]


def test_a_folder_where_a_file_belongs_is_a_400(h, tmp_path):
    h.click(1)
    h.track()
    out = tmp_path / "build"
    (out / "products.json").mkdir(parents=True)
    code, m = export(h, out_dir=str(out), force=True)
    assert code == 400 and "products.json" in m["error"]


def test_the_force_refusal_names_studios_checkbox(h, tmp_path):
    h.click(1)
    h.track()
    out = tmp_path / "build"
    out.mkdir()
    (out / "products.json").write_text("{}")
    code, m = export(h, out_dir=str(out))
    assert code == 400 and "Replace existing" in m["error"]
    assert str(tmp_path) not in m["error"].replace(repr(str(out)), "")


@pytest.mark.parametrize("bad", [5, ["a"], None])
def test_out_dir_must_be_a_string(h, bad):
    code, m = export(h, out_dir=bad)
    assert code == 400 and "out_dir must be a string" in m["error"]


def test_a_missing_out_dir_is_a_400(h):
    code, m = export(h)
    assert code == 400 and "out_dir must be a string" in m["error"]


def test_the_default_export_root_is_sam_uis_own_folder(monkeypatch, tmp_path):
    from tracks.export import export_root

    monkeypatch.delenv("SAM_UI_EXPORT_ROOT", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    assert export_root() == (tmp_path / "Movies" / "sam-ui").resolve()


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
