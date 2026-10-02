# sam-ui (Apache-2.0). New file, not from SAM 2.
"""The GraphQL fields reach the track service: run the real schema against a
stand-in InferenceAPI (no model)."""
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

    def start_session(self, request):
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


def test_start_session_returns_known_objects_with_seeds_in_frame_order():
    d = run('mutation { startSession(input: {path: "gallery/x.mp4"}) { sessionId objects { objectId state '
            'frames nFrames seeds { frameIndex points labels } } } }', FakeAPI())["startSession"]
    assert d["sessionId"] == "s1"
    o = d["objects"][0]
    assert o["objectId"] == 3 and o["state"] == "stale" and o["frames"] == [0, 9] and o["nFrames"] == 10
    assert [s["frameIndex"] for s in o["seeds"]] == [1, 4] and o["seeds"][1]["points"] == [[0.25, 0.75]]


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
