# sam-ui (Apache-2.0). New file, not from SAM 2.
"""The GraphQL fields reach the track service: run the real schema against a
stand-in InferenceAPI (no model)."""
from types import SimpleNamespace

from data.schema import schema

INFO = {"object_id": 3, "state": "stale", "engine": "sam2", "model": "large", "frames": [0, 9], "n_frames": 10,
        "seeds": {4: {"points": [[0.25, 0.75]], "labels": [1]}, 1: {"points": [[0.5, 0.5]], "labels": [0]}},
        "tracks": [{"engine": "sam2", "model": "large", "state": "stale", "frames": [0, 9], "n_frames": 10},
                   {"engine": "sam3", "model": "sam3-tracker", "state": "tracked", "frames": [0, 9], "n_frames": 10}]}


class FakeAPI:
    def __init__(self):
        self.cleared = []

    def start_session(self, request):
        return SimpleNamespace(session_id="s1")

    def object_tracks(self, session_id):
        return [INFO]

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
