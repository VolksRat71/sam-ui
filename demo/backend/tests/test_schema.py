# sam-ui (Apache-2.0). New file, not from SAM 2.
"""The GraphQL fields reach the track service: run the real schema against a
stand-in InferenceAPI (no model)."""
import os
from types import SimpleNamespace

from data.schema import schema

INFO = {"object_id": 3, "state": "stale", "engine": "sam2", "model": "large", "frames": [0, 9], "n_frames": 10,
        "seeds": {4: {"points": [[0.25, 0.75]], "labels": [1]}, 1: {"points": [[0.5, 0.5]], "labels": [0]}},
        "tracks": [{"engine": "sam2", "model": "large", "state": "stale", "frames": [0, 9], "n_frames": 10},
                   {"engine": "sam3", "model": "sam3-tracker", "state": "tracked", "frames": [0, 9], "n_frames": 10}],
        "ranges": [{"start": 2, "end": 5, "state": "absent"}]}


class FakeAPI:
    def __init__(self):
        self.cleared = []
        self.points = []
        self.started = []

    def start_session(self, request):
        self.started.append(request.path)
        return SimpleNamespace(session_id="s1")

    def object_tracks(self, session_id):
        return [INFO]

    def set_object_range(self, session_id, object_id, start, end, state=None):
        self.ranged = (session_id, object_id, start, end, state)
        return {**INFO, "ranges": [] if state is None else [{"start": start, "end": end, "state": state}]}

    def add_points(self, request):
        self.points.append(request)
        if request.labels == [0]:
            raise ValueError("needs_positive: SAM 2 needs a positive click")
        return SimpleNamespace(frame_index=request.frame_index, results=[])

    def clear_track(self, session_id, object_id, engine=None):
        self.cleared.append((session_id, object_id, engine))
        return {**INFO, "state": "untracked", "frames": None, "n_frames": 0}


def run(query, api):
    r = schema.execute_sync(query, context_value={"inference_api": api})
    assert r.errors is None, r.errors
    return r.data


def test_start_session_returns_known_objects_with_seeds_in_frame_order(tmp_path, monkeypatch):
    from data.store import set_videos

    saved = _listed(monkeypatch, tmp_path, ["gallery/x.mp4"])
    try:
        d = run('mutation { startSession(input: {path: "gallery/x.mp4"}) { sessionId objects { objectId state '
                'frames nFrames seeds { frameIndex points labels } } } }', FakeAPI())["startSession"]
        assert d["sessionId"] == "s1"
        o = d["objects"][0]
        assert o["objectId"] == 3 and o["state"] == "stale" and o["frames"] == [0, 9] and o["nFrames"] == 10
        assert [s["frameIndex"] for s in o["seeds"]] == [1, 4] and o["seeds"][1]["points"] == [[0.25, 0.75]]
    finally:
        set_videos(saved)


def test_object_tracks_query_and_clear_track_mutation():
    api = FakeAPI()
    assert run('{ objectTracks(sessionId: "s1") { objectId engine model } }', api)["objectTracks"] == [
        {"objectId": 3, "engine": "sam2", "model": "large"}]
    d = run('mutation { clearTrack(input: {sessionId: "s1", objectId: 3}) { state frames } }', api)["clearTrack"]
    assert d == {"state": "untracked", "frames": None} and api.cleared == [("s1", 3, None)]
    run('mutation { clearTrack(input: {sessionId: "s1", objectId: 3, engine: "sam3"}) { state } }', api)
    assert api.cleared[-1] == ("s1", 3, "sam3")


def test_object_tracks_lists_every_engines_track():
    tracks = run('{ objectTracks(sessionId: "s1") { tracks { engine model state nFrames } } }', FakeAPI())
    assert tracks["objectTracks"][0]["tracks"] == [
        {"engine": "sam2", "model": "large", "state": "stale", "nFrames": 10},
        {"engine": "sam3", "model": "sam3-tracker", "state": "tracked", "nFrames": 10}]


