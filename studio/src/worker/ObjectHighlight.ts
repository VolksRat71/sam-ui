// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The effects layer in studio's worker: every effect clip active on a frame
// (state/effectClips.ts). Meta's demo applies one highlight effect to all
// objects; here background clips are drawn first (over the plain frame
// Meta's background slot draws), then each object in Layers order, bottom
// first, with its own clips by row, higher rows on top. An object with no
// clip on the frame gets studio's many-mask Overlay in the preview, and in an
// export what the export dialog chose. The same code draws the preview and
// the video export; an export draws its canvas from its own copy of the
// clips, so edits and selection during an export only reach the preview.
//
// Meta's GL effects each get their own OffscreenCanvas and WebGL context (an
// effect assumes its program and buffers stay bound between frames, so two
// cannot share one context). One effect instance serves every clip that uses
// it: its params (and the variant its style names) are set before each draw,
// and effects read every setting on every draw. Meta's shaders hold three
// masks, so consecutive objects sharing an effect and settings are drawn three
// at a time; the effects are transparent outside their masks, so the passes
// composite.
import type {
  Effect,
  EffectFrameContext,
  EffectParams,
} from '@/common/components/video/effects/Effect';
import {AbstractEffect} from '@/common/components/video/effects/Effect';
import {styleIndex} from '@/common/components/video/effects/EffectParamSpecs';
import type {Effects} from '@/common/components/video/effects/Effects';
import type {Tracklet} from '@/common/tracker/Tracker';
import type {CanvasForm} from 'pts';
import {
  EMPTY_DOC,
  type EffectDoc,
  ORIGINAL,
  OVERLAY,
  type UntouchedMode,
  activeClips,
  clipTime,
  normalizeParams,
} from '~/state/effectClips';
import type MaskOverlayEffect from './MaskOverlayEffect';

/**
 * What a canvas is drawn from. `untouched` null is the preview: objects with
 * no clip get the Overlay, editing aids show and hidden groups stay off.
 */
export type DrawState = {doc: EffectDoc; drawOrder: number[]; untouched: UntouchedMode | null};

type Pass = {effect: string; params: EffectParams; time?: number; key: string; idx: number[]};

const META_MASK_SLOTS = 3;
/** The Overlay and Original's first styles: an untouched object's look. */
const TINT = normalizeParams(OVERLAY, {});
const UNCHANGED = normalizeParams(ORIGINAL, {});

