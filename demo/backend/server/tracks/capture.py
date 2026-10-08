# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Frames of a session's video with its masks drawn on, for agents (POST /capture,
issue #46): an agent checks its work by looking, not by trusting the JSON.

capture() draws 1 to 12 frames, one image (a single frame) or a contact sheet
(cells on mid grey, each labelled with its frame number), as JPEG q80 in base64,
with a legend: n_frames, fps, and per object its id, name, colour and track
state, and per frame drawn what was drawn ("on_frame": seed, track, absent or
none), its area in percent of the frame and its box (normalised 0-1).

What a frame shows is what studio shows: nothing inside an absent range, else
the seed's approved mask, else the track's, then Refine Detail on top
(service.effective_mask). 40% fill, a 2 px outline, the object id at the top
left of its box, and the frame's clicks as + (positive) and x (negative).

Reads tracks from disk and opens the video on its own: no model lock.
"""
import base64
import io
import math
from typing import Callable, Dict, List, Optional

import numpy as np
from PIL import Image, ImageDraw

from tracks import rle
from tracks.detail_preview import read_working_frame
from tracks.ranges import absent_at

# studio/src/meta/theme/colors.ts THEME_COLORS, picked by id % 9 as state/objects.ts does: keep in step
THEME_COLORS = ["#3880F3", "#F0AA19", "#00D2BE", "#28D232", "#8773FF", "#00C8F0", "#FA8719", "#E6193B", "#FA7DC8"]
MAX_FRAMES = 12
FRAME_EDGE = (768, 1280)  # one frame: default and largest long edge
CELL_EDGE = (320, 480)  # a sheet's cell: default and largest long edge
SHEET_MAX = 1568  # a whole sheet's largest side
MIN_EDGE = 64
GAP, LABEL_H = 8, 16
GREY = (128, 128, 128)
FILL = 0.4


class CaptureError(ValueError):
    """A refused request (a 400)."""


def colour(obj_id: int) -> str:
    return THEME_COLORS[obj_id % len(THEME_COLORS)]


def _rgb(hex_colour: str):
    return tuple(int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))


def video_fps(path: str) -> Optional[float]:
    import av

    with av.open(path) as c:
        rate = c.streams.video[0].average_rate
        return float(rate) if rate else None


def pick_frames(body: Dict, n_frames: int) -> List[int]:
    """`frames`, or `count` frames spread evenly over `start`-`end` (default the
    whole clip). Every frame must be in the clip; 1 to 12 of them."""
    if body.get("frames") is not None:
        frames = body["frames"]
        if not isinstance(frames, list) or not all(type(f) is int for f in frames):
            raise CaptureError("frames is a list of frame numbers")
    else:
        start, end, count = body.get("start", 0), body.get("end", n_frames - 1), body.get("count")
        if not all(type(v) is int for v in (start, end, count)):
            raise CaptureError("give frames, or start, end and count as whole numbers")
        if not 1 <= count <= MAX_FRAMES:
            raise CaptureError(f"count is 1 to {MAX_FRAMES}")
        if end < start:
            raise CaptureError("end is before start")
        frames = sorted({round(start + (end - start) * i / max(count - 1, 1)) for i in range(count)})
    if not 1 <= len(frames) <= MAX_FRAMES:
        raise CaptureError(f"capture takes 1 to {MAX_FRAMES} frames, not {len(frames)}")
    bad = [f for f in frames if not 0 <= f < n_frames]
    if bad:
        raise CaptureError(f"frames {bad} are outside the clip (0 to {n_frames - 1})")
    return frames


def _edge(name: str, value, default_max) -> int:
    default, most = default_max
    if value is None:
        return default
    if type(value) is not int or value < MIN_EDGE:
        raise CaptureError(f"{name} is a whole number of pixels, at least {MIN_EDGE}")
    return min(value, most)


def _scale_to(w: int, h: int, long_edge: int):
    s = min(1.0, long_edge / max(w, h))  # never upscaled
    return max(1, round(w * s)), max(1, round(h * s))


def _outline(m: np.ndarray, width: int = 2) -> np.ndarray:
    inner = m.copy()
    for _ in range(width):
        e = inner.copy()
        e[1:] &= inner[:-1]
        e[:-1] &= inner[1:]
        e[:, 1:] &= inner[:, :-1]
        e[:, :-1] &= inner[:, 1:]
        inner = e
    return m & ~inner


def _frame_masks(service, video: str, obj: int, frame: int, engine: str, seeds, ranges, track):
    """(on_frame, mask HxW bool or None) for one object on one frame, as studio shows it."""
    if absent_at(ranges, frame):
        return "absent", None
    seed = seeds.get(frame)
    if seed and seed.get("mask"):
        kind, base = "seed", seed["mask"]
    elif frame in track:
        kind, base = "track", track[frame]
    else:
        return "none", None
    return kind, rle.decode(service.effective_mask(video, obj, frame, base))


def _draw(pixels: np.ndarray, layers, size, points) -> Image.Image:
    """layers: [(obj, mask at the frame's size, rgb)]; points: [(obj, x, y, label)] normalised."""
    w, h = size
    img = Image.fromarray(pixels).convert("RGB").resize((w, h), Image.BILINEAR)
    out = np.asarray(img).astype(np.float32)
    boxes = []
    for obj, mask, rgb in layers:
        m = np.asarray(Image.fromarray(mask).resize((w, h), Image.NEAREST))
        if not m.any():
            continue
        c = np.array(rgb, np.float32)
        out[m] = out[m] * (1 - FILL) + c * FILL
        out[_outline(m)] = c
        ys, xs = np.nonzero(m)
        boxes.append((obj, int(xs.min()), int(ys.min()), rgb))
    img = Image.fromarray(out.clip(0, 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    for obj, x, y, rgb in boxes:
        label = str(obj)
        tw = 7 * len(label) + 4
        x, y = max(0, min(x, w - tw - 1)), max(0, min(y, h - 13))  # a mask at the edge keeps its label in view
        d.rectangle([x, y, x + tw, y + 12], fill=rgb)
        d.text((x + 2, y), label, fill=(0, 0, 0))
    for _obj, px, py, label in points:
        x, y, r = px * (w - 1), py * (h - 1), 5
        arms = [((x - r, y), (x + r, y)), ((x, y - r), (x, y + r))] if label == 1 else \
            [((x - r, y - r), (x + r, y + r)), ((x - r, y + r), (x + r, y - r))]
        for a in arms:
            d.line(a, fill=(0, 0, 0), width=4)
        for a in arms:
            d.line(a, fill=(255, 255, 255) if label == 1 else (255, 64, 64), width=2)
    return img


def capture(service, video: str, path: str, body: Dict, n_frames: int, fps: Optional[float],
            read_frame: Optional[Callable] = None) -> Dict:
    """POST /capture's reply, from its body ({frames | start, end, count; object_ids?,
    engine?, long_edge?, sheet?}); CaptureError for a refusal."""
    frames = pick_frames(body, n_frames)
    engine = body.get("engine") or service.default
    if not isinstance(engine, str):
        raise CaptureError("engine is a name, such as sam2")
    engine = service._engine_model(engine)[0]  # UnknownEngine before any path is built from it
    known = service.seeds.objects(video)
    ids = body.get("object_ids")
    if ids is None:
        ids = known
    elif not isinstance(ids, list) or not all(type(o) is int for o in ids):
        raise CaptureError("object_ids is a list of object ids")
    elif set(ids) - set(known):
        raise CaptureError(f"no objects {sorted(set(ids) - set(known))} in this video (known: {known})")
    sheet = body.get("sheet", len(frames) > 1)
    if not isinstance(sheet, bool):
        raise CaptureError("sheet is true or false")

    names = service.object_names(video)
    wanted = set(frames)
    per_obj = {}
    for o in ids:
        track = {f: r for f, r in service.tracks.masks(video, o, engine) if f in wanted}
        per_obj[o] = (service.seeds.seeds(video, o), service.seeds.ranges(video, o), track)
    legend_objects = [{"id": o, "name": names.get(o), "colour": colour(o),
                       "state": service.object_info(video, o, engine)["state"]} for o in ids]

    images, legend_frames = [], []
    for f in frames:
        pixels = (read_frame or read_working_frame)(path, f)
        fh, fw = pixels.shape[:2]
        layers, points, drawn = [], [], []
        for o in ids:
            seeds, ranges, track = per_obj[o]
            kind, mask = _frame_masks(service, video, o, f, engine, seeds, ranges, track)
            entry = {"id": o, "on_frame": kind, "area": 0.0, "box": None}
            if mask is not None:
                if mask.shape != (fh, fw):
                    raise CaptureError(f"object {o}'s mask is {mask.shape[1]}x{mask.shape[0]}, the frame {fw}x{fh}")
                if mask.any():
                    ys, xs = np.nonzero(mask)
                    entry["area"] = round(100 * float(mask.mean()), 2)
                    entry["box"] = [round(xs.min() / fw, 4), round(ys.min() / fh, 4),
                                    round((xs.max() + 1) / fw, 4), round((ys.max() + 1) / fh, 4)]
                layers.append((o, mask, _rgb(colour(o))))
            if kind != "absent":
                for p, l in zip(seeds.get(f, {}).get("points", []), seeds.get(f, {}).get("labels", [])):
                    points.append((o, p[0], p[1], int(l)))
            drawn.append(entry)
        images.append((f, pixels, layers, points))
        legend_frames.append({"frame": f, "objects": drawn})

    fh, fw = images[0][1].shape[:2]
    if not sheet:
        if len(frames) != 1:
            raise CaptureError("one frame without a sheet; set sheet true for several")
        f, pixels, layers, points = images[0]
        img = _draw(pixels, layers, _scale_to(fw, fh, _edge("long_edge", body.get("long_edge"), FRAME_EDGE)), points)
    else:
        cols = math.ceil(math.sqrt(len(images)))
        rows = math.ceil(len(images) / cols)
        cw, ch = _scale_to(fw, fh, _edge("long_edge", body.get("long_edge"), CELL_EDGE))
        # the whole sheet fits SHEET_MAX on both sides: shrink the cells if it would not
        fit = min(1.0, (SHEET_MAX - GAP * (cols + 1)) / (cols * cw),
                  (SHEET_MAX - GAP * (rows + 1)) / (rows * (ch + LABEL_H)))
        cw, ch = max(1, int(cw * fit)), max(1, int(ch * fit))
        img = Image.new("RGB", (cols * cw + GAP * (cols + 1), rows * (ch + LABEL_H) + GAP * (rows + 1)), GREY)
        d = ImageDraw.Draw(img)
        for k, (f, pixels, layers, points) in enumerate(images):
            x = GAP + (k % cols) * (cw + GAP)
            y = GAP + (k // cols) * (ch + LABEL_H + GAP)
            d.text((x, y + 2), f"frame {f}", fill=(0, 0, 0))
            img.paste(_draw(pixels, layers, (cw, ch), points), (x, y + LABEL_H))

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return {"image": base64.b64encode(buf.getvalue()).decode(), "mime_type": "image/jpeg",
            "width": img.width, "height": img.height,
            "legend": {"n_frames": n_frames, "fps": fps, "engine": engine, "sheet": sheet, "frames": frames,
                       "objects": legend_objects, "drawn": legend_frames}}
