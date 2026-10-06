sam-ui 0.3.0: corrections, review, and an After Effects round trip. macOS 14 or newer, Apple Silicon (M1 or later); 16 GB of memory recommended, and needed for SAM 3. The browser demo needs WebGPU in Chrome or Edge. After Effects export needs AE MCP Vision v2.2.0.

- **Corrections.** A correction refines the tracked mask. On SAM 2, a negative click without a positive asks you to add one instead of replacing the mask. “Gone for a while?” lets you mark an absence. (#23)
- **Absent ranges.** Mark the frames where an object leaves the shot. They stay empty, and each side of the gap tracks from its own seeds. A positive click inside an absence ends it at that frame. (#26)
- **Faster re-tracking.** A correction re-tracks the stretch it affects. Clearing a seed can blank its affected span without another model run. (#28)
- **Undo and restore.** Undo or redo seed changes, move a frame's clicks to another object, and restore a kept track version with its seeds. (#37)
- **Object groups.** Reorder objects and organize them into named, colored groups. Exports keep group folders, with an optional union mask for each group. (#38)
- **Candidate ranges.** The timeline distinguishes unknown, candidate, present and absent frames. Review a candidate as Present, Absent or Reject. Present and candidate annotations do not change masks. (#39)
- **Review queue.** Jump through ranked stops where a track may need attention, see the reason, and mark “Looks right” as you go. (#40)
- **Find by text.** With SAM 3 selected, describe an object on the current frame and use the result as a tracking seed. SAM 3 still requires Meta's license acceptance and downloaded weights. (#27)
- **Video decoding.** PyAV replaces decord, improving frame selection for edit-list and transport-stream clips while keeping decoded frames bounded in memory. (#25)
- **Safer file handling.** Sessions only open listed media, and backend exports check their output paths before writing or replacing files. (#29)
- **Upload sizing.** Uploads now honor configured width and height limits without upscaling, including portrait and rotated footage. (#30)
- **Originals and proxies, opt-in.** Backend tools can retain an upload's original bytes and exact frame times, then generate a frame-for-frame inference proxy. Both features default off. They do not switch normal playback, tracking or export to the original; normal uploads still use the configured frame rate, 24 fps by default. (#31, #32)
- **Phone and tablet layout.** Studio adapts to small screens, with touch pan, pinch zoom and long-press point entry. Uploads continue across layout changes. Model support still depends on the device and browser. (#33)
- **Update notices.** The desktop app checks for releases and offers a link when a newer version is available. Help > Check for Updates checks on demand. Downloads and installation remain manual. (#34)
- **Five-minute browser clips.** The browser demo now accepts clips up to five minutes, with a benchmark tool for checking long-track memory. It still uses SAM 2.1 tiny and keeps your video in the browser. (#35)
- **Refinement comparisons.** A benchmark tool compares six refinement strategies against SAM 2 large, with timing and mask metrics. This is developer tooling, not a new automatic refinement mode. (#36)
- **SAM 3 memory.** The detector shares the tracker's backbone, cache is released after jobs, and idle models unload. Dropped engines no longer stay alive through their idle timers. Warm prompts keep their cache. (#41)
- **After Effects.** In the desktop app, open supported footage from AE in place and export objects as animated masks in a new comp. Native frame size, frame rate and frame count are checked before export. Requires [AE MCP Vision v2.2.0](https://github.com/VolksRat71/after-effects-mcp-vision/releases/tag/v2.2.0). (#24)
- **Redesign.** The Compositing Suite brings a dense timeline, grouped object layers and a review dock into one workspace. Layer colors and clearer track states make it easier to follow objects and review corrections. (#42)
- **Refine Detail, experimental.** Set `SAM_UI_REFINE_DETAIL=1` before starting the backend, then choose Experimental > Refine Detail in Studio. Box or click a small detail, refine the crop with SAM 2.1, and apply the result to the current frame only. It crops the working copy; full-resolution originals come later. Details appear in the preview, matte export and AE handoff without changing tracking, and each Apply or Remove can be undone. This tool is off by default and unavailable in the browser-only engine. (#43)

**Unsigned build:** macOS may ask you to approve the app in System Settings > Privacy & Security on first launch. See desktop/README.md for installation steps.
