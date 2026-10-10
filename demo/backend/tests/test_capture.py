# sam-ui (Apache-2.0). New file, not from SAM 2.
"""POST /capture (tracks/capture.py): frames with masks drawn on, for agents."""
import base64
import io
import threading

import numpy as np
import pytest
from flask import Flask
from PIL import Image

from test_api import Harness
from tracks import capture as cap
from tracks import rle
from tracks.engine import FakeEngine
from tracks.routes import TrackContext, make_blueprint

H, W = 90, 160
GREY = 100


class CaptureHarness(Harness):
    """Harness with a video handle (n_frames) and a frame reader patched to plain grey frames."""

    def new_service(self):
        super().new_service()
        app = Flask(__name__)
        self.lock = threading.Lock()

        def resolve(sid):
            if sid != "s":
                raise RuntimeError(f"Cannot find session {sid}; it might have expired")
            return TrackContext(self.service, self.video, str(self.video_path), session_id=sid, lock=self.lock,
                                video_handle={"images": [None] * self.engine.n_frames})
        app.register_blueprint(make_blueprint(resolve, self.service))
        self.client = app.test_client()


@pytest.fixture
def h(tmp_path, monkeypatch):
    shape = {"shape": (H, W)}
    monkeypatch.setattr(cap, "read_working_frame", lambda path, i, **_: np.full((*shape["shape"], 3), GREY, np.uint8))
    monkeypatch.setattr("tracks.routes.video_fps", lambda path: 24.0)
    h = CaptureHarness(tmp_path, FakeEngine(n_frames=6, shape=(H, W)))
    h.frame_shape = shape
    return h


def post(h, **body):
    return h.client.post("/capture", json={"session_id": "s", **body})


def image(r) -> np.ndarray:
    assert r.status_code == 200, r.json
    data = base64.b64decode(r.json["image"])
    assert data[:3] == b"\xff\xd8\xff"  # JPEG
    img = Image.open(io.BytesIO(data))
    assert (img.width, img.height) == (r.json["width"], r.json["height"])
    return np.asarray(img.convert("RGB")).astype(int)


def rect_mask(x0, y0, x1, y1):
    m = np.zeros((H, W), bool)
    m[y0:y1, x0:x1] = True
    return rle.encode(m)


def test_one_frame_is_a_jpeg_within_its_long_edge(h):
    h.click(1)
    h.track()
    r = post(h, frames=[2])
    assert image(r).shape == (H, W, 3)  # never upscaled past the frame
    legend = r.json["legend"]
    assert legend["n_frames"] == 6 and legend["fps"] == 24.0 and legend["frames"] == [2]
    assert legend["objects"] == [{"id": 1, "name": None, "colour": cap.THEME_COLORS[1], "state": "tracked"}]
    assert image(post(h, frames=[2], long_edge=80)).shape == (45, 80, 3)
    assert image(post(h, frames=[2], long_edge=99999)).shape == (H, W, 3)  # clamped to the max, still no upscale


def test_colour_lands_inside_the_box_only(h):
    # edges on 16 px JPEG blocks, so colour bleeds at most the 2 px chroma smoothing across them
    seed(h, 3, 1, rect_mask(48, 32, 112, 64))
    r = post(h, frames=[1])
    px = image(r)
    entry = r.json["legend"]["drawn"][0]["objects"][0]
    assert entry["on_frame"] == "seed" and entry["box"] == [0.3, 0.3556, 0.7, 0.7111]
    assert entry["area"] == pytest.approx(100 * 64 * 32 / (W * H), abs=0.01)
    colour = np.array([int(cap.THEME_COLORS[3][i:i + 2], 16) for i in (1, 3, 5)])
    inside = px[52, 64]  # in the box, off the click and the label: 40% fill
    assert np.abs(inside - (GREY * 0.6 + colour * 0.4)).max() < 12
    outside = np.concatenate([px[:30].reshape(-1, 3), px[66:].reshape(-1, 3), px[:, :46].reshape(-1, 3),
                              px[:, 114:].reshape(-1, 3)])
    assert np.abs(outside - GREY).max() < 12  # nothing drawn outside the box (JPEG noise aside)


def test_a_picked_colour_fills_the_box_and_names_the_legend(h):
    """colors: the person's colours from studio (issue #73), for this object only."""
    seed(h, 3, 1, rect_mask(48, 32, 112, 64))
    r = post(h, frames=[1], colors={"3": "#ff00ff", "9": "#00ff00"})
    px = image(r)
    assert np.abs(px[52, 64] - (GREY * 0.6 + np.array([255, 0, 255]) * 0.4)).max() < 12
    assert np.abs(px[:30].reshape(-1, 3) - GREY).max() < 12
    assert r.json["legend"]["objects"] == [{"id": 3, "name": None, "colour": "#FF00FF", "state": "untracked"}]
    assert post(h, frames=[1]).json["legend"]["objects"][0]["colour"] == cap.THEME_COLORS[3]


