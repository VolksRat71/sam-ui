# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Temporal text discovery (draft 4, tracks/discovery.py): a phrase is looked
for across the clip with the detector alone, and each appearance is written as
a candidate range. An object that leaves and comes back is two candidates:
nothing tracks across the gap, and nothing becomes a seed."""
import os
import threading
from pathlib import Path

import pytest

from test_api import Harness
from tracks import discovery as disc
from tracks.engine import FakeEngine
from tracks.ranges import CANDIDATE
from tracks.service import EngineSpec
from tracks.text import TextMatch

GALLERY = Path(__file__).resolve().parents[2] / "data" / "gallery"


def present_on(*spans):
    """A truth: the frames where the object is, as inclusive spans."""
    return lambda f: any(a <= f <= b for a, b in spans)


def run(n, truth, stride=12, tol=2, score=lambda f: 0.9):
    calls = []

    def detect(f):
        calls.append(f)
        return disc.Probe(truth(f), score(f) if truth(f) else 0.1, [0, 0, 1, 1] if truth(f) else None)

    found, n_calls = disc.drive(disc.scan(n, stride, tol), detect)
    assert n_calls == len(calls) and len(set(calls)) == len(calls)  # no frame probed twice
    return found, calls


# -- the pure parts --------------------------------------------------------------

def test_samples_are_every_stride_and_the_last_frame():
    assert disc.sample_frames(25, 12) == [0, 12, 24]
    assert disc.sample_frames(30, 12) == [0, 12, 24, 29]
    assert disc.sample_frames(1, 12) == [0]
    assert disc.sample_frames(0, 12) == []


def test_grouping_allows_one_missed_sample_and_no_more():
    T, F = True, False
    assert disc.group([T, T, F, T, T]) == [(0, 4)]  # one blink: the same appearance
    assert disc.group([T, T, F, F, T, T]) == [(0, 1), (4, 5)]  # two misses: it left
    assert disc.group([F, T, F, F, F, T, F]) == [(1, 1), (5, 5)]
    assert disc.group([F, F]) == [] and disc.group([]) == []
    assert disc.group([T, F, F, T], gap=2) == [(0, 3)]


def bisected(miss, hit, truth):
    """bisect() with a probe that answers at once: (frames probed in order, result)."""
    order = []

    def probe(f):
        order.append(f)
        return disc.Probe(truth(f), 0.9)
        yield  # a generator, as scan's probe is

    with pytest.raises(StopIteration) as stop:
        next(disc.bisect(miss, hit, probe, tol=2))
    return order, stop.value.value


def test_bisection_halves_towards_the_boundary_in_order():
    # entry: miss at 12, hit at 24, the object arrives at frame 17
    assert bisected(12, 24, lambda f: f >= 17) == ([18, 15, 16], 18)  # the hit side, one frame late at most
    # exit: hit at 24, miss at 36, the object's last frame is 29
    order, got = bisected(36, 24, lambda f: f <= 29)
    assert order == [30, 27, 28] and 28 <= got <= 29


# -- the plan, against a detector that knows the truth --------------------------

def test_an_object_that_leaves_and_comes_back_is_two_appearances():
    found, calls = run(240, present_on((30, 80), (150, 200)))
    assert len(found) == 2
    for a, (s, e) in zip(found, [(30, 80), (150, 200)]):
        assert s <= a["start"] <= s + 1 and e - 1 <= a["end"] <= e  # within 2 frames, never outside
        assert a["score"] == 0.9 and s <= a["best"]["frame"] <= e
    # sparse: 21 samples, and a few probes per edge
    assert len(calls) <= 21 + 4 * 4


@pytest.mark.parametrize("truth", [(5, 6), (13, 40), (0, 239), (100, 239), (0, 11), (225, 238)])
def test_boundaries_land_within_two_frames(truth):
    found, _ = run(240, present_on(truth), stride=12)
    if truth == (5, 6):  # shorter than the stride, between samples: not seen (documented)
        assert found == []
        return
    assert len(found) == 1
    a = found[0]
    assert abs(a["start"] - truth[0]) <= 2 and abs(a["end"] - truth[1]) <= 2
    assert truth[0] <= a["start"] and a["end"] <= truth[1]  # the hit side: inside the truth


def test_an_empty_clip_a_one_frame_clip_and_the_last_frame_alone():
    assert run(0, present_on((0, 0))) == ([], [])
    found, calls = run(1, present_on((0, 0)))
    assert calls == [0] and [(a["start"], a["end"]) for a in found] == [(0, 0)]
    assert run(1, present_on())[0] == []
    found, calls = run(30, present_on((29, 29)))  # only the tail sample sees it
    assert [(a["start"], a["end"]) for a in found] == [(29, 29)] and max(calls) == 29


@pytest.mark.parametrize("stride", [1, 2, 3, 5, 12, 13, 60])
def test_every_single_span_of_short_clips(stride):
    """Every span [s, e] of every clip of 0-49 frames: no probe outside the
    clip (run() also checks none twice), and what is found lies inside the
    truth and within a frame of each edge. A span of at least `stride`
    frames always holds a sample, so it is always found."""
    for n in range(50):
        for s in range(n):
            for e in range(s, n):
                found, calls = run(n, present_on((s, e)), stride=stride)
                assert all(0 <= f < n for f in calls)
                assert len(found) <= 1, (n, s, e)
                if e - s + 1 >= stride:
                    assert len(found) == 1, (n, s, e)
                for a in found:
                    assert s <= a["start"] <= s + 1 and e - 1 <= a["end"] <= e, (n, s, e, a)


def test_one_missed_sample_does_not_split_an_appearance():
    truth = present_on((10, 200))
    found, _ = run(240, lambda f: truth(f) and f != 96)  # the detector blinks on sample 96
    assert len(found) == 1 and abs(found[0]["start"] - 10) <= 2 and abs(found[0]["end"] - 200) <= 2


def test_the_score_is_the_mean_of_the_appearance_hits():
    found, _ = run(48, present_on((0, 47)), stride=12, score=lambda f: 0.6 if f < 24 else 1.0)
    assert len(found) == 1 and found[0]["hits"] == 5
    assert found[0]["score"] == pytest.approx((0.6 * 2 + 1.0 * 3) / 5)
    assert found[0]["best"]["frame"] >= 24


def test_cancel_stops_between_calls():
    calls = []

    def detect(f):
        calls.append(f)
        return disc.Probe(True, 0.9)

    with pytest.raises(disc.Canceled):
        disc.drive(disc.scan(240, 12), detect, canceled=lambda: len(calls) >= 3)
    assert len(calls) == 3


def test_each_call_runs_inside_its_own_step():
    depth, seen = [0], []

    class Step:
        def __enter__(self):
            depth[0] += 1

        def __exit__(self, *a):
            depth[0] -= 1

    def detect(f):
        seen.append(depth[0])
        return disc.Probe(f > 50, 0.8)

    _, n = disc.drive(disc.scan(120, 12), detect, step=Step)
    assert seen == [1] * n and depth[0] == 0  # held per call, let go between


def test_the_source_names_prompt_and_engine_and_fits():
    assert disc.source("dog", "sam3") == "text:dog@sam3"
    assert len(disc.source("x" * 200, "sam3")) == 128


# -- the service and the route, with a fake detector ---------------------------

class Detector(FakeEngine):
    """FakeEngine that reads text: "dog" is on the frames in `spans`."""

    name, model = "fake3", "fake3-1"

    def __init__(self, spans, **kw):
        super().__init__(**kw)
        self.spans, self.prompts = spans, []
        self.by_text = {}  # other phrases' frames, when a test needs them
        self.gate = None

    def segment_text(self, video_path, frame, text):
        if self.gate is not None:
            self.gate(frame)
        self.prompts.append(frame)
        spans = self.by_text.get(text, self.spans if text == "dog" else [])
        if any(a <= frame <= b for a, b in spans):
            return TextMatch(mask=None, score=0.8, instances=1, box=[1, 2, 3, 4])
        return TextMatch(mask=None, score=0.05, instances=0, box=None)


@pytest.fixture
def h(tmp_path):
    h = Harness(tmp_path)
    h.det = Detector([(20, 60), (130, 170)], n_frames=200)
    h.service._specs["fake3"] = EngineSpec("fake3", "fake3-1", lambda: h.det, text=lambda: None)
    return h


def discover(h, obj=1, text="dog", **kw):
    return h.client.post("/discover_text", json={"session_id": "s", "object_id": obj, "text": text, **kw})


def test_discovery_writes_two_candidates_and_no_seed(h):
    h.click(1, frame=0)
    before = (h.service.seeds.seeds(h.video, 1), h.service.seeds.hash(h.video, 1), h.state(1))
    r = discover(h)
    assert r.status_code == 200, r.json
    d = r.json
    assert d["engine"] == "fake3" and d["source"] == "text:dog@fake3" and d["n_frames"] == 200
    assert d["calls"] == len(h.det.prompts) and d["calls"] < 200 / 3
    spans = [(i["start"], i["end"]) for i in d["intervals"]]
    assert len(spans) == 2
    for (s, e), (ts, te) in zip(spans, [(20, 60), (130, 170)]):
        assert abs(s - ts) <= 2 and abs(e - te) <= 2
    cands = [r for r in h.service.seeds.annotations(h.video, 1) if r["state"] == CANDIDATE]
    assert [(c["start"], c["end"], c["source"], c["score"]) for c in cands] == \
        [(s, e, "text:dog@fake3", 0.8) for s, e in spans]
    # nothing else moved: the seeds, their hash and the track state
    assert (h.service.seeds.seeds(h.video, 1), h.service.seeds.hash(h.video, 1), h.state(1)) == before
    assert h.det.calls == []  # and nothing was tracked
    assert h.service.jobs.running() == []


def test_a_rerun_replaces_its_own_source_and_keeps_others(h):
    h.service.write_candidates(h.video, 1, [{"start": 180, "end": 190, "source": "clicks@sam2", "score": 0.3}])
    discover(h)
    h.det.spans = [(20, 60)]
    d = discover(h).json
    assert len(d["intervals"]) == 1
    got = sorted((c["source"], c["start"]) for c in h.service.seeds.annotations(h.video, 1))
    assert [g[0] for g in got] == ["clicks@sam2", "text:dog@fake3"]


def test_a_later_scan_paints_over_other_sources_where_they_overlap(h):
    """Candidates are one layer (#39): where two phrases' appearances overlap,
    the later scan wins; a re-run replaces only its own source's."""
    h.det.by_text = {"dog": [(30, 80)], "brown dog": [(25, 85)]}

    def cands():
        return [(c["source"], c["start"], c["end"]) for c in h.service.seeds.annotations(h.video, 1)]

    discover(h)
    discover(h, text="brown dog")
    assert [c[0] for c in cands()] == ["text:brown dog@fake3"]  # it covered dog's, so dog's is gone
    discover(h)
    got = cands()
    assert [c[0] for c in got] == ["text:brown dog@fake3", "text:dog@fake3", "text:brown dog@fake3"]
    assert got[0][2] + 1 == got[1][1] and got[1][2] + 1 == got[2][1]  # dog splits brown dog around itself


def test_removing_the_object_mid_scan_writes_nothing_back(h):
    h.click(1)
    h.click(2)

    def gate(frame):
        if len(h.det.prompts) == 3:
            h.service.remove_object(h.video, 1)

    h.det.gate = gate
    d = discover(h).json
    assert d["canceled"] is True and d["intervals"] == []
    assert h.service.seeds.objects(h.video) == [2]  # not brought back by its candidates
    assert h.service.jobs.running() == []


def test_clearing_the_video_mid_scan_writes_nothing_back(h):
    h.click(1)

    def gate(frame):
        if len(h.det.prompts) == 3:
            h.service.clear_video(h.video)

    h.det.gate = gate
    assert discover(h).json["canceled"] is True
    assert h.service.seeds.objects(h.video) == []


def test_a_cancel_during_the_last_call_writes_nothing(h):
    full = h.service.discover_text(h.video, str(h.video_path), 1, "dog", engine="fake3")
    h.det.prompts = []
    with pytest.raises(disc.Canceled):  # drive checks before each call; the write checks once more
        h.service.discover_text(h.video, str(h.video_path), 2, "dog", engine="fake3",
                                canceled=lambda: len(h.det.prompts) >= full["calls"])
    assert len(h.det.prompts) == full["calls"] and h.service.seeds.annotations(h.video, 2) == []


def test_frames_done_counts_detector_calls(h):
    seen = []
    h.det.gate = lambda frame: seen.append(h.service.jobs.running()[0]["frames_done"])
    d = discover(h).json
    assert seen == list(range(d["calls"]))  # no count for the frame count or the write


def test_discovery_needs_text_a_stride_and_a_text_engine(h):
    assert discover(h, text="  ").status_code == 400
    assert discover(h, stride=0).status_code == 400
    assert discover(h, stride="12").status_code == 400
    assert discover(h, engine="fake").status_code == 400  # clicks only
    assert h.det.prompts == []


def test_a_phrase_nowhere_writes_nothing(h):
    d = discover(h, text="giraffe").json
    assert d["intervals"] == [] and d["calls"] == len(disc.sample_frames(200, 12))
    assert h.service.seeds.annotations(h.video, 1) == []


def test_canceling_a_discovery_writes_nothing(h):
    started, go = threading.Event(), threading.Event()

    def gate(frame):
        if len(h.det.prompts) == 2:
            started.set()
            go.wait(5)

    h.det.gate = gate
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("r", discover(h)))
    t.start()
    assert started.wait(5)
    jobs = h.service.jobs.running(h.video)
    assert len(jobs) == 1 and jobs[0]["kind"] == "discover" and jobs[0]["objects"] == []
    assert h.client.post("/cancel_track", json={"session_id": "s", "job_id": jobs[0]["job_id"]}).json["canceled"]
    go.set()
    t.join(5)
    assert out["r"].json["canceled"] is True and out["r"].json["intervals"] == []
    assert len(h.det.prompts) == 3  # the call in flight finishes; no more start
    assert h.service.seeds.annotations(h.video, 1) == []
    assert h.service.jobs.running() == []


