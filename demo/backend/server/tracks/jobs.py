# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Running track jobs: which objects each one holds, its progress, and its
cancel flag.

A job holds the model lock one frame at a time, so clicks get in between
frames. Jobs can overlap as a result, so every job claims its objects here:
a claimed object reads as "tracking" and no other job selects it.
"""
import itertools
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Set

TRACKING = "tracking"


@dataclass
class Job:
    id: str
    session_id: str
    video: str
    objects: List[int]
    n_frames: Optional[int] = None
    engine: str = ""
    frames_done: int = 0
    started: float = field(default_factory=time.time)
    canceled: bool = False

    def info(self) -> Dict:
        return {"job_id": self.id, "engine": self.engine, "objects": self.objects, "frames_done": self.frames_done,
                "n_frames": self.n_frames, "elapsed_s": round(time.time() - self.started, 1)}


class JobRegistry:
    def __init__(self):
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()
        self._ids = itertools.count(1)

    def claim(self, session_id: str, video: str, wanted: Iterable[int], n_frames: Optional[int] = None,
              engine: str = "") -> Job:
        """Register a job for the objects in `wanted` that no running job on the
        same engine holds. Claim and check happen under one lock, so two jobs of
        one engine never share an object (two engines may track it at once)."""
        with self._lock:
            held = self._held(video, engine)
            objs = sorted(o for o in set(wanted) if o not in held)
            job = Job(f"job-{next(self._ids)}", session_id, video, objs, n_frames, engine)
            self._jobs[job.id] = job
            return job

    def release(self, job: Job) -> None:
        with self._lock:
            self._jobs.pop(job.id, None)

    def _held(self, video: str, engine: Optional[str] = None) -> Set[int]:
        return {o for j in self._jobs.values() if j.video == video and engine in (None, j.engine)
                for o in j.objects}

    def held(self, video: str, engine: Optional[str] = None) -> Set[int]:
        """Objects running jobs hold: on `engine`, or on any engine when None."""
        with self._lock:
            return self._held(video, engine)

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return False
            job.canceled = True
            return True

    def cancel_session(self, session_id: str) -> int:
        with self._lock:
            jobs = [j for j in self._jobs.values() if j.session_id == session_id]
            for j in jobs:
                j.canceled = True
            return len(jobs)

    def session_busy(self, session_id: str) -> bool:
        with self._lock:
            return any(j.session_id == session_id for j in self._jobs.values())

    def running(self, video: Optional[str] = None) -> List[Dict]:
        with self._lock:
            return [j.info() for j in self._jobs.values() if video is None or j.video == video]
