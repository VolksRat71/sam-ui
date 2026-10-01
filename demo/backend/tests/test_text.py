# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Text prompts (issue #22): an object's seed on one frame can come from a
phrase ("dog") instead of clicks. An engine that can read text (SAM 3's
detector) turns it into that frame's approved mask, which every engine then
tracks like any seed mask. Engines without text report so, and are refused."""
import os
from pathlib import Path

import numpy as np
import pytest

from test_api import Harness
from tracks import rle
from tracks.engine import FakeEngine, plan_units
from tracks.ranges import ABSENT, seeded_windows
from tracks.seeds import SeedStore, seeds_hash
from tracks.service import EngineSpec
from tracks.store import STALE, TRACKED
from tracks.text import TextMatch, has_prompt, normalize, pick

V = "v" * 64
MASK = np.zeros((24, 32), bool)
MASK[4:10, 6:14] = True


class TextFake(FakeEngine):
    """FakeEngine that also reads text: "thing" matches MASK (twice, best
    first), anything else matches nothing."""

    name, model = "fake3", "fake3-1"

    def __init__(self, **kw):
        super().__init__(**kw)
        self.prompts = []

    def segment_text(self, video_path, frame, text):
        self.prompts.append((frame, text))
        if text == "thing":
            return TextMatch(mask=MASK, score=0.91, instances=2, box=[6, 4, 13, 9])
        return TextMatch(mask=None, score=0.02, instances=0, box=None)


@pytest.fixture
def h(tmp_path):
    h = Harness(tmp_path)
    h.built = []

    def factory():
        e = TextFake(n_frames=4)
        h.built.append(e)
        return e

    h.service._specs["fake3"] = EngineSpec("fake3", "fake3-1", factory, text=lambda: None)
    return h


def prompt(h, obj=1, frame=0, text="thing", **kw):
    return h.client.post("/text_prompt", json={"session_id": "s", "object_id": obj, "frame_index": frame,
                                              "text": text, **kw})


# -- the prompt text -------------------------------------------------------------

def test_text_is_trimmed_collapsed_capped_and_never_empty():
    assert normalize("  a   brown\ndog ") == "a brown dog"
    assert len(normalize("x" * 500)) == 200
    for bad in ("", "   ", None, 3):
        with pytest.raises(ValueError):
            normalize(bad)


def test_pick_takes_the_best_instance_above_the_threshold():
    assert pick([0.2, 0.9, 0.7, 0.4], 0.5) == (1, 2, 0.9)  # index, how many matched, best score
    assert pick([0.2, 0.3], 0.5) == (None, 0, 0.3)
    assert pick([], 0.5) == (None, 0, 0.0)


def test_a_text_seed_counts_as_a_seed_without_clicks():
    assert has_prompt({"points": [[0.5, 0.5]], "labels": [1]})
    assert has_prompt({"points": [], "labels": [], "text": "dog", "mask": {"size": [1, 1], "counts": "1"}})
    assert not has_prompt({"points": [], "labels": []})


# -- the seeds hash --------------------------------------------------------------

# The same seeds and literal hash test_ranges.py pins (b41c29e, before ranges
# and text): an object with no text prompt keeps it exactly.
OLD_SEEDS = {3: {"points": [[0.1, 0.2]], "labels": [1], "mask": {"size": [2, 2], "counts": "04"}},
             7: {"points": [[0.5, 0.5]], "labels": [0]}}
OLD_HASH = "42a2023001e5c84c302cded36ed2a73ad741d0adeb17c12026b91aeb098a093d"


def test_an_object_without_text_keeps_its_old_seeds_hash():
    assert seeds_hash(OLD_SEEDS) == OLD_HASH
    assert seeds_hash({**OLD_SEEDS, 9: {"points": [], "labels": []}}) == OLD_HASH  # an empty frame is no seed


def test_text_joins_the_seeds_hash():
    m = {"size": [2, 2], "counts": "04"}
    base = seeds_hash(OLD_SEEDS)
    only_text = {**OLD_SEEDS, 9: {"points": [], "labels": [], "text": "dog", "mask": m}}
    assert seeds_hash(only_text) != base  # a text-only frame is a seed
    assert seeds_hash(only_text) != seeds_hash({**only_text, 9: {**only_text[9], "text": "cat"}})
    with_text = {**OLD_SEEDS, 3: {**OLD_SEEDS[3], "text": "dog"}}
    assert seeds_hash(with_text) != base


# -- the seed store ----------------------------------------------------------------

def test_a_text_seed_is_stored_with_its_mask_and_no_clicks(tmp_path):
    s = SeedStore(str(tmp_path))
    m = rle.encode(MASK)
    s.add_points(V, 1, 2, [[0.1, 0.1]], [1], True)
    s.set_text(V, 1, 2, "  brown dog ", m)
    got = s.seeds(V, 1)[2]
    assert got == {"points": [], "labels": [], "text": "brown dog", "mask": {"size": m["size"], "counts": m["counts"]}}
    assert s.objects(V) == [1] and s.hash(V, 1) is not None  # kept on disk, not dropped as clickless


def test_clicks_on_a_text_frame_refine_it_and_keep_the_text(tmp_path):
    s = SeedStore(str(tmp_path))
    s.set_text(V, 1, 2, "dog", rle.encode(MASK))
    refined = rle.encode(np.roll(MASK, 1, axis=0))
    s.add_points(V, 1, 2, [[0.2, 0.2]], [0], True, mask=refined)  # studio replaces the frame's clicks
    got = s.seeds(V, 1)[2]
    assert got["text"] == "dog" and got["points"] == [[0.2, 0.2]] and got["mask"]["counts"] == refined["counts"]
    s.clear_frame(V, 1, 2)  # clearing the frame clears its text too
    assert s.seeds(V, 1) == {}


def test_windows_and_units_start_from_a_text_only_seed():
    m = {"size": [2, 2], "counts": "04"}
    seeds = {5: {"points": [], "labels": [], "text": "dog", "mask": m}, 20: {"points": [[0.5, 0.5]], "labels": [1]}}
    assert [sorted(mine) for _, mine in seeded_windows(seeds, [{"start": 10, "end": 12, "state": ABSENT}])] == [[5], [20]]
    units = plan_units({1: seeds})
    assert [u.start for u in units] == [5] and sorted(units[0].objects[1]) == [5, 20]


# -- capability reporting ------------------------------------------------------------

def test_engines_report_which_read_text(h):
    h.service._specs["gpu_only"] = EngineSpec("gpu_only", "x", lambda: None, unavailable=lambda: "needs CUDA",
                                              text=lambda: None)
    h.service._specs["no_detector"] = EngineSpec("no_detector", "y", lambda: TextFake(),
                                                 text=lambda: "these weights have no detector")
    by = {e["name"]: e for e in h.client.get("/engines").json["engines"]}
    assert by["fake"]["text"] is False and "clicks only" in by["fake"]["text_reason"]  # the default, SAM 2's role
    assert by["fake3"]["text"] is True and by["fake3"]["text_reason"] is None
    assert by["gpu_only"]["text"] is False and by["gpu_only"]["text_reason"] == "needs CUDA"
    assert by["no_detector"]["text"] is False and by["no_detector"]["text_reason"] == "these weights have no detector"
    assert h.built == []  # reporting never builds an engine


def test_sam3_reports_text_only_with_a_detector_in_its_weights(tmp_path, monkeypatch):
    import importlib.util
    import sys
    from tracks import sam3_engine

    monkeypatch.setenv("SAM_UI_SAM3_WEIGHTS", str(tmp_path))
    before = "transformers" in sys.modules
    (tmp_path / "model.safetensors").write_bytes(b"")
    fake = tmp_path / "tf" / "transformers"
    (fake / "models" / "sam3_tracker_video").mkdir(parents=True)
    (fake / "__init__.py").write_text("")

    class Spec:
        origin = str(fake / "__init__.py")

    monkeypatch.setattr(importlib.util, "find_spec", lambda name: Spec())
    assert sam3_engine.available() is None
    assert "Sam3Model" in sam3_engine.text_available()  # transformers without the detector
    (fake / "models" / "sam3").mkdir()
    (tmp_path / "config.json").write_text('{"architectures": ["Sam3TrackerVideoModel"]}')
    assert "detector" in sam3_engine.text_available()  # tracker-only weights
    (tmp_path / "config.json").write_text('{"architectures": ["Sam3VideoModel"], "detector_config": {}}')
    assert sam3_engine.text_available() is None
    assert ("transformers" in sys.modules) == before  # located, never imported


# -- the prompt ------------------------------------------------------------------------

def test_a_text_prompt_becomes_the_frames_approved_seed(h):
    r = prompt(h, frame=2)
    assert r.status_code == 200
    b = r.json
    assert (b["object_id"], b["frame_index"], b["text"], b["engine"]) == (1, 2, "thing", "fake3")
    assert b["matched"] and b["score"] == 0.91 and b["instances"] == 2 and b["box"] == [6, 4, 13, 9]
    assert (rle.decode(b["mask"]) == MASK).all()
    assert h.built[0].prompts == [(2, "thing")]
    seed = h.service.seeds.seeds(h.video, 1)[2]
    assert seed["text"] == "thing" and seed["points"] == [] and (rle.decode(seed["mask"]) == MASK).all()


def test_the_text_engine_is_the_default_for_a_prompt_and_the_seed_tracks_on_any_engine(h):
    prompt(h)
    # SAM 2 (the default engine here) tracks the text seed's mask like any seed
    ids, frames = h.track()
    assert ids == "1" and h.engine.calls == [[1]] and h.state(1) == TRACKED
    prompt(h, text="thing", frame=1)
    assert h.state(1) == STALE  # a new text seed changes the hash


def test_a_prompt_that_matches_nothing_stores_nothing(h):
    h.click(1, frame=0)
    before = h.service.seeds.hash(h.video, 1)
    b = prompt(h, text="unicorn").json
    assert b["matched"] is False and b["mask"] is None and b["instances"] == 0 and b["score"] == 0.02
    assert h.service.seeds.hash(h.video, 1) == before


def test_engines_without_text_are_refused_with_why(h):
    r = prompt(h, engine="fake")
    assert r.status_code == 400 and "clicks only" in r.json["error"]
    h.service._specs = {}  # no engine reads text here
    r = prompt(h)
    assert r.status_code == 400 and "no engine here reads text" in r.json["error"]
    assert h.service.seeds.seeds(h.video, 1) == {}


def test_a_prompt_inside_an_absent_range_or_without_text_is_refused(h):
    h.service.set_range(h.video, 1, 0, 1, ABSENT)
    r = prompt(h, frame=1)
    assert r.status_code == 400 and "absent" in r.json["error"]
    r = prompt(h, frame=2, text="   ")
    assert r.status_code == 400 and "text" in r.json["error"]
    assert h.built == [] or h.built[0].prompts == []  # the model never ran


def test_the_session_hears_of_the_new_seed_mask(tmp_path):
    """The interactive session (SAM 2's state) gets the mask too, so a click
    on that frame refines it."""
    from flask import Flask
    from tracks.routes import TrackContext, make_blueprint

    h = Harness(tmp_path)
    h.service._specs["fake3"] = EngineSpec("fake3", "fake3-1", TextFake, text=lambda: None)
    heard = []
    app = Flask(__name__)
    app.register_blueprint(make_blueprint(lambda sid: TrackContext(
        h.service, h.video, str(h.video_path), session_id=sid, lock=h.lock,
        seed_mask=lambda o, f, m: heard.append((o, f, m.sum()))), h.service))
    app.test_client().post("/text_prompt", json={"session_id": "s", "object_id": 4, "frame_index": 3, "text": "thing"})
    app.test_client().post("/text_prompt", json={"session_id": "s", "object_id": 4, "frame_index": 3, "text": "nope"})
    assert heard == [(4, 3, MASK.sum())]  # a miss changes nothing


def test_a_click_after_a_text_prompt_refines_its_mask_in_the_session(tmp_path):
    """Through the real InferenceAPI (a stub SAM 2): the prompt's mask goes into
    the session, a click there grows it, the seed keeps the text, and a
    restart replays the text seed like any other."""
    from flask import Flask
    from test_inference_api import H, W, StubPredictor, click, start
    from inference.predictor import InferenceAPI
    from tracks.routes import make_blueprint

    big = np.zeros((H, W), bool)
    big[2:6, 2:6] = True

    class Detector(TextFake):
        def segment_text(self, video_path, frame, text):
            return TextMatch(mask=big, score=0.9, instances=1, box=[2, 2, 5, 5])

    video = tmp_path / "clip.mp4"
    video.write_bytes(b"frames")
    stub = StubPredictor()

    def make():
        a = InferenceAPI(predictor=stub, tracks_root=str(tmp_path / "tracks"))
        a.tracks.engine = FakeEngine(n_frames=6, shape=(H, W))
        a.tracks._specs = {"fake3": EngineSpec("fake3", "fake3-1", Detector, text=lambda: None)}
        return a

    a = make()
    sid = start(a, str(video))
    app = Flask(__name__)
    app.register_blueprint(make_blueprint(a.track_context, a.tracks))
    r = app.test_client().post("/text_prompt", json={"session_id": sid, "object_id": 1, "frame_index": 2, "text": "box"})
    assert r.status_code == 200 and r.json["matched"] and (2, 1) in stub.mask_calls
    out = click(a, sid, 1, 2, [[0.8, 0.8]], [1])  # a positive outside the text mask adds to it
    assert out[1][big].all() and out[1].sum() > big.sum()
    seed = a.object_tracks(sid)[0]["seeds"][2]
    assert seed["text"] == "box" and seed["points"] == [[0.8, 0.8]]
    stub.mask_calls.clear()
    start(make(), str(video))  # a restart replays it
    assert stub.mask_calls == [(2, 1)]


def test_an_export_gives_a_text_frame_no_empty_anchor(h, tmp_path, monkeypatch):
    import json

    monkeypatch.setenv("SAM_UI_EXPORT_ROOT", str(tmp_path))
    prompt(h, obj=1, frame=0)
    h.click(1, frame=2, points=[[0.25, 0.5]])
    prompt(h, obj=2, frame=1)  # text only
    h.track()
    r = h.client.post("/export", json={"session_id": "s", "out_dir": str(tmp_path / "out")})
    assert r.status_code == 200 and set(r.json["products"]) == {"object_1", "object_2"}
    anchors = json.loads((tmp_path / "out" / "anchors.json").read_text())
    assert anchors == {"object_1": {"points": {"3": [[8, 12, 1]]}}}  # no [] for a text frame, no entry for 2


def test_graphql_seeds_carry_their_text():
    from test_schema import INFO, FakeAPI, run

    api = FakeAPI()
    api.object_tracks = lambda sid: [{**INFO, "seeds": {2: {"points": [], "labels": [], "text": "dog"},
                                                        4: {"points": [[0.1, 0.1]], "labels": [1]}}}]
    got = run('{ objectTracks(sessionId: "s1") { seeds { frameIndex text } } }', api)["objectTracks"][0]["seeds"]
    assert got == [{"frameIndex": 2, "text": "dog"}, {"frameIndex": 4, "text": None}]


# -- the real model -----------------------------------------------------------------------

GALLERY = Path(__file__).resolve().parents[2] / "data" / "gallery"
if not GALLERY.is_dir():  # a worktree without the gallery: the main checkout's
    GALLERY = Path(__file__).resolve().parents[6] / "demo" / "data" / "gallery"


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("SAM_UI_SLOW") != "1", reason="set SAM_UI_SLOW=1 (and have the SAM 3 weights)")
def test_real_sam3_text_prompt_finds_the_dog_and_tracks_it():
    import time

    import torch
    from tracks import sam3_engine

    why = sam3_engine.available() or sam3_engine.text_available()
    if why:
        pytest.skip(why)
    clip = GALLERY / "01_dog.mp4"
    if not clip.exists():
        pytest.skip(f"no gallery clip at {clip}")
    e = sam3_engine.Sam3Engine()
    mps = torch.backends.mps.is_available()
    peak = 0.0

    def mem():
        nonlocal peak
        if mps:
            peak = max(peak, torch.mps.driver_allocated_memory() / 2 ** 30)

    t0 = time.perf_counter()
    miss = e.segment_text(str(clip), 0, "giraffe")
    mem()
    t_first = time.perf_counter() - t0
    assert miss.mask is None and miss.instances == 0
    t0 = time.perf_counter()
    hit = e.segment_text(str(clip), 0, "dog")
    t_prompt = time.perf_counter() - t0
    mem()
    assert hit.mask is not None and hit.score > 0.8 and hit.instances >= 1
    h, w = hit.mask.shape
    ys, xs = np.nonzero(hit.mask)
    area = hit.mask.mean()
    bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    assert 0.005 < area < 0.2  # a dog, not the frame and not a speck
    # the mask sits inside the detector's own box
    bx0, by0, bx1, by1 = hit.box
    assert bx0 - 4 <= bbox[0] and by0 - 4 <= bbox[1] and bbox[2] <= bx1 + 4 and bbox[3] <= by1 + 4
    seeds = {0: {"points": [], "labels": [], "text": "dog", "mask": rle.encode(hit.mask)}}
    n = 30
    t0 = time.perf_counter()
    got = {}
    for f, m in e.track(str(clip), {1: seeds}, windows={1: [(0, n - 1)]}):
        got[f] = m[1]
        mem()
    t_track = time.perf_counter() - t0
    assert sorted(got) == list(range(n))
    ious = []
    for f in range(1, n):
        a, b = got[f - 1], got[f]
        ious.append(float((a & b).sum() / max(1, (a | b).sum())))
    areas = [float(got[f].mean()) for f in range(n)]
    # where the track ends, the detector finds the same dog
    ref = e.segment_text(str(clip), n - 1, "dog").mask
    end_iou = float((got[n - 1] & ref).sum() / max(1, (got[n - 1] | ref).sum()))
    print(f"\nsam3 text 'dog' on {clip.name} ({w}x{h}): score {hit.score:.3f}, {hit.instances} instance(s), "
          f"area {area:.4f} of the frame ({int(hit.mask.sum())} px), bbox {bbox}, box {[round(v) for v in hit.box]}; "
          f"first prompt (loads) {t_first:.1f} s, warm prompt {t_prompt:.2f} s; tracked {n} frames in "
          f"{t_track:.1f} s, frame-to-frame IoU min {min(ious):.3f}, IoU with a fresh 'dog' on frame {n - 1} "
          f"{end_iou:.3f}, area {min(areas):.4f}-{max(areas):.4f}; "
          f"peak MPS driver memory {peak:.1f} GB")
    assert min(ious) > 0.6 and min(areas) > 0.3 * area and end_iou > 0.7


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("SAM_UI_SLOW") != "1", reason="set SAM_UI_SLOW=1 (and have the SAM 3 weights)")
def test_real_sam3_text_detector_loaded_alone_is_from_pretrained_bit_for_bit():
    """shared_detector reads only the detector's own weights onto the device
    (issue #11). It must be the model Sam3Model.from_pretrained makes, with the
    tracker's backbone swapped in: the same weights, and the same outputs."""
    import torch
    from tracks import sam3_engine

    why = sam3_engine.available() or sam3_engine.text_available()
    if why:
        pytest.skip(why)
    if os.environ.get("SAM_UI_SAM3_DTYPE", "fp32") not in ("", "fp32"):
        pytest.skip("compares against fp32 from_pretrained")
    from transformers import Sam3Model

    clip = GALLERY / "01_dog.mp4"
    if not clip.exists():
        pytest.skip(f"no gallery clip at {clip}")
    e = sam3_engine.Sam3Engine()
    proc, model, dev = e._load()
    det, tok = e._load_detector()
    ref = Sam3Model.from_pretrained(str(sam3_engine.weights_path())).eval()
    ref.vision_encoder.backbone = model.vision_encoder.backbone
    ref = ref.to(dev)
    got, want = det.state_dict(), ref.state_dict()
    assert sorted(got) == sorted(want)
    for k in want:
        assert got[k].dtype == want[k].dtype and torch.equal(got[k], want[k]), k
    for name, b in ref.named_buffers():
        mine = dict(det.named_buffers())[name]
        assert mine.dtype == b.dtype and mine.device == b.device and torch.equal(mine, b), name
    frames = sam3_engine.Sam3Frames(str(clip), proc)
    ids = tok("dog", return_tensors="pt", padding="max_length", max_length=32, truncation=True).to(dev)
    with torch.inference_mode():
        a = det(pixel_values=frames[0][None].to(dev), input_ids=ids.input_ids, attention_mask=ids.attention_mask)
        b = ref(pixel_values=frames[0][None].to(dev), input_ids=ids.input_ids, attention_mask=ids.attention_mask)
    for k in ("pred_logits", "pred_masks", "pred_boxes", "presence_logits"):
        assert torch.equal(getattr(a, k), getattr(b, k)), k


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("SAM_UI_SLOW") != "1", reason="set SAM_UI_SLOW=1 (and have the SAM 3 weights)")
def test_real_sam3_text_detector_at_half_precision_has_from_pretrained_dtypes():
    """At bf16 (SAM_UI_SAM3_DTYPE) every detector tensor must have the dtype
    from_pretrained(dtype=bf16) gives it: MPS aborts the process on a matmul
    of mixed dtypes. On the CPU, so no GPU is needed."""
    import torch
    from tracks import sam3_engine

    why = sam3_engine.available() or sam3_engine.text_available()
    if why:
        pytest.skip(why)
    from transformers import Sam3Model, Sam3TrackerVideoModel

    path = str(sam3_engine.weights_path())
    tracker = Sam3TrackerVideoModel.from_pretrained(path, dtype=torch.bfloat16)
    det = sam3_engine.shared_detector(tracker.vision_encoder.backbone, "cpu", torch.bfloat16)
    ref = Sam3Model.from_pretrained(path, dtype=torch.bfloat16)
    ref.vision_encoder.backbone = tracker.vision_encoder.backbone
    got, want = det.state_dict(), ref.state_dict()
    assert sorted(got) == sorted(want)
    for k in want:
        assert got[k].dtype == want[k].dtype and torch.equal(got[k], want[k]), k
    mine = dict(det.named_buffers())
    for name, b in ref.named_buffers():
        assert mine[name].dtype == b.dtype and torch.equal(mine[name], b), name


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("SAM_UI_SLOW") != "1", reason="set SAM_UI_SLOW=1 (and have the SAM 3 weights)")
def test_real_sam3_text_and_track_ignore_sam2s_autocast(monkeypatch):
    """The routes wrap jobs and prompts in SAM 2's autocast. With
    SAM_UI_SAM2_DTYPE=fp16, SAM 3 must give exactly its own fp32 masks."""
    import torch
    from tracks import precision, sam3_engine

    why = sam3_engine.available() or sam3_engine.text_available()
    if why:
        pytest.skip(why)
    if not torch.backends.mps.is_available():
        pytest.skip("SAM_UI_SAM2_DTYPE is MPS autocast")
    clip = GALLERY / "01_dog.mp4"
    if not clip.exists():
        pytest.skip(f"no gallery clip at {clip}")
    monkeypatch.delenv("SAM_UI_SAM3_DTYPE", raising=False)
    monkeypatch.setenv("SAM_UI_SAM2_DTYPE", "fp16")
    e = sam3_engine.Sam3Engine()
    seeds = {1: {0: {"points": [[0.484, 0.611]], "labels": [1]}}}

    def run():
        hit = e.segment_text(str(clip), 0, "dog")
        return hit, dict(e.track(str(clip), seeds, windows={1: [(0, 7)]}))

    want_hit, want = run()
    with precision.sam2_autocast("mps"):
        got_hit, got = run()
    assert got_hit.score == want_hit.score and np.array_equal(got_hit.mask, want_hit.mask)
    assert sorted(got) == sorted(want) == list(range(8))
    for f in want:
        assert np.array_equal(got[f][1], want[f][1]), f
