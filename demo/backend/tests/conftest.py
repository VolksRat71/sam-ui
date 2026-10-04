# sam-ui (Apache-2.0). New file, not from SAM 2.
import os
import sys
import tempfile
from pathlib import Path

# app_conf creates DATA_PATH's folders at import (default /data): point it at a temp dir.
os.environ.setdefault("DATA_PATH", tempfile.mkdtemp(prefix="sam-ui-test-"))

# The backend imports modules relative to demo/backend/server (app_conf, inference, tracks).
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
# This checkout's sam2, not whichever one the venv has installed in editable mode
# (a worktree shares the main clone's venv).
sys.path.insert(1, str(Path(__file__).resolve().parents[3]))


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: loads the SAM 2 model (set SAM_UI_SLOW=1)")
