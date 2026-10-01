# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Lowering the memory floor (issue #11): the precision switches, idle
unloading of SAM 3's tracker and detector, and GET /engines saying what is
loaded. No model is loaded here; the real-model checks are in test_text.py and
test_streaming.py (SAM_UI_SLOW=1)."""
import contextlib

import pytest

from tracks import memory, precision
from tracks.sam3_engine import Sam3Engine


def test_precision_names(monkeypatch):
    monkeypatch.delenv("SAM_UI_SAM3_DTYPE", raising=False)
    assert precision.dtype_name("SAM_UI_SAM3_DTYPE") == "float32"
    for raw, want in (("bf16", "bfloat16"), ("FP16", "float16"), ("fp32", "float32"), (" bfloat16 ", "bfloat16")):
        monkeypatch.setenv("SAM_UI_SAM3_DTYPE", raw)
        assert precision.dtype_name("SAM_UI_SAM3_DTYPE") == want
    monkeypatch.setenv("SAM_UI_SAM3_DTYPE", "int8")
    with pytest.raises(ValueError, match="fp32, bf16 or fp16"):
        precision.sam3_dtype()


def test_sam2_autocast_is_off_unless_asked(monkeypatch):
    import torch

    monkeypatch.delenv("SAM_UI_SAM2_DTYPE", raising=False)
    assert isinstance(precision.sam2_autocast("mps"), contextlib.nullcontext)
    assert isinstance(precision.sam2_autocast("cpu"), contextlib.nullcontext)
    monkeypatch.setenv("SAM_UI_SAM2_DTYPE", "bf16")
    ctx = precision.sam2_autocast("mps")
    assert isinstance(ctx, torch.autocast) and ctx.fast_dtype == torch.bfloat16
    assert isinstance(precision.sam2_autocast("cpu"), contextlib.nullcontext)  # MPS only


def test_idle_seconds(monkeypatch):
    monkeypatch.delenv("X_IDLE", raising=False)
    assert memory.idle_seconds("X_IDLE", 30.0) == 30.0
    assert memory.idle_seconds("X_IDLE", None) is None
    for raw, want in (("0", 0.0), ("90", 90.0), ("never", None), ("", None), ("-1", None), ("off", None)):
        monkeypatch.setenv("X_IDLE", raw)
        assert memory.idle_seconds("X_IDLE", 30.0) == want
    monkeypatch.setenv("X_IDLE", "soon")
    with pytest.raises(ValueError, match="seconds"):
        memory.idle_seconds("X_IDLE", 30.0)


@pytest.fixture
def engine(monkeypatch):
    """A Sam3Engine whose parts are stand-ins, so nothing loads."""
    monkeypatch.setattr(memory, "release_cached", lambda: None)
    monkeypatch.setattr(memory, "clear_lru_caches", lambda *a: 0)
    e = Sam3Engine(device="cpu")
    e._loaded, e._detector = ("proc", "model", "cpu"), ("det", "tok")
    yield e
    if e._timer is not None:
        e._timer.cancel()


def test_detector_unloads_after_its_idle_time_and_the_tracker_stays(engine):
    engine.idle_s, engine.detector_idle_s = None, 60.0
    engine._used = {"engine": 100.0, "detector": 100.0}
    assert engine.release_idle(now=159.0) == [] and engine.detector_loaded
    assert engine.release_idle(now=160.0) == ["detector"]
    assert not engine.detector_loaded and engine.loaded


def test_whole_engine_unloads_after_its_idle_time(engine):
    engine.idle_s, engine.detector_idle_s = 300.0, None
    engine._used = {"engine": 0.0, "detector": 0.0}
    assert engine.release_idle(now=299.0) == [] and engine.loaded
    assert "engine" in engine.release_idle(now=300.0)
    assert not engine.loaded and not engine.detector_loaded


def test_never_unloads_while_busy_or_when_kept(engine):
    engine.idle_s = engine.detector_idle_s = 0.0
    engine._busy = 1
    assert engine.release_idle(now=1e9) == [] and engine.loaded and engine.detector_loaded
    engine._busy = 0
    engine.idle_s = engine.detector_idle_s = None  # "never"
    assert engine.release_idle(now=1e9) == [] and engine.loaded and engine.detector_loaded
    assert engine._timer is None


def test_using_marks_busy_then_arms_the_timer(engine):
    engine.idle_s, engine.detector_idle_s = 600.0, 60.0
    with engine._using("detector"):
        assert engine._busy == 1 and engine._timer is None
    assert engine._busy == 0 and engine._used["detector"] > 0
    assert engine._timer is not None and 55 < engine._timer.interval <= 60  # the detector's comes first
    assert engine.loaded and engine.detector_loaded


def test_a_failed_job_still_releases(engine):
    engine.idle_s = engine.detector_idle_s = 0.0
    with pytest.raises(RuntimeError):
        with engine._using("engine"):
            raise RuntimeError("boom")
    assert engine._busy == 0 and not engine.loaded


def test_unload_refuses_while_in_use(engine):
    engine._busy = 1
    with pytest.raises(RuntimeError, match="in use"):
        engine.unload()
    engine._busy = 0
    engine.unload()
    assert not engine.loaded and not engine.detector_loaded


def test_engine_reads_its_idle_switches(monkeypatch):
    monkeypatch.setenv("SAM_UI_SAM3_IDLE_S", "900")
    monkeypatch.setenv("SAM_UI_SAM3_DETECTOR_IDLE_S", "never")
    e = Sam3Engine(device="cpu")
    assert e.idle_s == 900.0 and e.detector_idle_s is None


def test_engines_route_reports_an_unloaded_engine_as_not_loaded(tmp_path):
    from test_api import Harness
    from tracks.service import EngineSpec

    h = Harness(tmp_path)

    class Unloadable:
        name, model, loaded = "u", "u-1", True

    u = Unloadable()
    h.service._specs["u"] = EngineSpec("u", "u-1", lambda: u)
    h.service.get_engine("u")
    assert next(e for e in h.client.get("/engines").json["engines"] if e["name"] == "u")["loaded"]
    u.loaded = False
    assert not next(e for e in h.client.get("/engines").json["engines"] if e["name"] == "u")["loaded"]


def test_engine_idle_defaults(monkeypatch):
    """Unset, the detector goes after 5 idle minutes and the engine after 10."""
    monkeypatch.delenv("SAM_UI_SAM3_IDLE_S", raising=False)
    monkeypatch.delenv("SAM_UI_SAM3_DETECTOR_IDLE_S", raising=False)
    e = Sam3Engine(device="cpu")
    assert (e.idle_s, e.detector_idle_s) == (600.0, 300.0)


def test_clear_lru_caches_empties_transformers_style_caches(monkeypatch):
    """transformers' compile_compatible_method_lru_cache hides the lru_cache
    in a wrapper's closure, on static and plain methods alike."""
    import sys
    import types

    from transformers.pytorch_utils import compile_compatible_method_lru_cache

    mod = types.ModuleType("fake_sam3_mod")
    calls = []

    class Emb:
        @staticmethod
        @compile_compatible_method_lru_cache(maxsize=1)
        def build(n):
            calls.append(("build", n))
            return [n]

        @compile_compatible_method_lru_cache(maxsize=1)
        def coords(self, n):
            calls.append(("coords", n))
            return [n]

    Emb.__module__ = mod.__name__
    mod.Emb = Emb
    monkeypatch.setitem(sys.modules, mod.__name__, mod)
    e = Emb()
    Emb.build(3), Emb.build(3), e.coords(2), e.coords(2)
    assert len(calls) == 2  # cached
    assert memory.clear_lru_caches((mod.__name__, "not_imported_module")) == 2
    Emb.build(3), e.coords(2)
    assert len(calls) == 4  # computed again