def test_object_ranges_are_listed_and_set_by_mutation():
    api = FakeAPI()
    assert run('{ objectTracks(sessionId: "s1") { ranges { start end state } } }', api)["objectTracks"][0][
        "ranges"] == [{"start": 2, "end": 5, "state": "absent"}]
    d = run('mutation { setObjectRange(input: {sessionId: "s1", objectId: 3, start: 4, end: 8, state: "absent"}) '
            '{ objectId ranges { start end state } } }', api)["setObjectRange"]
    assert d == {"objectId": 3, "ranges": [{"start": 4, "end": 8, "state": "absent"}]}
    assert api.ranged == ("s1", 3, 4, 8, "absent")
    d = run('mutation { setObjectRange(input: {sessionId: "s1", objectId: 3, start: 4, end: 8}) { ranges { start } } }',
            api)["setObjectRange"]
    assert d == {"ranges": []} and api.ranged[-1] is None


HISTORY = {"can_undo": True, "can_redo": False, "versions": [
    {"key": "k2", "engine": "sam2", "model": "large", "created": "2026-09-30T21:00:00-0500", "elapsed_s": 4.2,
     "n_frames": 10, "clicks": 3, "seed_frames": 2, "bounded": True, "current": True},
    {"key": "k1", "engine": "sam2", "model": "large", "created": "2026-09-30T20:00:00-0500", "elapsed_s": 8.0,
     "n_frames": 10, "clicks": 2, "seed_frames": 1, "bounded": False, "current": False}]}


class VersionsAPI(FakeAPI):
    def object_tracks(self, session_id):
        return [{**INFO, "history": HISTORY}]

    def undo_seeds(self, session_id, object_id):
        self.step = ("undo", session_id, object_id)
        return {**INFO, "state": "tracked", "history": {**HISTORY, "can_redo": True}}

    def redo_seeds(self, session_id, object_id):
        self.step = ("redo", session_id, object_id)
        return INFO

    def restore_version(self, session_id, object_id, key):
        self.step = ("restore", session_id, object_id, key)
        return INFO

    def move_clicks(self, session_id, frame_index, from_id, to_id, engine=None):
        self.step = ("move", session_id, frame_index, from_id, to_id)
        self.move_engine = engine
        return [{**INFO, "object_id": from_id}, {**INFO, "object_id": to_id}]


def test_an_objects_history_lists_its_versions():
    d = run('{ objectTracks(sessionId: "s1") { history { canUndo canRedo versions { key engine model created '
            'elapsedS nFrames clicks seedFrames bounded current } } } }', VersionsAPI())
    h = d["objectTracks"][0]["history"]
    assert h["canUndo"] is True and h["canRedo"] is False
    assert h["versions"][0] == {"key": "k2", "engine": "sam2", "model": "large", "created": "2026-09-30T21:00:00-0500",
                                "elapsedS": 4.2, "nFrames": 10, "clicks": 3, "seedFrames": 2, "bounded": True,
                                "current": True}


def test_an_object_without_history_has_an_empty_one():
    d = run('{ objectTracks(sessionId: "s1") { history { canUndo canRedo versions { key } } } }', FakeAPI())
    assert d["objectTracks"][0]["history"] == {"canUndo": False, "canRedo": False, "versions": []}


def test_undo_redo_restore_and_move_mutations_reach_the_api():
    api = VersionsAPI()
    d = run('mutation { undoSeeds(input: {sessionId: "s1", objectId: 3}) { state history { canRedo } } }', api)
    assert d["undoSeeds"] == {"state": "tracked", "history": {"canRedo": True}} and api.step == ("undo", "s1", 3)
    run('mutation { redoSeeds(input: {sessionId: "s1", objectId: 3}) { objectId } }', api)
    assert api.step == ("redo", "s1", 3)
    run('mutation { restoreVersion(input: {sessionId: "s1", objectId: 3, key: "k1"}) { objectId } }', api)
    assert api.step == ("restore", "s1", 3, "k1")
    d = run('mutation { moveClicks(input: {sessionId: "s1", frameIndex: 4, fromObjectId: 1, toObjectId: 2}) '
            '{ objectId } }', api)
    assert d["moveClicks"] == [{"objectId": 1}, {"objectId": 2}] and api.step == ("move", "s1", 4, 1, 2)


