<!-- sam-ui (Apache-2.0). New file, not from SAM 2. -->
# Features

Everything sam-ui does, area by area. How each control in studio works is in
[Using studio](using-studio.md).

## Track

- **Click and Track.** Click an object for a positive point, right click for a
  negative, and press Track. Track runs only the objects that are untracked or whose
  clicks changed. Tracked objects never re-run, and their masks stay on screen.
- **Three engines.** SAM 2.1 large (the default, and the one clicks go through),
  SAM 3's video tracker (optional, loaded on first use) and SAM 2.1 tiny in the
  browser. Each engine's track is cached separately, and studio marks the frames
  where SAM 2 and SAM 3 disagree.
- **Find by text (SAM 3).** Type a phrase ("dog", "the red cup") and SAM 3's
  detector segments it **on the frame on screen**. The best match becomes that
  frame's mask, as if clicked, and the object tracks from it with any engine. It is
  a seed for one frame, not a search of the whole clip. When several things match it
  says how many and takes the best. SAM 2 and the browser engine take clicks only.
- **Keep working while it tracks.** Clicks come back in about 0.1 s while a job runs.
  Jobs can overlap, and each has its own cancel.
- **Long clips.** Uploads take up to 5 minutes and 2 GB; a longer clip keeps its
  start, and studio says so before it uploads. In the app, an upload becomes a working copy at
  24 fps, fitted within 1280x720 and never upscaled. Video is decoded with PyAV as
  tracking and playback reach each frame, so memory stays flat however long the clip
  (see [Hardware](hardware.md)). Image features are cached per video, so a re-track skips
  the backbone (about 35% faster, same masks).

## Correct

- **Corrections refine the mask.** Click on any frame to fix it, and the next Track
  uses your corrected mask there. A negative click, sent with a positive on the part
  to keep, cuts away only the region it is on; a lone positive adds one. On SAM 2 a
  negative with no positive on the frame is not sent: studio asks you to add a
  positive, or to switch to SAM 3, where a lone negative empties the frame.
- **Bounded re-tracking (SAM 2).** A correction re-tracks a stretch around the
  corrected frame and keeps the cached track beyond it. The pass stops once ten frames
  in a row agree with the cache (IoU above 0.98). On the gallery dog clip (289
  frames), a fix on frame 148 re-tracked 31 frames in 7.5 s, against 130 s for a full
  re-track. SAM 3 and the browser engine re-track the whole window for now.
- **Absent ranges.** Drag across an object's lane and **Mark absent** where it leaves
  the shot. Those frames stay empty in the preview and every export, the tracker
  skips them, and each side of the gap tracks only from its own clicks. A positive
  click inside the range means the object is back, so the range ends on the frame
  before it; clicks there with no positive are refused. **Gone for a while?**, offered
  after a lone negative, marks the object absent until its next click.
- **Undo and kept versions.** Cmd-Z and Shift-Cmd-Z undo and redo clicks, cleared
  frames and range edits. The last 10 tracks per object and engine are kept, so going
  back to the clicks that made one restores it from disk with no re-track. **Versions**
  lists them by time, engine and click count. **Move these clicks to** hands a frame's
  clicks to the right object.

## Review

- **Review queue.** Each track gets a short, ranked list of stops worth a look,
  computed from the cached masks with no model run: where the engines disagree, where
  the track starts, stops or the object comes back, where the mask jumps or splits,
  the seams of a bounded re-track, candidate starts, and frames you flagged with F.
  Step through them with . and , and press Y (**Looks right**) to mark one reviewed. A
  re-track reopens only the stops it changed.
- **Candidate, present and absent.** Each frame of an object is unknown, a candidate
  (a tool thinks the object is there, with its source and score), confirmed present,
  or confirmed absent. Review a candidate as Present, Absent or Reject (P, A, R). Only
  absent changes tracking. Candidates are written through the API
  (`setObjectCandidates`); sam-ui does not yet find objects across a clip on its own.

## Organise

- **Objects.** Up to 16 per video by default, each with a name you edit in place.
  Exports use the names.
- **Groups.** Drag objects to reorder them or into named, coloured groups. A group
  can track, clear, take one effect, hide from the preview and ungroup. The order is
  the timeline's and every export's. Reordering never makes a track stale.
- **The workspace.** The preview, a dock with Review, Layer info, Effects and Media,
  and a timeline with a lane per object. Press ? for the keyboard shortcuts.
- **Phones and tablets.** Studio stacks its panes on small screens, with tap to add a
  point, long press for the other kind, and pinch to zoom. It has been checked in
  Chrome's device emulation only, and Android Chrome shows a blank preview for now
  ([#1](https://github.com/VolksRat71/sam-ui/issues/1)).

## Export and After Effects

- **Exports.** Each records the engine and model that made it, and lists every range
  with its state.
  - **Mask videos:** one black and white MP4 per object, in a zip.
  - **Vector JSON:** per-frame outlines (pieces and holes) per object, for After
    Effects masks.
  - **Roto working folder:** `products.json`, `anchors.json`, `shots.json`, the review
    queue and per-object PNG mattes, optionally with the frames.
  - **Video:** an MP4 with each object's effect, encoded in the browser.
  - Groups become folders, with an optional union mask per group.
- **After Effects round trip** (desktop app, with
  [AE MCP Vision](https://github.com/VolksRat71/after-effects-mcp-vision) v2.2.0):
  - **Media > Open from After Effects** lists the footage in the open AE project and
    opens it where it is, with no upload and no re-encode, so frame N in sam-ui is
    frame N in AE. It takes unmodified .mp4 and .mov footage with square pixels, no
    proxy and no Interpret Footage overrides. Image sequences are not supported yet.
  - **Export > Export to After Effects** makes a new comp at the footage's own size,
    frame rate and duration: the footage as a guide layer, and one layer per object,
    named after it, with its outlines as mask-path keys. The footage is checked again
    before anything is written. Save the project in AE to keep it.
  - Export to After Effects is offered only for footage opened from After Effects.
    For an uploaded clip, use the Vector JSON or the roto folder.

## Experimental

- **Refine Detail** (off by default). Set `SAM_UI_REFINE_DETAIL=1` before starting the
  backend (for the app, `launchctl setenv SAM_UI_REFINE_DETAIL 1`, then restart it),
  then choose **Experimental > Refine Detail**. Box or click a small detail, add
  include and exclude points, then Refine and Apply. It works on the current frame
  only and crops the working copy, not the original; full-resolution refinement comes
  later. Details add to a non-empty tracked mask, show in the preview, matte exports
  and the AE export, and never feed tracking. Each Apply or Remove is one undo. The
  browser engine does not have it.
