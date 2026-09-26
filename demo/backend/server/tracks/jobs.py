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
    frames_done: int = 0
    started: float = field(default_factory=time.time)
    canceled: bool = False

    def info(self) -> Dict:
        return {"job_id": self.id, "objects": self.objects, "frames_done": self.frames_done,
                "n_frames": self.n_frames, "elapsed_s": round(time.time() - self.started, 1)}


class JobRegistry:
    def __init__(self):
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()
        self._ids = itertools.count(1)

    def claim(self, session_id: str, video: str, wanted: Iterable[int], n_frames: Optional[int] = None) -> Job:
        """Register a job for the objects in `wanted` that no running job holds.
        Claim and check happen under one lock, so two jobs never share an object."""
        with self._lock:
            held = self._held(video)
            objs = sorted(o for o in set(wanted) if o not in held)
            job = Job(f"job-{next(self._ids)}", session_id, video, objs, n_frames)
            self._jobs[job.id] = job
            return job

    def release(self, job: Job) -> None:
        with self._lock:
            self._jobs.pop(job.id, None)

    def _held(self, video: str) -> Set[int]:
        return {o for j in self._jobs.values() if j.video == video for o in j.objects}

    def held(self, video: str) -> Set[int]:
        with self._lock:
            return self._held(video)

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

    def running(self, video: Optional[str] = None) -> List[Dict]:
        with self._lock:
            return [j.info() for j in self._jobs.values() if video is None or j.video == video]
