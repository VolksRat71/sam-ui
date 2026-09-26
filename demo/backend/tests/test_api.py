# sam-ui (Apache-2.0). New file, not from SAM 2.
import json
import threading

import pytest
from flask import Flask

from tracks import rle
from tracks.engine import FakeEngine
from tracks.routes import TrackContext, make_blueprint
from tracks.service import TrackService
from tracks.store import STALE, TRACKED, UNTRACKED

P = [[0.5, 0.5]]


def parse_all(body: bytes):
    """The demo's multipart stream -> ([(frame_index, {object_id: mask})], closing part or None)."""
    out, closing, pos = [], None, 0
    while (h := body.find(b"Content-Length: ", pos)) != -1:
        n = int(body[h + 16:body.index(b"\r\n", h)])
        start = body.index(b"\r\n\r\n", h) + 4
        d = json.loads(body[start:start + n])
        if "done" in d:
            assert closing is None, "one closing part, at the end"
            assert d.pop("frame_index") == -1 and d.pop("results") == []  # safe for a frames-only parser
            assert d.pop("job_id").startswith("job-")
            closing = d
        else:
            assert closing is None, "no frames after the closing part"
            out.append((d["frame_index"], {r["object_id"]: rle.decode(r["mask"]) for r in d["results"]}))
        pos = start + n
    return out, closing


def parse(body: bytes):
    return parse_all(body)[0]


class Harness:
    def __init__(self, tmp_path, engine=None):
        self.video_path = tmp_path / "clip.mp4"
        self.video_path.write_bytes(b"not really a video")
        self.root = tmp_path / "tracks"
        self.engine = engine or FakeEngine(n_frames=4)
        self.new_service()

    def new_service(self):
        """A fresh service on the same disk: what a server restart does."""
        self.service = TrackService(str(self.root), self.engine)
        self.video = self.service.video_key(str(self.video_path))
        app = Flask(__name__)
        self.lock = threading.Lock()  # one model lock, as in production
        app.register_blueprint(make_blueprint(lambda sid: TrackContext(
            self.service, self.video, str(self.video_path), session_id=sid, lock=self.lock)))
        self.client = app.test_client()

    def click(self, obj, frame=0, points=P, labels=(1,), clear=True):
        self.service.record_points(self.video, obj, frame, points, list(labels), clear)

    def track(self, object_ids=None):
        body = {"session_id": "s"} if object_ids is None else {"session_id": "s", "object_ids": object_ids}
        r = self.client.post("/track_objects", json=body)
        self.job_id = r.headers.get("Job-Id")
        frames, self.closing = parse_all(r.data)
        return r.headers["Objects-Tracked"], frames

    def state(self, obj):
        return self.service.object_info(self.video, obj)["state"]


@pytest.fixture
def h(tmp_path):
    return Harness(tmp_path)


def test_track_runs_only_untracked_and_stale_objects(h):
    h.click(1), h.click(2)
    ids, frames = h.track()
    assert ids == "1,2" and h.engine.calls == [[1, 2]]
    assert h.closing == {"done": True, "objects": [1, 2], "tracked": [1, 2], "failed": {}}
    assert [f for f, _ in frames] == [0, 1, 2, 3] and all(set(m) == {1, 2} for _, m in frames)
    assert (frames[2][1][1] == FakeEngine.mask(1, 2)).all()
    h.click(3)
    ids, frames = h.track()
    assert ids == "3" and h.engine.calls[-1] == [3]
    assert all(set(m) == {3} for _, m in frames)  # the cached ones are not re-sent
    assert h.track() == ("", [])  # nothing dirty: no job
    assert h.closing == {"done": True, "objects": [], "tracked": [], "failed": {}}


def test_explicit_ids_track_exactly_those_even_if_tracked(h):
    h.click(1), h.click(2)
    h.track()
    ids, _ = h.track([2, 99])  # 99 is unknown: dropped
    assert ids == "2" and h.engine.calls[-1] == [2]


def test_editing_seeds_makes_only_that_object_stale(h):
    h.click(1), h.click(2)
    h.track()
    h.click(2, points=[[0.6, 0.6]], clear=False)
    assert h.state(1) == TRACKED and h.state(2) == STALE
    assert h.track()[0] == "2"
    assert h.state(2) == TRACKED


