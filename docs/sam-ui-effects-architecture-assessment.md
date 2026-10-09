# SAM UI Video-Effects Architecture Assessment

Repository: `VolksRat71/sam-ui`  
Repository URL: https://github.com/VolksRat71/sam-ui  
Branch assessed: `main`  
Assessment mode: read-only

## Summary

SAM UI already has a working **two-layer effects renderer** with:

- a **global background effect**
- a **per-object highlight/effect layer**
- a **shared preview/export pipeline**

The current implementation does **not** support arbitrary editable effect parameters beyond discrete `variant` selection, but it **does** have enough architectural seams to add an animated outline effect **without replacing the renderer**.

For “text behind a tracked object,” the current compositing model supports the common case through **background text + object cutout/foreground rendering**, but it is **not** a general-purpose multi-depth compositor.

---

## 1. Confirmed current architecture

### 1.1 Two-layer renderer

The render model is still fundamentally **two effect layers** inside `VideoWorkerContext`: background first, then highlight.

File: `studio/src/meta/common/components/video/VideoWorkerContext.ts`

```ts
this._effects = [
  AllEffects.Original, // Image as background
  AllEffects.Overlay, // Masks on top
];
```

Effects are then applied in order by `_processEffects(...)`.

This means the shared renderer is still:

1. draw a background effect
2. draw a highlight/foreground effect

### 1.2 sam-ui replaces Meta’s single highlight with per-object highlighting

SAM UI’s major architectural customization is in `studio/src/worker/studio.worker.ts`.

It clones Meta’s effects registry, constructs `ObjectHighlight`, and replaces `AllEffects.Overlay` with that worker-side implementation:

```ts
const metaEffects: Effects = {...AllEffects};
const overlay = new MaskOverlayEffect();
const highlight = new ObjectHighlight(overlay, metaEffects, () => ({width: context.width, height: context.height}));
AllEffects.Overlay = highlight;
```

This keeps Meta’s existing renderer structure intact while replacing the meaning of the highlight layer.

### 1.3 Preview and export use the same draw path

Preview rendering uses `VideoWorkerContext._drawFrameImpl(...)`.

Video export in `studio/src/worker/studio.worker.ts` calls `encodeMp4(...)` and passes the same draw implementation:

```ts
draw: (form: CanvasForm, index: number) => context['_drawFrameImpl'](form, index, false)
```

That confirms preview and MP4 export share the same rendering pipeline.

---

## 2. What is already implemented

### 2.1 EffectsSection UI

`studio/src/components/EffectsSection.tsx` provides:

- one panel for the **selected object’s effect**
- one panel for the **global background effect**

Confirmed behaviors:

- each object keeps its own effect until changed
- clicking the already-selected effect cycles its variants
- background effect state is driven by the worker
- the object effect buttons edit only the currently focused object

### 2.2 Effect categories exposed in the UI

From `studio/src/meta/common/components/effects/EffectsUtils.ts`:

#### Background effects

- `Original`
- `EraseBackground`
- `Gradient`
- `Pixelate`
- `Desaturate`
- `BackgroundText`
- `BackgroundBlur`
- `Sobel` (labeled “Outline”)

#### Highlight effects

- `Cutout`
- `EraseForeground`
- `VibrantMask`
- `PixelateMask`
- `Overlay`
- `Replace`
- `Burst`
- `Scope`

#### More effects

- `NoisyMask`

### 2.3 Effect registry

The actual instantiated effect classes are registered in `studio/src/meta/common/components/video/effects/Effects.ts`.

Notable points:

- `Sobel` is registered as a **background** effect.
- `BackgroundText` is a background effect.
- `Arrow` exists in the registry but is not surfaced in `EffectsUtils.ts`.

### 2.4 Per-object highlight compositor

`studio/src/worker/ObjectHighlight.ts` is the core of the per-object architecture.

Confirmed functionality:

- stores an object-to-effect map
- lazily prepares effect instances by name
- keeps a dedicated OffscreenCanvas + WebGL context per Meta GL effect
- groups objects by `effect name + variant`
- draws objects sharing an effect in batches of three masks (`META_MASK_SLOTS = 3`)
- falls back to `MaskOverlayEffect` when an object is unset or not prepared

This is the main reason per-object rendering works without replacing Meta’s renderer.

---

## 3. How effects and variants are stored

### 3.1 Per-object effect state

`studio/src/state/objectEffects.ts` defines:

```ts
export type ObjectEffect = {name: string; variant: number};
export type EffectMap = Record<number, ObjectEffect>;
```

So the persisted per-object effect model is currently just:

- effect name
- integer variant

An object with no entry is considered untouched and defaults to:

```ts
{name: 'Overlay', variant: 0}
```

