---
version: 1
slug: "studio-src-app-tsx"
primary_target: "studio/src/App.tsx"
related_targets: []
---

# Surface brief: sam-ui studio workspace

Scope: the whole studio workspace (studio/src), desktop-first, with a reduced phone and tablet layout. Mode: Operate. Product truth lives in PRODUCT.md.

## Direction contract

THESIS: Studio is the roto panel After Effects never had. It's a docked compositing workspace where the timeline IS the object list, and every state is a mark a compositor already reads. It refuses the category default: a dark ML-demo page with a sidebar stack of collapsible cards beside a video.

OWN-WORLD: Neutral panel greys calibrated to an 18% grey surround (about #1b1b1c ground, #262628 panels, #3a3a3d seams and raised, #9a9a9e secondary text). One interaction accent, AE-style blue #2d8ceb. One marker colour, amber #e8b339, used for review markers and the work area only. The footage is the only saturated thing on screen.
- Panels: docked, with 1px seams; no rounded cards or shadows.
- Numbers: tabular timecode and counts.
- Marks: layer bars with frame-exact lengths, where fill carries state (solid tracked, hatched absent, dotted candidate, bracket present), plus keyframe-style diamonds for clicks.
- Object colours: neighbouring lanes never share an ink.
- Retired: the rainbow, gradient borders, and the Meta palette.

STORY: The compositor sees the whole clip's objects as layers and knows their state at a glance. They press `.` to go where attention is needed, fix it with one click or mark it absent, then send exact mattes to a new AE comp. They trust it because nothing is invented and nothing moves without saying why.

FIRST VIEWPORT:
- Upper left (about 65% width, 60% height): the comp viewer with its toolbar.
- Upper right: a docked Info/Review panel showing the current review stop (frame, layer, reason, "Looks right (Y)", next/prev), the selected layer's properties and effects as twirl-downs, and media below as a collapsible bin.
- Bottom, full width: the timeline. A time ruler carries review markers. Below it, one layer row per object: swatch, name, solo, lock, group twirl-down and a state badge, with lane bars to the right.
- The primary action, Track, sits in the timeline header beside the engine picker, not in a rainbow pill.

FORM: Compositing Suite (After Effects/Nuke workspace grammar). It is the user's pinned direction and #1 on the grounded list. Raised by the grading suite (neutral discipline), the gate board (reopened stops stay lit until seen), the dance score (frame-exact marks, fill as state) and the transit diagram (neighbouring inks differ). Seed key 82050ff8.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Approved composition

Nate approved `.impeccable/mocks/composition-b.png` for the dense timeline, combined with `.impeccable/mocks/composition-c.png` for the Review dock (2026-10-01, relayed by Claude). Generated footage and invented controls are illustrative only; preserve the real footage and existing capabilities. Stale/refining track status must remain legible with every effect; correction behavior belongs to Claude.