def test_a_click_gets_the_lock_while_discovery_runs(h):
    """The model lock is taken per detector call: between two, another user
    of the lock (a click) gets in."""
    got_in, inside, at = threading.Event(), [], []

    def click():
        with h.lock:
            at.append(len(h.det.prompts))
            got_in.set()

    def gate(frame):
        inside.append(h.lock.locked())
        if len(h.det.prompts) == 3:
            threading.Thread(target=click).start()

    h.det.gate = gate
    d = discover(h).json
    assert all(inside) and got_in.wait(5)
    assert at[0] < d["calls"]  # it got in while the scan still had calls to make


def test_the_scan_shares_the_prompt_path_and_its_idle_unload(monkeypatch):
    """A scan's calls are prompts (issue #11): each loads the detector onto
    the tracker's backbone when it is not there, and the idle unload may drop
    it between calls; the scan loads it again and still answers. segment_text
    is the same path with a mask. No model loads here (stand-ins)."""
    from types import SimpleNamespace

    import torch
    import transformers

    from tracks import memory, sam3_engine

    monkeypatch.setattr(memory, "release_cached", lambda: None)
    monkeypatch.setattr(memory, "clear_lru_caches", lambda *a: 0)
    backbones = []

    def det(pixel_values, input_ids, attention_mask):
        hit = float(pixel_values.mean()) > 0  # frames 5+ hold the phrase
        return SimpleNamespace(pred_logits=torch.tensor([[4.0 if hit else -4.0, -4.0]]), presence_logits=None,
                               pred_boxes=torch.tensor([[[0.0, 0.0, 0.5, 0.5], [0, 0, 1, 1]]]),
                               pred_masks=torch.ones(1, 2, 2, 2))

    def tok(text, **kw):
        ids = SimpleNamespace(input_ids=None, attention_mask=None)
        return SimpleNamespace(to=lambda dev: ids)

    class Frames:
        height, width = 8, 6

        def __init__(self, *a, **kw):
            pass

        def __len__(self):
            return 10

        def __getitem__(self, i):
            return torch.full((3, 4, 4), 1.0 if i >= 5 else -1.0)

    monkeypatch.setattr(sam3_engine, "shared_detector", lambda bb, dev, dtype: backbones.append(bb) or det)
    monkeypatch.setattr(transformers.AutoTokenizer, "from_pretrained", lambda *a, **kw: tok)
    monkeypatch.setattr(sam3_engine, "Sam3Frames", Frames)
    e = sam3_engine.Sam3Engine(device="cpu")
    e._loaded = ("proc", SimpleNamespace(vision_encoder=SimpleNamespace(backbone="tracker-backbone")), "cpu")
    e.idle_s, e.detector_idle_s = None, 0.0  # the detector unloads the moment a call ends
    try:
        scan = e.text_scanner("clip.mp4", "dog")
        assert [scan(f).instances for f in (0, 6)] == [0, 1]
        assert backbones == ["tracker-backbone"] * 2  # loaded again after the idle unload, on the shared backbone
        assert not e.detector_loaded and e.loaded and e._busy == 0
        m = e.segment_text("clip.mp4", 7, "dog")
        assert m.mask.shape == (8, 6) and m.box == [0.0, 0.0, 3.0, 4.0] and scan(7).mask is None
    finally:
        if e._timer is not None:
            e._timer.cancel()