ADD = ('mutation {{ addPoints(input: {{sessionId: "s1", frameIndex: 4, objectId: 3, clearOldPoints: true, '
       'points: [[0.5, 0.5]], labels: [{label}]{engine}}}) {{ frameIndex }} }}')


def test_add_points_carries_the_engine_and_leaves_it_none_when_unset():
    api = FakeAPI()
    run(ADD.format(label=1, engine=', engine: "sam3"'), api)
    run(ADD.format(label=1, engine=""), api)
    assert [r.engine for r in api.points] == ["sam3", None]


def test_a_needs_positive_refusal_reaches_the_client_with_its_prefix():
    r = schema.execute_sync(ADD.format(label=0, engine=""), context_value={"inference_api": FakeAPI()})
    assert r.errors and r.errors[0].message.startswith("needs_positive: ")


def test_move_clicks_carries_the_engine_and_leaves_it_none_when_unset():
    api = VersionsAPI()
    q = ('mutation {{ moveClicks(input: {{sessionId: "s1", frameIndex: 4, fromObjectId: 1, toObjectId: 2{engine}}}) '
         '{{ objectId }} }}')
    run(q.format(engine=', engine: "sam3"'), api)
    assert api.move_engine == "sam3"
    run(q.format(engine=""), api)
    assert api.move_engine is None


def _listed(monkeypatch, root, paths):
    """DATA_PATH = root, with `paths` (relative) as files and as the listed videos."""
    import data.schema as sch
    from data.store import get_videos, set_videos

    saved = get_videos()
    monkeypatch.setattr(sch, "DATA_PATH", root)
    for rel in paths:
        f = os.path.join(str(root), rel)
        os.makedirs(os.path.dirname(f), exist_ok=True)
        if not os.path.lexists(f):
            open(f, "wb").close()
    set_videos({rel: SimpleNamespace(path=rel) for rel in paths})
    return saved


def _start(api, path):
    return schema.execute_sync('mutation($p: String!) { startSession(input: {path: $p}) { sessionId } }',
                               variable_values={"p": path}, context_value={"inference_api": api})


def test_start_session_opens_only_listed_videos_inside_the_data_folder(tmp_path, monkeypatch):
    from data.store import set_videos

    saved = _listed(monkeypatch, tmp_path, ["gallery/x.mp4"])
    (tmp_path / "tracks" / "1").mkdir(parents=True)
    (tmp_path / "tracks" / "1" / "seeds.json").write_text("{}")
    try:
        api = FakeAPI()
        assert _start(api, "gallery/x.mp4").errors is None
        assert api.started == [os.path.join(str(tmp_path), "gallery", "x.mp4")]
        for bad in ["../../etc/passwd", "gallery/../../secret.mp4", "/etc/passwd", "//etc/passwd", "",
                    "gallery/..", "gallery/x.mp4\x00", "tracks/1/seeds.json", "tracks", "gallery/nope.mp4"]:
            r = _start(api, bad)
            assert r.errors, bad
            assert str(tmp_path) not in str(r.errors[0]), bad  # never the server's own path
        assert len(api.started) == 1  # nothing else reached the engine
    finally:
        set_videos(saved)


def test_a_listed_video_that_is_gone_from_disk_is_refused_without_the_servers_path(tmp_path, monkeypatch):
    from data.store import set_videos

    saved = _listed(monkeypatch, tmp_path, ["uploads/gone.mp4"])
    os.remove(tmp_path / "uploads" / "gone.mp4")
    try:
        r = _start(FakeAPI(), "uploads/gone.mp4")
        assert r.errors and "uploads/gone.mp4" in str(r.errors[0]) and str(tmp_path) not in str(r.errors[0])
    finally:
        set_videos(saved)


