# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Deleting an uploaded video, or removing a linked one.

Only uploads can be deleted: they are transcoded copies the backend made. The
gallery is a folder the user manages (it can hold source footage), so a
gallery path is refused. A linked video (footage opened in place, see
data/linked.py) is removed from sam-ui: its link, source record and poster go,
and the footage the link points at is never touched. A video open in a
session is refused too; close the session first. With purge, the video's seeds
and cached tracks go with it.
"""
import os
from pathlib import Path
from typing import Callable, Dict, Optional

from app_conf import DATA_PATH, POSTERS_PATH, UPLOADS_PATH
from data import linked
from data.store import get_videos


class DeleteRefused(ValueError):
    pass


def delete_upload(path: str, in_use: Callable[[str], bool], purge: Callable[[str], None],
                  do_purge: bool = True, close_idle: Optional[Callable[[str], int]] = None) -> Dict:
    """`path` is the video's path as the API lists it (uploads/<hash>.mp4).
    `in_use(abs_path)` says whether a session holds it; `purge(abs_path)`
    drops its seeds and tracks. Returns what was removed."""
    link = linked.link_file(path)
    if link is not None:
        # by the path's text, never resolved: resolving would land on the footage
        if not (link.is_symlink() and link.is_file()):
            raise DeleteRefused(f"no linked video {path!r}")
        full = link
    else:
        full = (Path(DATA_PATH) / path).resolve()
        if full.parent != Path(UPLOADS_PATH).resolve():
            raise DeleteRefused(f"only uploaded videos can be deleted, not {path!r}")
        if not full.is_file():
            raise DeleteRefused(f"no uploaded video {path!r}")
    closed = close_idle(str(full)) if close_idle else 0  # sessions nobody is using any more
    if in_use(str(full)):
        raise DeleteRefused(f"{path!r} is open in a session; close the session first")
    purged = False
    if do_purge:
        purge(str(full))  # needs the file: seeds and tracks are keyed by its sha256
        purged = True
    if link is not None:
        linked.unlink(link)
    else:
        os.remove(full)
        poster = Path(POSTERS_PATH) / f"{full.stem}.jpg"
        if poster.exists():
            poster.unlink()
    videos = get_videos()
    for code in [c for c, v in videos.items() if v.path == path or c == path]:
        del videos[code]
    return {"path": path, "purged": purged, "sessions_closed": closed}