def test_real_transformers_sam3_caches_are_found():
    pytest.importorskip("transformers.models.sam3.modeling_sam3")
    import transformers.models.sam3.modeling_sam3  # noqa: F401
    import transformers.models.sam3_tracker_video.modeling_sam3_tracker_video  # noqa: F401

    assert memory.clear_lru_caches() >= 3  # sine embeddings (x2) and the decoder's coordinates


def test_sam3_runs_without_sam2s_autocast(engine, monkeypatch):
    """The routes run every job and text prompt inside SAM 2's autocast
    (SAM_UI_SAM2_DTYPE): SAM 3 must not compute under it."""
    import torch

    with torch.autocast("cpu", dtype=torch.bfloat16):
        assert torch.is_autocast_enabled("cpu")
        with engine._using("engine"):
            assert not torch.is_autocast_enabled("cpu")
            assert torch.ones(2, 2).matmul(torch.ones(2, 2)).dtype == torch.float32
        assert torch.is_autocast_enabled("cpu")  # SAM 2's, back after the job


@pytest.mark.skipif(not __import__("torch").backends.mps.is_available(), reason="MPS only")
def test_sam3_on_mps_ignores_sam2_dtype(monkeypatch):
    import torch

    monkeypatch.setattr(memory, "release_cached", lambda: None)
    monkeypatch.setenv("SAM_UI_SAM2_DTYPE", "fp16")
    e = Sam3Engine(device="mps")
    with precision.sam2_autocast("mps"):
        assert torch.is_autocast_enabled("mps")
        with e._using("detector"):
            assert not torch.is_autocast_enabled("mps")
    if e._timer is not None:
        e._timer.cancel()
