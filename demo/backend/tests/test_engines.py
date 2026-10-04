# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Two engines side by side: per-engine tracks and states, opt-in SAM 3 built
on first use, unknown or unavailable engines refused, and disagreement flags."""
import numpy as np
import pytest

from test_api import Harness, parse_all
from tracks.engine import FakeEngine
from tracks.service import EngineSpec
from tracks.store import STALE, TRACKED, UNTRACKED


class OtherFake(FakeEngine):
    """A second engine that agrees with FakeEngine except on frames >= 2,
    where its square is shifted by 2 px."""

    name, model = "fake3", "fake3-1"

    def track(self, video_path, objects, video_handle=None):
        self.calls.append(sorted(objects))
        for i in range(self.n_frames):
            yield i, {o: np.roll(self.mask(o, i, self.shape), 2 if i >= 2 else 0, axis=1) for o in objects}


@pytest.fixture
def h(tmp_path):
    h = Harness(tmp_path)
    h.built = []

    def factory():
        e = OtherFake(n_frames=4)
        h.built.append(e)
        return e

    h.service._specs["fake3"] = EngineSpec("fake3", "fake3-1", factory)
    return h


def track(h, engine=None, object_ids=None):
    body = {"session_id": "s", **({"engine": engine} if engine else {}),
            **({"object_ids": object_ids} if object_ids is not None else {})}
    r = h.client.post("/track_objects", json=body)
    return r.status_code, r.headers.get("Objects-Tracked"), parse_all(r.data)[1] if r.status_code == 200 else r.json


def states(h, obj):
    return {t["engine"]: t["state"] for t in h.service.object_info(h.video, obj)["tracks"]}


def test_the_second_engine_is_built_on_first_use_and_tracks_on_its_own(h):
    h.click(1)
    assert h.built == [] and states(h, 1) == {"fake": UNTRACKED, "fake3": UNTRACKED}
    track(h)  # the default engine
    assert h.built == [] and states(h, 1) == {"fake": TRACKED, "fake3": UNTRACKED}
    code, ids, closing = track(h, "fake3")
    assert code == 200 and ids == "1" and closing["done"] and len(h.built) == 1
    assert states(h, 1) == {"fake": TRACKED, "fake3": TRACKED}
    track(h, "fake3")
    assert len(h.built) == 1  # built once


def test_a_seed_edit_makes_every_engines_track_stale_and_each_retracks_alone(h):
    h.click(1)
    track(h), track(h, "fake3")
    h.click(1, points=[[0.9, 0.9]], clear=False)
    assert states(h, 1) == {"fake": STALE, "fake3": STALE}
    assert track(h)[1] == "1" and states(h, 1) == {"fake": TRACKED, "fake3": STALE}


def test_clear_track_drops_one_engine_or_all(h):
    h.click(1)
    track(h), track(h, "fake3")
    h.service.clear_track(h.video, 1, "fake3")
    assert states(h, 1) == {"fake": TRACKED, "fake3": UNTRACKED}
    h.service.clear_track(h.video, 1)
    assert states(h, 1) == {"fake": UNTRACKED, "fake3": UNTRACKED}


def test_unknown_and_unavailable_engines_are_refused_before_any_stream(h):
    h.click(1)
    code, _, body = track(h, "nope")
    assert code == 400 and "unknown engine" in body["error"]
    h.service._specs["gpu_only"] = EngineSpec("gpu_only", "x", lambda: None, unavailable=lambda: "needs CUDA")
    code, _, body = track(h, "gpu_only")
    assert code == 400 and "needs CUDA" in body["error"]
    assert h.service.jobs.running() == []


def test_engines_lists_default_first_with_availability(h):
    h.service._specs["gpu_only"] = EngineSpec("gpu_only", "x", lambda: None, unavailable=lambda: "needs CUDA")
    engines = h.client.get("/engines").json["engines"]
    assert [e["name"] for e in engines] == ["fake", "fake3", "gpu_only"]
    assert engines[0]["default"] and engines[1]["available"] and not engines[1]["loaded"]
    assert engines[2] == {"name": "gpu_only", "model": "x", "default": False, "available": False,
                          "reason": "needs CUDA", "loaded": False, "text": False,
                          "text_reason": "this engine takes clicks only; text prompts need SAM 3"}


def test_disagreement_flags_the_frames_where_the_engines_part(h):
    h.click(1), h.click(2)
    track(h), track(h, "fake3", [1])  # object 2 only has the default engine's track
    d = h.client.post("/track_disagreement", json={"session_id": "s", "b": "fake3", "threshold": 0.9}).json
    assert d["engines"] == ["fake", "fake3"] and d["skipped"] == {"2": {"fake": TRACKED, "fake3": UNTRACKED}}
    o = d["objects"]["1"]
    assert o["flagged"] == [2, 3] and o["iou"]["0"] == 1.0 and o["iou"]["2"] < 0.9
    h.click(1, points=[[0.9, 0.9]], clear=False)  # stale tracks are not compared
    d = h.client.post("/track_disagreement", json={"session_id": "s", "b": "fake3"}).json
    assert d["objects"] == {} and d["skipped"]["1"] == {"fake": STALE, "fake3": STALE}


def test_jobs_on_different_engines_may_hold_the_same_object(h):
    h.click(1)
    j1 = h.service.jobs.claim("s", h.video, [1], engine="fake")
    assert h.service.select(h.video, engine="fake") == [] and h.service.select(h.video, engine="fake3") == [1]
    assert states(h, 1) == {"fake": "tracking", "fake3": UNTRACKED}
    h.service.jobs.release(j1)


def test_export_takes_an_engine(h, tmp_path, monkeypatch):
    monkeypatch.setenv("SAM_UI_EXPORT_ROOT", str(tmp_path))
    h.click(1)
    track(h, "fake3")
    r = h.client.post("/export", json={"session_id": "s", "out_dir": str(tmp_path / "x"), "engine": "fake3"})
    assert r.status_code == 200 and r.json["products"]["object_1"]["engine"] == "fake3"
    r = h.client.post("/export", json={"session_id": "s", "out_dir": str(tmp_path / "y")})  # default: untracked there
    assert r.json["skipped"] == {"1": UNTRACKED}


# --- SAM 3 availability is cheap (GET /engines runs it, and studio waits on that at start)

def test_sam3_available_reports_missing_weights_and_never_imports_transformers(tmp_path, monkeypatch):
    import importlib.util
    import sys
    from tracks import sam3_engine

    monkeypatch.setenv("SAM_UI_SAM3_WEIGHTS", str(tmp_path))
    before = "transformers" in sys.modules
    assert "no SAM 3 weights" in sam3_engine.available()
    (tmp_path / "model.safetensors").write_bytes(b"")
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: None)
    assert sam3_engine.available() == "transformers is not installed"
    fake = tmp_path / "tf" / "transformers"
    fake.mkdir(parents=True)
    (fake / "__init__.py").write_text("")

    class Spec:
        origin = str(fake / "__init__.py")

    monkeypatch.setattr(importlib.util, "find_spec", lambda name: Spec())
    assert "needs 5.x" in sam3_engine.available()
    (fake / "models" / "sam3_tracker_video").mkdir(parents=True)
    assert sam3_engine.available() is None
    assert ("transformers" in sys.modules) == before  # located, never imported
