First desktop release of sam-ui: studio and the SAM 2 / SAM 3 backend in one macOS app (Apple Silicon).

- Runs the full SAM 2.1 large model locally on your GPU (MPS). It downloads the checkpoint on first run (about 900 MB) and verifies its SHA-256.
- Per-object cached tracks: Track only re-runs objects that are new or changed. You can keep clicking while a track runs.
- SAM 3 tracking is optional: bring your own weights (Meta's SAM License) through SAM 3 > Choose SAM 3 weights folder.
- Exports an MP4 with per-object effects, and a rotoscoping working folder.

**Unsigned build:** right-click the app and choose Open the first time, or run `xattr -dr com.apple.quarantine /Applications/sam-ui.app`. See desktop/README.md.
