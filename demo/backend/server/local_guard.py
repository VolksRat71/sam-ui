# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Lock the backend down to its own page, for the desktop app.

A backend on 127.0.0.1 is still reachable from any website the user visits:
the browser will send it requests. So, when the desktop app asks for it:
- SAM_UI_CORS=off: no CORS headers at all (studio is same-origin there);
- SAM_UI_ALLOWED_HOST=127.0.0.1:<port>: requests whose Host differs are
  refused (DNS rebinding: evil.example resolving to 127.0.0.1);
- the same value is the only Origin accepted: a request carrying another
  site's Origin is refused, which stops cross-site form posts (a multipart
  upload needs no CORS preflight).
Requests without an Origin header (same-origin GETs, curl) pass the origin
check; the Host check still applies to them.
"""
from typing import Optional

from flask import Flask, abort, request


def install(app: Flask, allowed_host: Optional[str]) -> None:
    if not allowed_host:
        return
    allowed_origins = {f"http://{allowed_host}"}

    @app.before_request
    def _guard():
        if request.host != allowed_host:
            abort(403, description=f"host {request.host!r} not allowed")
        origin = request.headers.get("Origin")
        if origin is not None and origin not in allowed_origins:
            abort(403, description=f"origin {origin!r} not allowed")