# -- the real model --------------------------------------------------------------

@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("SAM_UI_SLOW") != "1", reason="set SAM_UI_SLOW=1 (and have the SAM 3 weights)")
def test_real_sam3_discovers_a_dog_that_leaves_and_comes_back():
    """SAM_UI_DISCOVERY_CLIP: a clip where the dog is on frames
    SAM_UI_DISCOVERY_TRUTH ("a-b,c-d") and gone in between (built from the
    gallery's dog clip with a gap, never committed)."""
    import time

    from tracks import sam3_engine

    why = sam3_engine.available() or sam3_engine.text_available()
    if why:
        pytest.skip(why)
    clip = os.environ.get("SAM_UI_DISCOVERY_CLIP")
    truth = os.environ.get("SAM_UI_DISCOVERY_TRUTH")
    if not clip or not truth:
        pytest.skip("set SAM_UI_DISCOVERY_CLIP and SAM_UI_DISCOVERY_TRUTH")
    spans = [tuple(int(v) for v in s.split("-")) for s in truth.split(",")]
    stride = int(os.environ.get("SAM_UI_DISCOVERY_STRIDE", "12"))
    e = sam3_engine.Sam3Engine()
    scan = e.text_scanner(clip, "dog")
    t0 = time.perf_counter()
    n = len(scan)
    t_load = time.perf_counter() - t0
    log = []

    def detect(f):
        m = scan(f)
        log.append((f, round(m.score, 3)))
        return disc.Probe(m.instances > 0, m.score, m.box)

    t0 = time.perf_counter()
    found, calls = disc.drive(disc.scan(n, stride), detect)
    secs = time.perf_counter() - t0
    print(f"\ndiscovery 'dog' on {Path(clip).name} ({n} frames, stride {stride}): truth {spans}, found "
          f"{[(a['start'], a['end'], a['score']) for a in found]}, {calls} detector calls in {secs:.1f} s "
          f"({secs / max(1, calls):.2f} s/call; load {t_load:.1f} s)\nprobes {log}")
    assert len(found) == len(spans)
    for a, (s, e_) in zip(found, spans):
        assert abs(a["start"] - s) <= 3 and abs(a["end"] - e_) <= 3
