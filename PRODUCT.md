# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (studio is a React/Vite app; the desktop app is Electron around the same studio, and a browser-only build runs on GitHub Pages)

## Users

Open source and broad, from anyone who downloads the desktop app to anyone who opens the browser demo. The core user the design leans toward is the compositor or motion designer, who rotoscopes objects in real footage (products, wardrobe, props) and hands mattes to After Effects. They work long, precise sessions, often on two screens beside AE, on clips with many objects (16 or more).

## Product Purpose

Interactive video segmentation with SAM 2 and SAM 3. You click or type to mask objects, track them through a clip, correct and review the result, and export mattes, vectors or a roto folder, or send them straight to a new After Effects composition. Success means trustworthy mattes on the right frames, with the least human inspection.

## Positioning

- **Rotoscoping that respects intent.** Clicks refine what is there and absence is explicit. Nothing is invented on the user's behalf, and undo is instant.
- **Review where it counts.** The app directs attention to the frames worth checking, instead of asking for every frame to be inspected. Human attention is the measure.
- **A round trip with After Effects.** Footage opens in place from the AE project, frame for frame, and masks come back as a new comp on the same frames.

## Commitments

- Dark UI: video work needs a neutral, low-glare ground beside After Effects.
- Accessibility at WCAG AA, plus a complete keyboard path. Status changes are announced and no text is tiny.
- Keep the SAM 2 Apache-2.0 notices and the Meta credits. Do not use Meta's branding as the studio's own identity.
- Desktop-first. Phones and tablets are supported with a usable, reduced workflow.

## Terminology

The working vocabulary should be After Effects': matte, roto, keyframe, layer, comp. Internal terms ("stale", "candidate", "seed") need a plain equivalent wherever users see them.

## Open decisions

- How far the visual identity moves toward After Effects (decided in the shape / new-work direction round, not here).