### 3.2 Storage location

In `studio/src/workspace/useStudioSession.ts`, per-object effects are stored in browser local storage, keyed by video path:

```ts
const effectsKey = `sam-ui-studio:effects:${video.path}`;
```

They are parsed with `parseEffectMap(...)`, written back with `writeJson(...)`, and pushed into the worker via:

```ts
bridge?.call('setObjectEffects', {effects: objectEffects})
```

This means per-object effects are currently:

- browser-local
- per video
- not backend metadata
- not part of object seed/tracking state

### 3.3 Background effect state

Background effect state is separate.

`EffectsSection.tsx` listens for worker `effectUpdate` events and treats the worker as source of truth:

```ts
bridge.addEventListener('effectUpdate', onUpdate)
```

When the user picks a background effect, the UI sends `bridge?.setEffect(...)` instead of changing `objectEffects`.

So:

- per-object effects are stored in `EffectMap`
- background effect is managed separately through Meta’s effect API path

### 3.4 Export behavior for untouched objects

`exportEffects(...)` in `studio/src/state/objectEffects.ts` confirms that untouched objects export differently depending on the chosen mode:

- `original` → untouched objects export as `Cutout`
- `shown` → untouched objects export as `Overlay`

This is also exposed in `studio/src/components/ExportVideoModal.tsx`.

---

## 4. Whether configurable parameters are supported

### 4.1 Confirmed: variants are supported

Effects support variant counts and variant switching.

The common effect contract in `studio/src/meta/common/components/video/effects/Effect.ts` includes:

```ts
export type EffectOptions = {
  variant: number;
};
```

And the default `update(...)` implementation only updates `variant`.

Examples in the current codebase:

- `BackgroundTextEffect` has `super(2)`
- `SobelEffect` has `super(4)`

### 4.2 Confirmed: general editable effect parameters are not implemented

There is no generalized support today for effect-specific editable parameters like:

- outline thickness
- color
- blur amount
- animation speed
- text string
- per-object timing values

Evidence:

1. `ObjectEffect` is only `{name, variant}`
2. worker protocol `setObjectEffects` accepts only `{name, variant}`
3. `EffectOptions` contains only `variant`
4. `EffectsSection` only presents effect buttons, not parameter controls

### 4.3 Important nuance: frame context already supports animation data

Although editable parameter plumbing is absent, `EffectFrameContext` already includes values that effects can use for animation:

- `frameIndex`
- `totalFrames`
- `fps`
- optional `timeParameter`
- optional `actionPoint`

`VideoWorkerContext` also has logic to feed `timeParameter` during animated interactive rendering.

So the renderer already supports time-aware effects in principle; the missing piece is the state/UI/protocol layer for editable parameters.

---

## 5. Specific effect implementations relevant to this assessment

### 5.1 Sobel / “Outline”

The current “Outline” button in the UI maps to `Sobel`, which is a **background effect**, not a per-object outline effect.

In `EffectsUtils.ts`:

```ts
{title: 'Outline', Icon: AppleDash, effectName: 'Sobel'}
```

But it is listed under `backgroundEffects`.

`studio/src/meta/common/components/video/effects/SobelEffect.ts` processes the entire frame texture and draws a full-frame Sobel result. It does **not** use object masks to create per-object editable outlines.

So the current outline capability is:

- confirmed existing
- full-frame
- background-only
- variant-driven
- not an editable tracked-object outline system

### 5.2 BackgroundText

`studio/src/meta/common/components/video/effects/BackgroundTextEffect.ts` draws full-frame text over the frame using hard-coded content and two variants.

It is not user-editable text.

Confirmed behavior:

- variant 0: zooming heading
- variant 1: scrolling paragraph

This effect supports the general “text behind object” look when paired with a foreground object highlight like `Cutout`.

---

## 6. Shared preview/export pipeline

### 6.1 Shared rendering logic

Confirmed in `studio/src/worker/studio.worker.ts` and `studio/src/worker/exportVideo.ts`:

- preview uses `VideoWorkerContext`
- export uses `encodeMp4(...)`
- export calls the same internal frame renderer as preview

### 6.2 Export-specific behavior

Before export starts, the worker temporarily removes preview-only affordances:

- no active object emphasis
- no stale fading
- no preview-only hidden groups

Then it swaps in the export effects map, renders every frame, and restores preview state afterwards.

That makes effect behavior between preview and export intentionally consistent.

---

## 7. What would be required to add an editable animated outline without replacing the renderer

This section is a recommendation based on the current architecture.

### 7.1 Renderer replacement is not required

Confirmed architectural reasons:

- the renderer already supports pluggable effect classes
- `ObjectHighlight` already dispatches per-object effect rendering
- preview and export already share the same rendering path
- effect frame context already includes frame/time information

