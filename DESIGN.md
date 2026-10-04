---
name: "sam-ui Compositing Suite"
description: "A neutral, docked workspace for precise matte review and correction."
colors:
  primary: "#2d8ceb"
  focus: "#78b8f5"
  warning: "#e8b339"
  bg: "#1b1b1c"
  panel: "#262628"
  panel-raised: "#303033"
  line: "#3a3a3d"
  text: "#f1f1f3"
  text-muted: "#aaaab0"
  lane-ink: "#b8b8c0"
  selection: "#2d8ceb55"
  field-bg: "#000000"
  white: "#ffffff"
typography:
  title:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
  control:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  ruler:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  square: "0px"
  control: "2px"
  overlay: "12px"
spacing:
  micro: "4px"
  compact: "8px"
  control: "12px"
  section: "16px"
  dialog: "20px"
components:
  button-track:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.white}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "28px"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "34px"
  button-subtle:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "34px"
  field:
    backgroundColor: "{colors.field-bg}"
    textColor: "{colors.white}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "32px"
  dock-header:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "0 12px"
    height: "32px"
  badge-changed:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "1px 8px"
  workspace-pane:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.square}"
  layer-row:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "0 8px"
    height: "28px"
  review-stop:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "4px 6px 4px 4px"
  matte-status:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    padding: "6px 12px"
---

# Design System: sam-ui Compositing Suite

## Overview

**Creative North Star: "Compositing Suite"**

Compositing Suite uses the familiar visual grammar of After Effects and Nuke: neutral docked panels, compact controls, frame marks, and a timeline that also serves as the layer list. It supports long sessions beside footage without competing with that footage.

The approved dense timeline and Review dock are expressed through aligned rows, explicit state labels, and restrained blue interaction cues. Amber directs inspection. The interface makes changed mattes visible in the viewer chrome as well as the timeline, so effect selection cannot hide the need to refresh them.

**Key Characteristics:**

- Neutral panel greys with one blue interaction accent and amber inspection marks.
- Square workspace panes, thin seams, compact layer rows, and tabular readouts.
- A timeline that owns layer selection; a fixed dock for review, properties, effects, and media.
- Explicit Changed, Refining, and Tracking language that remains visible outside the effect image.

This is a source-derived record of the current workspace, not a finish verdict. On 2026-10-01 Nate explicitly waived measured comp reproduction for this build: "Waive: comps were guidance." The comps guide composition; the finish verdict assesses the live prototype. Source authority is the CSS cascade (`styles.css`, then `responsive.css`, then `suite.css`) and the implemented components; the approved surface brief supplies the direction. No worker or correction behavior is specified here.

## Colors

The palette is a low-glare neutral surround, with colour reserved for layer identity, interaction, and inspection; normative values are in the frontmatter.

### Primary

- **Interaction blue** (`primary`) identifies Track, the playhead, active work, and positive point controls.
- **Focus blue** (`focus`) identifies keyboard focus and updating labels; **selection wash** (`selection`) serves text selection.

### Secondary

- **Inspection amber** (`warning`) identifies review markers and the work area. It is a semantic signal, not a second decorative brand colour.

### Neutral

- **Workspace ground** (`bg`) surrounds **panel grey** (`panel`). **Raised grey** (`panel-raised`) distinguishes grouped controls and status areas.
- **Seam grey** (`line`) separates docked regions and layer rows.
- **Primary text** (`text`) and **secondary text** (`text-muted`) distinguish instructions from supporting metadata.
- **Layer ink** follows the layer’s mask color in the swatch, frame lane, and Overlay preview. The `lane-ink` token is a neutral fallback. Group swatches use their saved group color. Layer info lets users choose a mask color or reset it; overrides are saved per clip in this browser.
- **Field black** (`field-bg`) and **white** (`white`) remain in fields and selected/focused control treatments.

**The Semantic Accent Rule.** Use blue for interaction and active work; use amber for review marks and the work area. Keep panel chrome neutral; use matching mask colors to identify layers.

## Typography