@pytest.mark.parametrize("colors", [["#ff00ff"], {"3": "red"}, {"3": "#ff00f"}, {"x": "#ff00ff"}, {"-1": "#ff00ff"}, {"²": "#ff00ff"}, {"1" * 10: "#ff00ff"},
                                    {"3": 7}, {str(i): "#000000" for i in range(1001)}])
def test_bad_colours_are_refused(h, colors):
    h.click(1)
    r = post(h, frames=[0], colors=colors)
    assert r.status_code == 400 and "colors" in r.json["error"]


def seed(h, obj, frame, mask):
    """A click on `frame` whose approved mask is `mask`."""
    h.service.record_points(h.video, obj, frame, [[0.5, 0.5]], [1], True, mask)


def test_absent_frames_draw_nothing(h):
    h.click(1)
    h.track()
    h.service.set_range(h.video, 1, 3, 4, "absent")
    r = post(h, frames=[3])
    assert r.json["legend"]["drawn"][0]["objects"] == [{"id": 1, "on_frame": "absent", "area": 0.0, "box": None}]
    assert np.abs(image(r) - GREY).max() < 6  # a plain frame: no fill, outline, label or click


def test_the_seed_mask_wins_over_the_track(h):
    h.click(1)
    h.track()
    assert post(h, frames=[2]).json["legend"]["drawn"][0]["objects"][0]["on_frame"] == "track"
    seed(h, 1, 2, rect_mask(10, 10, 50, 50))
    got = post(h, frames=[2]).json["legend"]["drawn"][0]["objects"][0]
    assert got["on_frame"] == "seed" and got["box"] == [0.0625, 0.1111, 0.3125, 0.5556]


def test_a_sheet_lays_frames_out_in_labelled_cells(h):
    h.click(1)
    h.track()
    r = post(h, start=0, end=5, count=5)
    assert r.json["legend"]["frames"] == [0, 1, 2, 4, 5] and r.json["legend"]["sheet"] is True
    # 3 columns, 2 rows of 160x90 cells (the 320 default never upscales), 16 px labels, 8 px gaps
    assert image(r).shape == (2 * (H + 16) + 3 * 8, 3 * W + 4 * 8, 3)
    assert len(r.json["legend"]["drawn"]) == 5


def test_a_big_sheet_stays_within_its_maximum(h):
    h.frame_shape["shape"] = (1080, 1920)
    r = post(h, frames=list(range(6)) * 2, object_ids=[], long_edge=480)
    px = image(r)
    assert max(px.shape[:2]) <= cap.SHEET_MAX


@pytest.mark.parametrize("body, status, words", [
    ({"frames": [6]}, 400, "outside the clip"),
    ({"frames": [-1]}, 400, "outside the clip"),
    ({"frames": list(range(13))}, 400, "1 to 12"),
    ({"frames": []}, 400, "1 to 12"),
    ({"start": 0, "end": 5, "count": 13}, 400, "count is 1 to 12"),
    ({"frames": ["0"]}, 400, "frames is a list"),
    ({"frames": [0], "object_ids": [7]}, 400, "no objects [7]"),
    ({"frames": [0], "engine": "../x"}, 400, "unknown engine"),
    ({"frames": [0], "engine": ["fake"]}, 400, "engine is a name"),
    ({"frames": [0], "long_edge": 10}, 400, "at least 64"),
    ({"frames": [0, 1], "sheet": False}, 400, "one frame without a sheet"),
])
def test_refusals(h, body, status, words):
    h.click(1)
    r = post(h, **body)
    assert r.status_code == status and words in r.json["error"]


def test_each_frame_is_drawn_before_the_next_is_read(h, monkeypatch):
    """A sheet never holds more than one full-size frame: read, draw, read, draw."""
    h.click(1)
    h.track()
    events, draw = [], cap._draw
    monkeypatch.setattr(cap, "read_working_frame",
                        lambda path, i: events.append("read") or np.full((H, W, 3), GREY, np.uint8))
    monkeypatch.setattr(cap, "_draw", lambda *a: events.append("draw") or draw(*a))
    image(post(h, frames=[0, 2, 4]))
    assert events == ["read", "draw"] * 3


def test_an_unknown_session_is_a_404(h):
    r = h.client.post("/capture", json={"session_id": "nope", "frames": [0]})
    assert r.status_code == 404 and "Cannot find session" in r.json["error"]
    assert h.client.post("/capture", data="x", content_type="application/json").status_code == 400