/** Params as a key: equal settings, equal key, whatever their order. */
function canonical(params: EffectParams): string {
  return JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export default class ObjectHighlight extends AbstractEffect {
  /** Objects kept off the preview (a hidden group's members; never off an export). */
  public hidden: (objectId: number) => boolean = () => false;
  private _preview: DrawState = {doc: EMPTY_DOC, drawOrder: [], untouched: null};
  /** Canvases drawn from a state of their own (an export's), not the preview's. */
  private _forms = new WeakMap<CanvasForm, DrawState>();
  private _ready = new Map<string, Effect>();

  constructor(
    private readonly _overlay: MaskOverlayEffect,
    private readonly _meta: Effects,
    private readonly _size: () => {width: number; height: number},
  ) {
    super(1);
  }

  /** The preview's clips and layer order (object ids, bottom layer first). */
  async setDoc(doc: EffectDoc, drawOrder: number[]): Promise<void> {
    this._preview = {doc, drawOrder, untouched: null};
    await this.prepare(this._preview);
  }

  /** Set up every effect `state` draws with (those it names that are not registered draw as the Overlay). */
  async prepare(state: DrawState): Promise<void> {
    const names = new Set(state.doc.clips.map(c => c.effect));
    if (state.untouched === 'original') {
      names.add(ORIGINAL);
    }
    names.delete(OVERLAY);
    for (const name of names) {
      await this._prepare(name);
    }
  }

  /** Draw `form` (an export's canvas) from `state`, leaving the preview's state alone. */
  drawWith(form: CanvasForm, state: DrawState): void {
    this._forms.set(form, state);
  }

  /** Set up Meta's effect `name` on a WebGL context of its own, once. */
  private async _prepare(name: string): Promise<void> {
    if (this._ready.has(name)) {
      return;
    }
    const effect = this._meta[name as keyof Effects];
    const {width, height} = this._size();
    if (effect == null || width < 1 || height < 1) {
      return; // unknown, or the video is not decoded yet: drawn as Overlay until then
    }
    const canvas = new OffscreenCanvas(width, height);
    const gl = canvas.getContext('webgl2');
    await effect.setup({width, height, canvas, gl: gl ?? undefined});
    this._ready.set(name, effect);
  }

  apply(form: CanvasForm, context: EffectFrameContext, tracklets: Tracklet[]): void {
    const state = this._forms.get(form) ?? this._preview;
    const preview = state.untouched == null;
    const frame = context.frameIndex;
    const active = activeClips(state.doc, frame);
    const passes: Pass[] = [];
    // one pass per clip, merged with the pass below when it is the same effect
    // and settings (three masks at most for Meta's shaders, any for the Overlay)
    const add = (effect: string, params: EffectParams, time: number | undefined, i: number | null) => {
      const t = effect === OVERLAY ? undefined : time;
      const key = `${effect}\u0000${canonical(params)}\u0000${t ?? ''}`;
      const last = passes[passes.length - 1];
      if (
        i != null &&
        last?.key === key &&
        last.idx.length > 0 &&
        !last.idx.includes(i) &&
        (effect === OVERLAY || last.idx.length < META_MASK_SLOTS)
      ) {
        last.idx.push(i);
      } else {
        passes.push({effect, params, time: t, key, idx: i == null ? [] : [i]});
      }
    };

    // background clips by row; an effect this build lacks leaves the plain frame below
    for (const c of active) {
      if (c.target.kind === 'background' && this._ready.has(c.effect)) {
        add(c.effect, c.params, clipTime(c, frame, context.fps), null);
      }
    }

    // objects with a mask on this frame, bottom layer first (ids the order does not name yet go below it)
    const at = new Map(tracklets.map((t, i) => [t.id, i]));
    const listed = new Set(state.drawOrder);
    const ids = [...tracklets.map(t => t.id).filter(id => !listed.has(id)), ...state.drawOrder.filter(id => at.has(id))];
    for (const id of ids) {
      if (preview && this.hidden(id)) {
        continue;
      }
      const i = at.get(id)!;
      const mine = active.filter(c => c.target.kind === 'object' && c.target.id === id);
      if (mine.length === 0) {
        const original = state.untouched === 'original' && this._ready.has(ORIGINAL);
        add(original ? ORIGINAL : OVERLAY, original ? UNCHANGED : TINT, undefined, i);
      }
      for (const c of mine) {
        if (c.effect === OVERLAY || this._ready.has(c.effect)) {
          add(c.effect, c.params, clipTime(c, frame, context.fps), i);
        } else {
          add(OVERLAY, TINT, undefined, i); // unknown, or not set up yet
        }
      }
    }

    for (const p of passes) {
      const ctx = {
        ...context,
        masks: p.idx.map(i => context.masks[i]),
        maskColors: p.idx.map(i => context.maskColors[i]),
        time: p.time,
      };
      const objects = p.idx.map(i => tracklets[i]);
      if (p.effect === OVERLAY) {
        this._overlay.variant = styleIndex(OVERLAY, p.params);
        if (preview) {
          this._overlay.apply(form, ctx, objects);
        } else {
          this._withoutAids(() => this._overlay.apply(form, ctx, objects));
        }
      } else {
        const effect = this._ready.get(p.effect)!;
        effect.setParams(p.params);
        effect.variant = styleIndex(p.effect, p.params);
        effect.apply(form, ctx, objects);
      }
    }
  }

  /** Run `draw` with the Overlay's editing aids (selection, stale fade) off; draws are synchronous, so nothing sees the swap. */
  private _withoutAids(draw: () => void): void {
    const {activeObjectId, faded} = this._overlay;
    this._overlay.activeObjectId = null;
    this._overlay.faded = () => false;
    try {
      draw();
    } finally {
      this._overlay.activeObjectId = activeObjectId;
      this._overlay.faded = faded;
    }
  }

  async cleanup(): Promise<void> {
    for (const e of this._ready.values()) {
      await e.cleanup();
    }
    this._ready.clear();
    await this._overlay.cleanup();
  }
}
