---
version: 1
slug: "studio-src-app-tsx"
primary_target: "studio/src/App.tsx"
related_targets: []
---

# Surface brief: sam-ui studio workspace

Scope: the whole studio workspace (studio/src), desktop-first, with a reduced phone and tablet layout. Mode: Operate. Product truth lives in PRODUCT.md. Replaces the 2026-10-01 "Compositing Suite" direction (redesign confirmed by Nate 2026-10-11 after the critique in .impeccable/critique/2026-10-11T21-29-28Z__studio-src-app-tsx.md).

Audience and job: a compositor or motion designer cutting mattes from real footage, often beside After Effects on a second screen, 5 to 16+ layers, long sessions; standalone use without AE is first-class. Task: click a subject, track, check only what needs a person, export mattes or send to a new AE comp. Proof: the matte on real footage at full size, with the system marking only the frames worth a look.

Confirmed decisions (Nate, 2026-10-11): AE's working model with sam-ui's own identity; viewer is the hero; effects are secondary to mattes ("Looks", folded per layer); one stage-aware screen (Select, Track, Looks, Export); review is ambient, not a stage or a queue ("most of the reviews are redundant and dont really do a good job of pointing out what should get human eyes, the tool is supposed to make masking and effects easy not ask someone to sit in a review queue for 40% of their project"); a sprocket filmstrip is wanted; adopt AE keys (J/K frame step, [ ] layer in/out, solo/lock).

## Direction contract

THESIS: Every layer is a coverage line. Studio reads like a script supervisor's lined script laid under a camera gate: the matte on the footage is the one big thing, and each layer's state is a pen line you read at a glance. It refuses the category default of Adobe-grey docked panels with an always-open review queue and an effects grid competing with the footage.

OWN-WORLD: Slate black chrome (#141517 ground, #1f2124 panels), chalk-white type (#ecebe6), grey secondary (#8d8f94); amber #f2c14e only for inspection marks, blue #3d8bfd only for Track and the playhead; every other colour belongs to a layer's matte (swatch, lane, overlay). One-pixel rules everywhere; camera-gate corner brackets and safe-area ticks around the viewer; grease-pencil circles are the only hand-made mark; a diagonal clapper stripe marks the Track action and nothing else; a sprocket-edged filmstrip; tabular timecode set large.

STORY: The compositor sees the clip slated (name, size, fps, frame, timecode, AE link when linked), clicks a subject, presses Track and watches the coverage lines draw as frames come back. Flags appear only where a person is needed, circled on the lane and the filmstrip; a jump to one always shows that layer's matte clearly. They fold a Look under a layer when they want one, then export or send to AE. They trust it because nothing is invented and every mark is exactly as long as its frames.

FIRST VIEWPORT: Slate header strip across the top (clip, 1280x720, 24 fps, frame, very large timecode, AE link, Export). Viewer inside camera-gate frame lines, about 65-70% of height, left of a narrow property column that follows the stage (matte view toggles Overlay/Alpha/Edge/Dim others, selected layer, folded Looks, engine + Track). A sprocket filmstrip centred on the playhead between viewer and ruler. Below, the timeline: frame ruler, one lined-script coverage line per layer (straight = matte holds, wavy = absent, dotted = unconfirmed), keyframe diamonds, 2-3 grease-pencil flags. Track sits with the engine picker, the only striped control.

FORM: The Lined Script (on-set production notation: slate, camera report, script supervisor's lined script), #3 on the grounded list, assigned by the roll; raised by Data Field (strict chrome, colour only in mattes), Factory Sleeve (one plot owns the field), Dance Score (exact-length marks, shape carries state), Bitmap Specimen (pixel honesty past 200%), Reference Setting (one-pixel rules). Seed key e93c7d35.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Comp round

Approved comp: .impeccable/mocks/comp-1.png (the decision render; Codex image_gen, 2026-10-11), approved by Nate in the three-option round. Recorded addition, Nate's answer "Option 1 + filmstrip (Recommended)": the sprocket filmstrip is added between viewer and ruler as in .impeccable/mocks/comp-2.png (that band only is the reference; comp-2's other drift, such as the missing clapper stripe, does not carry). The viewer may shorten only by the filmstrip's height. The filmstrip carries the grease-pencil flag circles on inspection frames. Options 2 and 3 are spent alternatives; option 3's stage tabs and mid-track state are not approved.

## Open decisions (builders must not invent)

- Review-flag quality (fewer, better flags) is an engineering task on the review heuristics, separate from this UI work.
- Phone and tablet layout follow once desktop is approved.
- Exact AE key map and what today's clashing keys move to.
- Figma kit (Astra) rebuild against this brief needs Nate's explicit resume.