def test_clear_track_makes_one_object_untracked_and_keeps_its_seeds(h):
    h.click(1), h.click(2)
    h.track()
    info = h.service.clear_track(h.video, 1)
    assert info["state"] == UNTRACKED and info["seeds"] and h.state(2) == TRACKED
    assert h.track()[0] == "1"


def test_objects_and_tracks_survive_a_restart(h):
    h.click(1, frame=2), h.click(2)
    h.track()
    h.new_service()
    objs = {o["object_id"]: o for o in h.service.objects(h.video)}
    assert set(objs) == {1, 2} and all(o["state"] == TRACKED for o in objs.values())
    assert objs[1]["seeds"] == {2: {"points": P, "labels": [1]}} and objs[1]["frames"] == [0, 3]
    r = h.client.post("/track_masks", json={"session_id": "s"})
    frames = parse(r.data)
    assert [f for f, _ in frames] == [0, 1, 2, 3] and all(set(m) == {1, 2} for _, m in frames)
    assert (frames[1][1][2] == FakeEngine.mask(2, 1)).all()


def test_a_job_canceled_mid_stream_caches_nothing_and_says_so(h):
    h.click(1)
    real = h.engine.track

    def cancel_after_two(path, objects, video_handle=None):
        for i, fm in enumerate(real(path, objects)):
            if i == 2:
                h.service.jobs.cancel_session("s")  # the user presses cancel mid-job
            yield fm

    h.engine.track = cancel_after_two
    ids, frames = h.track()
    # the frame being computed when cancel landed still streams; nothing after it
    assert len(frames) == 3 and h.closing == {"done": False, "error": "canceled", "objects": [1]}
    assert h.state(1) == UNTRACKED


def test_an_engine_failure_ends_the_stream_with_an_error(h):
    h.click(1)

    def broken(path, objects, video_handle=None):
        yield 0, {1: FakeEngine.mask(1, 0)}
        raise RuntimeError("MPS backend out of memory")

    h.engine.track = broken
    ids, frames = h.track()
    assert len(frames) == 1 and h.closing["done"] is False and "out of memory" in h.closing["error"]
    assert h.state(1) == UNTRACKED


def test_a_failed_save_is_reported_and_the_other_objects_still_cache(h, monkeypatch):
    h.click(1), h.click(2)
    real_save = h.service.tracks.save

    def save(video, obj_id, *a, **k):
        if obj_id == 2:
            raise OSError("disk full")
        return real_save(video, obj_id, *a, **k)

    monkeypatch.setattr(h.service.tracks, "save", save)
    h.track()
    assert h.closing["done"] is True and h.closing["tracked"] == [1] and "disk full" in h.closing["failed"]["2"]
    assert h.state(1) == TRACKED and h.state(2) == UNTRACKED


def test_clearing_the_last_seed_frame_drops_the_track_too(h):
    h.click(1)
    h.track()
    h.service.clear_frame(h.video, 1, 0)
    assert h.state(1) == UNTRACKED
    assert parse(h.client.post("/track_masks", json={"session_id": "s"}).data) == []  # no ghost repaint


def test_the_job_gets_the_sessions_video_handle(h):
    seen = []
    real = h.engine.track

    def spy(path, objects, video_handle=None):
        seen.append(video_handle)
        return real(path, objects)

    h.engine.track = spy
    h.new_service()
    handle = object()
    app = __import__("flask").Flask("x")
    app.register_blueprint(make_blueprint(lambda sid: TrackContext(
        h.service, h.video, str(h.video_path), video_handle=handle)))
    h.click(1)
    app.test_client().post("/track_objects", json={"session_id": "s"}).get_data()
    assert seen == [handle]


def test_a_job_whose_seeds_change_mid_run_ends_stale(h):
    h.click(1)
    real = h.engine.track

    def track_and_edit(path, objects, video_handle=None):
        for i, (f, m) in enumerate(real(path, objects)):
            if i == 1:  # the user clicks again while the job runs
                h.click(1, points=[[0.1, 0.1]], clear=False)
            yield f, m

    h.engine.track = track_and_edit
    h.track()
    assert h.state(1) == STALE


def test_removing_an_object_forgets_it(h):
    h.click(1), h.click(2)
    h.track()
    h.service.remove_object(h.video, 1)
    assert [o["object_id"] for o in h.service.objects(h.video)] == [2]


def test_objects_without_seeds_are_not_tracked(h):
    h.click(1)
    h.service.clear_frame(h.video, 1, 0)  # its only seed frame
    assert h.track() == ("", []) and h.engine.calls == []
