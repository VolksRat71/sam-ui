# Compositing Suite implementation evidence

Branch: `design/compositing-suite`. Prototype: `http://localhost:7381`.

The approved direction combines composition B's dense timeline and C's Review dock. The real footage and existing capabilities remain authoritative. Generated comps are local review references; none ship in the application.

## Commits in requested order

| Step | Commit | Change |
| --- | --- | --- |
| layout | `1abd4ea` | Docked viewer/inspector; timeline owns layer rows and lane marks. |
| distill | `4db10f8` | Compact summaries; selected layer controls in Layer info. |
| harden | `5ddbc40` | Roving selection, lane keyboard access, live status, canvas label, shortcut sheet. |
| clarify | `d5ea4cb` | Display-only review spans, thresholds, sorting, score scale and layer acceptance controls. |
| typeset | `8ccb7d3` | Local Inter roles, 12px labels, tabular numbers, desktop/touch targets. |
| polish | `3a2cf38` | Effect-independent matte status and neutral group chrome. |
| review corrections | `74bc770` | Visible Review queue, compact timeline toolbar, raster origin metadata. |

## Validation

- Before every source commit: `npm test`, `npm run lint`, `npm run build` in `studio` passed. Final source result: 350 tests across 39 files. Vite reports its existing large-chunk warning.
- Isolated Playwright captures inspected both supplied clips at 1536×1024, 1280×800, 768×1024 and 390×844. The browser routes blocked annotation-write endpoints; no blocked writes were attempted.
- Both clips passed keyboard layer selection, Enter-to-inspector focus and shortcut-sheet dismissal checks. Each list exposed one roving tab stop. The measured label floor excluded only ruler ticks.
- Final fashion layout exposes ten full layer rows at 1536 and six at 1280. Review exposes three and two full queue rows respectively. Other rows remain scrollable; all 16 layers remain present.
- Reviewer-directed fixes used two rounds. The independent final verdict is in `finish-verdict.md`; no further cosmetic iteration followed it.
- Three existing Meta PNGs carry embedded origin metadata. IHDR, palette, image-data and transparency chunks match their pre-edit payloads exactly. The raster provenance scan found zero missing origins.

The UI displays Changed/Tracking status outside the canvas, independent of the selected effect. A display mapping also recognizes a future Refining state. This does not add that state to the tracking model or change correction semantics.

## Scope and limits

No tracking jobs, corrections, annotation edits, grouping changes, exports, or Start over actions were exercised against Nate's objects. Production servers and the pre-existing scratch backend/studio were not restarted. UI verification used the separate authorized studio on 7381. No PR or merge was created.

Capture logs include empty-string page errors and aborted media GETs during decoding/navigation. Screenshots loaded correctly; this evidence does not establish that those errors are resolved. Destructive/backend workflows were not end-to-end tested on protected data.

Measurement, plate, hero and responsive fidelity gates were not completed before implementation. On 2026-10-01 Nate explicitly authorized, relayed by Claude: "Waive: comps were guidance." Generated A/B/C comps are composition guidance for the live prototype; measured comp-reproduction gates are waived for this build. The build state records those requirements as closed by waiver, preserving the failed gate history rather than claiming measurement success. The independent reviewer resolved both visual findings; this explicit scope decision resolves the sole remaining process finding. Final disposition: `ship` within the live-prototype scope.

Screenshots, capture scripts and comp prompts remain local evidence under `.impeccable/`; screenshots containing user footage are not committed. Reports to Claude use the approved mailbox channel, never tmux keystrokes.

The build state is committed with Nate’s explicit scope decision. The CLI force validator rejected the supplied waiver wording twice, and its finish command still required the waived responsive-gate fingerprint. The authorized waiver and final `ship` disposition were recorded directly, without fabricating passing measurements. No application sources changed after the final reviewed captures.