**Body and interface font:** locally served variable Inter, with the fallback stack recorded above. The local font file supports weights 100–900 and uses `font-display: swap`; the workspace uses ordinary interface weights rather than a display face.

### Hierarchy

- **Title:** the title role is used by the shortcut sheet. Existing export and confirmation modal headings also use a smaller (18px) semibold heading.
- **Body:** reading text and general interface content.
- **Control:** buttons, selects, fields, and compact actions.
- **Label:** layer names, status badges, section headings, review descriptions, counts, and timeline support text. Section headings use semibold weight and subtle tracking (0.01em).
- **Ruler:** timeline numerals only. Frame counters, badges, numeric inputs, review scores, and layer summaries use tabular numerals.

Review descriptions wrap with line-height (1.45); review scale explanations use line-height (1.5) and a maximum measure (65ch). Compact text fields and selects increase to (16px) to support touch entry.

**The Readable Density Rule.** Keep operational labels at the label role or larger; reserve the ruler role for ruler numerals. Use tabular numerals for changing frame values, counts, and scores.

## Layout

The desktop workspace begins at (1024px). Its resizable top region defaults to (40%) of the available pane height; the full-width timeline receives (60%). The upper region divides into viewer (65%) and dock (35%). Persisted user sizes can override these defaults. This implements the approved dense-timeline composition, superseding the earlier surface-brief height estimate.

The dock order is Review, Layer info, Effects, Media. Review and Layer info open by default; Effects and Media start collapsed. The timeline aligns each layer summary with its frame lane under a sticky ruler. Desktop layer rows are (28px), and the timeline's action/transport controls also use that compact height. The general fine-pointer target floor is (24px), not the height of every button. Main pane dividers are (4px); seams are (1px).

Below the desktop breakpoint, the dock becomes tabs and split handles disappear. Controls and layer rows have a (44px) target floor on coarse pointers or compact widths. The upright compact layout stacks viewer, timeline, and dock. Between phone and desktop widths, landscape layouts can place the dock beside the viewer and timeline; short landscape layouts can place the viewer beside timeline and dock. The final suite override below (600px) always returns to a single column, with current viewer/timeline/dock tracks of (230px / 460px / 350px), scrolling as needed. Those fixed phone tracks are an implementation constraint, not a reusable sizing requirement for future surfaces.

Spacing is built primarily from the compact, control, and section steps, with the micro step between related actions. Dock body padding is currently (10px); dialogs use the dialog step. Review actions precede the queue; optional review details share its scroll region. Desktop Review content has a bounded scroll region (`min(340px, 34vh)`) so the rest of the dock remains reachable.

## Elevation & Depth

The workspace uses tonal layering and seams rather than card shadows. Layer rows, viewer, timeline, and dock remain flat. Existing floating menus, toasts, and dialogs retain shadows; they are transient overlays, not the structural model for workspace panels. The sidecar records their exact shadows. Focus rings and marker outlines communicate state rather than elevation.

**The Docked Surface Rule.** Keep the viewer, dock, timeline, and their rows flat and square. Floating menus and dialogs retain their existing elevation.

Short state transitions remain on dividers and job progress. Reduced-motion styles remove those transitions, and existing engine activity animation has its own reduced-motion treatment. Do not add decorative movement to the editing surface.

## Shapes

Workspace panes and timeline/review rows are square. Controls and status tags use the control radius; the Changed badge has a dashed border. Click keyframes are diamonds, review marks are amber, and frame spans use fill and line treatment to convey state. Changed spans are transparent with a dashed outline; updating spans reduce opacity. Retain the existing semantic span patterns instead of inventing a new marker alphabet.

Transient modal and compact menu surfaces retain the overlay radius. Media dropzones and toasts retain their smaller rounded forms. These exceptions do not establish rounded workspace cards.

## Components

### Track button

A compact, solid blue command beside the engine picker in the timeline. It uses semibold type, the control radius, and a brightness change on hover. Disabled actions reduce opacity. The canonical snippet describes the desktop timeline variant; compact/coarse layouts increase its target.

### Secondary and subtle buttons