def test_a_relative_data_path_still_opens_its_videos(tmp_path, monkeypatch):
    from data.store import set_videos

    monkeypatch.chdir(tmp_path)
    saved = _listed(monkeypatch, ".", ["gallery/x.mp4"])
    try:
        api = FakeAPI()
        assert _start(api, "gallery/x.mp4").errors is None
        assert api.started == [os.path.join(str(tmp_path), "gallery", "x.mp4")]
    finally:
        set_videos(saved)


def test_a_link_the_backend_made_under_the_data_folder_opens_but_cannot_be_climbed(tmp_path, monkeypatch):
    """The check is on the path's text, on purpose: the AE round trip links
    footage that lives elsewhere into linked/, and that must still open."""
    from data.store import set_videos

    outside = tmp_path / "elsewhere" / "shot.mp4"
    outside.parent.mkdir()
    outside.write_bytes(b"")
    root = tmp_path / "data"
    (root / "linked").mkdir(parents=True)
    os.symlink(outside, root / "linked" / "abc.mp4")
    saved = _listed(monkeypatch, root, ["linked/abc.mp4"])
    try:
        api = FakeAPI()
        assert _start(api, "linked/abc.mp4").errors is None
        assert _start(api, "linked/abc.mp4/../../elsewhere/shot.mp4").errors
        assert len(api.started) == 1
    finally:
        set_videos(saved)


def test_normalised_forms_of_a_listed_path_open_it_and_unlisted_ones_stay_refused(tmp_path, monkeypatch):
    from data.store import set_videos

    saved = _listed(monkeypatch, tmp_path, ["clip.mp4", "sub/clip.mp4"])
    (tmp_path / "other.mp4").write_bytes(b"")  # on disk, never listed
    try:
        api = FakeAPI()
        for ok in ["./clip.mp4", "sub//clip.mp4", "sub/./clip.mp4", "sub/../clip.mp4"]:
            assert _start(api, ok).errors is None, ok
        assert api.started == [os.path.join(str(tmp_path), "clip.mp4"), os.path.join(str(tmp_path), "sub", "clip.mp4"),
                               os.path.join(str(tmp_path), "sub", "clip.mp4"), os.path.join(str(tmp_path), "clip.mp4")]
        for bad in ["./other.mp4", "sub//other.mp4", "sub/../other.mp4"]:
            assert _start(api, bad).errors, bad
        assert len(api.started) == 4
    finally:
        set_videos(saved)


def test_a_listed_entry_outside_the_data_folder_is_still_refused(tmp_path, monkeypatch):
    """Being listed is not enough: the path must also stay inside DATA_PATH."""
    from data.store import set_videos

    root = tmp_path / "data"
    root.mkdir()
    (tmp_path / "outside.mp4").write_bytes(b"")
    saved = _listed(monkeypatch, root, ["../outside.mp4"])
    try:
        api = FakeAPI()
        r = _start(api, "../outside.mp4")
        assert r.errors and str(tmp_path) not in str(r.errors[0]) and api.started == []
    finally:
        set_videos(saved)


def test_an_upload_on_another_thread_does_not_break_a_start(tmp_path, monkeypatch):
    """uploadVideo adds to the listing while startSession checks it; walking
    the listing then raised "dictionary changed size during iteration"."""
    from data.store import get_videos, set_videos

    saved = _listed(monkeypatch, tmp_path, ["gallery/x.mp4"])

    class Growing(dict):
        def values(self):  # an upload lands mid-walk
            for v in super().values():
                self[f"uploads/{len(self)}.mp4"] = SimpleNamespace(path=f"uploads/{len(self)}.mp4")
                yield v

    set_videos(Growing(get_videos()))
    try:
        api = FakeAPI()
        assert _start(api, "gallery/x.mp4").errors is None and len(api.started) == 1
    finally:
        set_videos(saved)
