# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Track jobs hold the model lock per frame: clicks get in between frames,
overlapping jobs never share an object, and each job can be cancelled alone."""
import threading
import time

from test_api import Harness, parse_all
from tracks.engine import FakeEngine
from tracks.store import TRACKED

FRAME_S = 0.05


class SlowEngine(FakeEngine):
    def track(self, video_path, objects, video_handle=None):
        for f, m in super().track(video_path, objects, video_handle):
            time.sleep(FRAME_S)  # "computing" the frame, under the lock
            yield f, m


def harness(tmp_path, n=20):
    return Harness(tmp_path, engine=SlowEngine(n_frames=n))


def start_job(h, body):
    """Run a /track_objects request in a thread; returns (thread, box) where
    box gets the job id, then the parsed stream."""
    box = {}

    def run():
        r = h.client.post("/track_objects", json={"session_id": "s", **body})
        box["job_id"] = r.headers.get("Job-Id")
        box["ids"] = r.headers["Objects-Tracked"]
        box["frames"], box["closing"] = parse_all(r.data)

    t = threading.Thread(target=run)
    t.start()
    deadline = time.time() + 5
    while not h.service.jobs.running() and time.time() < deadline:
        time.sleep(0.005)
    return t, box


def test_a_click_waits_one_frame_not_the_whole_job(tmp_path):
    h = harness(tmp_path)
    h.click(1)
    t, box = start_job(h, {})
    time.sleep(3 * FRAME_S)
    t0 = time.perf_counter()
    with h.lock:  # what a click (add_points) takes
        waited = time.perf_counter() - t0
    t.join()
    assert waited < 3 * FRAME_S, f"a click waited {waited:.2f} s behind a {20 * FRAME_S:.1f} s job"
    assert box["closing"]["done"] is True and h.state(1) == TRACKED


def test_overlapping_jobs_never_share_an_object(tmp_path):
    h = harness(tmp_path)
    for o in (1, 2, 3):
        h.click(o)
    t, box = start_job(h, {"object_ids": [1, 2]})
    assert h.state(1) == "tracking" and h.state(3) != "tracking"
    ids3, _ = h.track([2])  # explicitly asking for an object a job holds (answers at once)
    assert ids3 == "" and h.closing["objects"] == []
    ids2, frames2 = h.track()  # a second Track press while the first job runs
    assert ids2 == "3" and all(set(m) == {3} for _, m in frames2)
    t.join()
    assert box["ids"] == "1,2" and h.state(1) == h.state(2) == h.state(3) == TRACKED
    assert h.service.jobs.running() == []


def test_cancel_track_stops_one_job_and_leaves_the_other(tmp_path):
    h = harness(tmp_path)
    h.click(1), h.click(2)
    t1, b1 = start_job(h, {"object_ids": [1]})
    t2, b2 = start_job(h, {"object_ids": [2]})
    while len(h.service.jobs.running()) < 2:
        time.sleep(0.005)
    job1 = next(j["job_id"] for j in h.service.jobs.running() if j["objects"] == [1])
    r = h.client.post("/cancel_track", json={"session_id": "s", "job_id": job1})
    assert r.json == {"canceled": True}
    t1.join(), t2.join()
    assert b1["closing"]["error"] == "canceled" and b2["closing"]["done"] is True
    assert h.state(1) != TRACKED and h.state(2) == TRACKED


def test_track_jobs_reports_progress(tmp_path):
    h = harness(tmp_path)
    h.click(1)
    t, _ = start_job(h, {})
    time.sleep(5 * FRAME_S)
    jobs = h.client.post("/track_jobs", json={"session_id": "s"}).json["jobs"]
    t.join()
    assert len(jobs) == 1 and jobs[0]["objects"] == [1] and 0 < jobs[0]["frames_done"] < 20


def test_a_dropped_client_releases_the_job(tmp_path):
    h = harness(tmp_path)
    h.click(1)
    r = h.client.post("/track_objects", json={"session_id": "s"}, buffered=False)
    it = iter(r.response)
    next(it), next(it)  # two frames, then the client goes away
    r.close()
    assert h.service.jobs.running() == [] and h.state(1) != TRACKED
    assert h.track()[0] == "1"  # and the object can be tracked again
