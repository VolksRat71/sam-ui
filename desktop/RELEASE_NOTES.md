sam-ui 0.2.0: long clips, new exports, and a browser demo. macOS 14 or newer, Apple Silicon (M1 or later); 16 GB of memory recommended, and needed for SAM 3 (see Hardware in the README).

- **Long clips.** Memory no longer grows with clip length: frames are decoded as tracking and playback reach them, and tracking state keeps only what the model reads again. Uploads take up to 5 minutes and 2 GB (Meta's demo limit was 10 seconds); a longer clip keeps its start, and studio says so before it uploads.
- **Exports.** Mask videos (one black and white MP4 per object, in a zip), the PNG roto working folder, and vector JSON (per-frame outlines for After Effects masks). Each export records the engine and model that made it. Export to After Effects is coming.
- **Object names.** Rename objects in place; exports use the names.
- **Engines.** The picker lists every model and says why one can't run, with Set up SAM 3 right there when its weights are missing. SAM 3 still needs you to accept Meta's SAM License on Hugging Face; the app never ships its weights.
- **Fixes.** Tracking two objects first clicked on different frames no longer crashes the backend on Apple GPUs. The app no longer falls back to browser-only mode when its backend is slow to start. A downloaded copy no longer opens as "damaged".
- **Browser demo.** SAM 2.1 tiny runs in the browser on WebGPU, with no server and nothing uploaded, at https://volksrat71.github.io/sam-ui/ (Chrome or Edge on desktop; clips up to 2 minutes). It is a demo: the desktop app's SAM 2.1 large and SAM 3 give much better masks.

**Unsigned build:** the first time, macOS says it can't verify the app. On macOS 15 and later, open it once, then click Open Anyway in System Settings > Privacy & Security (on macOS 14, right-click the app and choose Open). Or run `xattr -dr com.apple.quarantine /Applications/sam-ui.app`. See desktop/README.md.