So adding an animated outline can fit within the current model.

### 7.2 Minimal implementation direction

A practical path would be:

1. add a new highlight effect class, e.g. `AnimatedOutlineEffect`
2. register it in `studio/src/meta/common/components/video/effects/Effects.ts`
3. expose it in `studio/src/meta/common/components/effects/EffectsUtils.ts`
4. include it in `HIGHLIGHT_NAMES` in `studio/src/workspace/useStudioSession.ts`
5. let `ObjectHighlight` prepare and apply it like the other per-object effects

### 7.3 What must change for editability

The main missing capability is not rendering; it is state and protocol expressiveness.

Current per-object shape:

```ts
{name, variant}
```

For editable effect parameters, the architecture would need to expand this shape, for example to include effect-specific parameter data.

That would require coordinated changes in:

- `studio/src/state/objectEffects.ts`
- local storage parsing/writing in `useStudioSession.ts`
- worker protocol definitions in `studio/src/worker/protocol.ts`
- worker handling in `studio/src/worker/studio.worker.ts`
- effect contract in `studio/src/meta/common/components/video/effects/Effect.ts`
- UI controls in `studio/src/components/EffectsSection.tsx` or a related editor panel

### 7.4 ObjectHighlight batching implications

A subtle constraint in `ObjectHighlight.ts` is that it currently groups objects by:

- effect name
- variant

and then reuses a single effect instance for that group.

If different objects need different editable outline parameters, batching would need to be updated so grouping also accounts for those parameters, or the effect would need a new per-draw parameter injection model.

That is a design extension, but still not a renderer replacement.

### 7.5 Best animation source for export parity

For deterministic preview/export matching, frame-based animation derived from:

- `frameIndex`
- `totalFrames`
- `fps`

would be the safest basis.

The existing `timeParameter` support is useful, but export already has a stable per-frame draw path, so frame-derived animation is likely the simpler fit.

---

## 8. Whether the current compositing architecture supports text behind a tracked object

### 8.1 Confirmed: yes, in the current two-layer model

The architecture supports the common “text behind a tracked object” look through:

- a background text effect
- a foreground object cutout/highlight effect

`effectPresets` in `studio/src/meta/common/components/video/effects/Effects.ts` even includes:

```ts
[
  {name: 'BackgroundText', variant: 1},
  {name: 'Cutout', variant: 0},
]
```

That confirms the intended composition pattern already exists.

### 8.2 Limitations

What is **not** confirmed in the current code:

- arbitrary multi-plane depth compositing
- front/back split text relative to multiple independently layered tracked objects
- editable text layout/content in this effects system
- a general-purpose compositor with more than background + highlight top-level stages

So the answer is:

- **yes** for the standard “background text appears behind the subject” case
- **no evidence** of a generalized layered compositor beyond that

---

## 9. Bottom line

### Confirmed current functionality

- SAM UI uses a **two-layer renderer**: background + highlight.
- The highlight layer is replaced by `ObjectHighlight`, which gives **per-object selected effects**.
- Preview and MP4 export share the **same rendering path**.
- Per-object effects are stored as **`{name, variant}` by object id**, in browser local storage.
- Background effect selection is separate and worker-managed.
- Variants are supported; generalized editable effect parameters are not.
- The current “Outline” effect is a **background Sobel effect**, not a per-object editable outline.
- The architecture already supports the common **text-behind-subject** composition pattern.

### Recommendation

If the goal is an **editable animated outline around a tracked object**, the current architecture is a workable base. The renderer does not need to be replaced. The main work would be:

- creating a new per-object highlight effect
- extending effect state beyond just `variant`
- updating batching/state/protocol/UI to support editable parameters consistently across preview and export

---

## Files referenced

- `studio/src/components/EffectsSection.tsx`
- `studio/src/components/ExportVideoModal.tsx`
- `studio/src/state/objectEffects.ts`
- `studio/src/workspace/useStudioSession.ts`
- `studio/src/worker/studio.worker.ts`
- `studio/src/worker/ObjectHighlight.ts`
- `studio/src/worker/exportVideo.ts`
- `studio/src/worker/protocol.ts`
- `studio/src/meta/common/components/effects/EffectsUtils.ts`
- `studio/src/meta/common/components/video/VideoWorkerContext.ts`
- `studio/src/meta/common/components/video/effects/Effect.ts`
- `studio/src/meta/common/components/video/effects/Effects.ts`
- `studio/src/meta/common/components/video/effects/BackgroundTextEffect.ts`
- `studio/src/meta/common/components/video/effects/SobelEffect.ts`
- `studio/src/meta/common/components/video/effects/shaders/Sobel.frag`
