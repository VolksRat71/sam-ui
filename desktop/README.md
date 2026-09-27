<!-- sam-ui (Apache-2.0). New file, not from SAM 2. -->
# sam-ui desktop

The desktop app packages studio and the Python backend into one app, and runs the
full models locally on your GPU (Apple's MPS on macOS). The backend runs inside
the app, and studio is served by it, so nothing else needs installing.

## Install (macOS 14 Sonoma or newer, Apple Silicon)

Any M-series Mac (M1 or later). macOS 14 is the floor because the bundled
PyTorch needs it.

1. Download `sam-ui-<version>-arm64.dmg` from the
   [releases](https://github.com/VolksRat71/sam-ui/releases) and drag **sam-ui**
   into Applications.
2. The app is **not signed or notarised yet**, so macOS will refuse to open it the
   first time. On macOS 14, right-click the app and choose **Open**, then **Open**
   again. On macOS 15 and later, open it once, then go to **System Settings →
   Privacy & Security** and click **Open Anyway**. Or, on any version, run:
   ```sh
   xattr -dr com.apple.quarantine /Applications/sam-ui.app
   ```
3. On first launch it downloads SAM 2.1 large (about 900 MB, once) from Meta and
   checks its SHA-256 before using it.

**SAM 3 (optional).** SAM 3 is under Meta's SAM License and does not ship with the
app. To add it:
1. Open [facebook/sam3](https://huggingface.co/facebook/sam3) and accept the licence.
   Meta approves access, sometimes after a wait.
2. Create a **read** token on your
   [Hugging Face token page](https://huggingface.co/settings/tokens).
3. In the app, choose **SAM 3 → Download SAM 3 with a Hugging Face token…** and
   paste the token.
   - The app downloads about 3.5 GB into its data folder and checks every file's hash
     before keeping it. It skips `sam3.pt`, a pickle it doesn't need.
   - The token is used for that download only, sent only to huggingface.co, and
     never saved.
4. Restart when it says so. The SAM 3 switch in studio is then available.

If you already have the weights, **SAM 3 → Choose SAM 3 weights folder…** uses that
folder instead. SAM 3 needs a lot of GPU memory; 32 GB of RAM or more is
recommended.

**Where things are:**
- Everything lives in `~/Library/Application Support/sam-ui/`: `checkpoints/`;
  `data/`, which holds uploads, cached tracks and posters; and `logs/backend.log`.
- **Help → Open backend log** and **Help → Show data folder** open these.
- Rotoscoping exports can go anywhere in your home folder.

**Security.** The backend listens only on `127.0.0.1`, on a random port. It sends
no CORS headers, and refuses any request whose `Host` or `Origin` isn't the app's
own page, so other websites can't reach it. The app's windows are sandboxed, and
links open in your browser.

## Develop

```sh
cd studio && npm ci && VITE_API_ENDPOINT=same-origin npm run build && cd ..
cd desktop && npm ci
SAM_UI_CHECKPOINT=/path/to/sam2.1_hiera_large.pt npm start   # uses the repo's .venv
```

| Setting | What it does |
| --- | --- |
| `SAM_UI_CHECKPOINT` | reuses a checkpoint already on disk instead of downloading; it must match Meta's hash |
| `SAM_UI_PYTHON` | the Python to run the backend with, in dev (default: `../.venv/bin/python`) |
| `SAM_UI_USER_DATA` | a separate data folder, for example a clean first run |

## Build the app

```sh
bash scripts/build-python.sh     # build/python: CPython 3.11 + requirements.lock + sam2
npm run dist                     # dist/sam-ui-<version>-arm64.dmg
```

`requirements.lock` is the backend's dependency set, frozen from the environment
the tests run in. The GitHub workflow `.github/workflows/desktop-release.yml` does
the same build on a macOS arm64 runner:
- on a `v*` tag, it attaches the dmg to a GitHub release;
- on a manual run, it keeps the dmg as a build artifact.
