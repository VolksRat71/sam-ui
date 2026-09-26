# sam-ui (Apache-2.0). New file, not from SAM 2.
import sys
from pathlib import Path

# The backend imports modules relative to demo/backend/server (app_conf, inference, tracks).
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