Secondary actions have a neutral panel fill and seam border; subtle actions use a transparent fill. Hover raises the fill to seam grey, focus uses the shared blue ring, and disabled controls reduce opacity. The existing danger button is neutral in the suite; destructive meaning must remain in its wording and confirmation flow.

### Fields

Black inputs with white text, a seam border, and compact padding. Focus uses the shared ring and blue caret. Supporting labels use secondary text. Touch fields increase both target size and type size.

### Dock navigation

Desktop section headers are full-width square twirl-down buttons with semibold labels. Compact navigation uses a single row of tabs with a white selected underline. Sections stay mounted when hidden, preserving their local state.

### State badges

Small, nearly square labels pair words with border treatment. Changed uses a dashed neutral border; Refining and Tracking use the updating blue border and focus-coloured text. Ready and untracked labels remain neutral. The display mapping translates internal stale to Changed without changing tracking behavior.

### Workspace panes

Viewer, dock, and timeline are flat containers on panel grey with square corners and clipped internal overflow. Their rows and seams establish hierarchy; they are not freestanding cards.

### Layer rows and frame lanes

Each row combines a narrow swatch, ellipsized layer name, state badge, and aligned temporal lane. Selection adds a light blue wash. The lane has a blue playhead, mask-colored span ink, and diamond keyframes. Grouped labels are indented beneath their group while all frame lanes retain the same origin. The selected layer's editable detail and Mask color control live in Layer info. Color changes redraw the preview without changing masks, clicks, ranges, or tracking jobs.

### Review stops

A compact queue row has an amber marker, frame/layer information, a score when available, and wrapping explanatory text. The current stop has a white border; hovered non-current rows gain a stronger neutral border. Keyboard focus remains visible on the jump action. Current-stop actions stay above the queue, with secondary options behind disclosure.

### Viewer matte status

A full-width status strip sits in the viewer chrome before the effect stage. Changed uses dashed seams; Updating uses solid blue seams. It names the affected layer or changed-layer count and explains the next action. This status is independent of the selected visual effect and uses an announced status region.

## Do's and Don'ts

### Do:

- Do preserve the fixed Review, Layer info, Effects, Media dock order.
- Do use the shared focus ring and keep focus visible inside scrolling rows.
- Do show Changed with a dashed badge and dashed cached span; show Refining or Tracking in viewer chrome independently of the active effect.
- Do retain the larger compact and coarse-pointer targets while keeping desktop layers dense.
- Do preserve Meta credits and asset provenance without adopting Meta branding as the studio identity.

### Don't:

- Don't use layer colors as decorative chrome, gradient action borders, or rounded cards around the workspace panes.
- Don't make colour the only signal for a matte state or an inspection mark.
- Don't use internal stale or seed terminology as the main user-facing state label.
- Don't promote legacy history colours or unfinished state designs into new system rules.

Not canonized or repaired in this document: legacy hard-coded engine-history colours and older source comments that describe the pre-suite layout. These are drift, not authority for new visual rules. Raster provenance is maintained in the existing icon files; this document does not replace those embedded origins or alter asset pixels.

### Follow-up interaction review — 2026-10-02

Shift, Ctrl, or Cmd plus wheel zooms at the pointer; unmodified wheel pans. Shift events remapped to the horizontal axis also zoom. The engine chooser floats outside clipped panes, fits the viewport, focuses the selected engine, and returns focus to its trigger on Escape.

Nate’s follow-up feedback explicitly restores mask-color correspondence and grouped-label indentation. This supersedes the earlier neutral-lane guidance; the 2026-10-01 comp-guidance waiver remains in force. See `.impeccable/review/2026-10-02-audit.md` for verification and limits.

## Landed-stack presentation — 2026-10-04

Correction messages use the neutral panel surface, wrap their exact contractual copy and actions, and stop events before they reach the preview. Each frame lane has an accessible actions menu for marking absence from the playhead. Menus stay inside the viewport and return focus on Escape or activation. Coarse-pointer controls retain 44px targets at desktop widths. The Review dock mounts once. See `.impeccable/review/2026-10-04-integration.md` for isolated-fixture evidence and checks. Nate’s October 1 comp-guidance waiver remains in force.
