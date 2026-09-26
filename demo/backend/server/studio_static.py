# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Serve a built studio (studio/dist) from the backend itself, so the UI and
the API share one origin: the desktop app opens http://127.0.0.1:<port>/ and
studio, built with VITE_API_ENDPOINT=same-origin, talks to the same host.

Enabled by SAM_UI_STUDIO_DIST (the dist folder). The API's own routes
(/graphql, /track_*, /gallery/... and the rest) are more specific than the
catch-all here, so Flask always picks them first.
"""
from pathlib import Path

from flask import Blueprint, Response, abort, send_from_directory


def make_studio_blueprint(dist: str) -> Blueprint:
    root = Path(dist).resolve()
    if not (root / "index.html").is_file():
        raise FileNotFoundError(f"SAM_UI_STUDIO_DIST={dist} has no index.html (build studio first)")
    bp = Blueprint("studio_static", __name__)

    @bp.route("/")
    def index() -> Response:
        r = send_from_directory(root, "index.html")
        r.headers["Cache-Control"] = "no-cache"  # a new build must show on the next load
        return r

    @bp.route("/<path:path>")
    def asset(path: str) -> Response:
        if not (root / path).is_file():  # send_from_directory also refuses paths escaping root
            abort(404)
        return send_from_directory(root, path)

    return bp
