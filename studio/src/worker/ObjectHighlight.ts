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
// composite. Meta's 2D effects (Original, Desaturate, ...) draw straight on
// the form and get no context. A background clip gets no masks, except for
// an effect that keeps the tracked subjects as they are (EffectSpec.subjects:
// Replace background, Colour pop): it gets every layer's mask on the frame in
// one pass (it draws their union), less layers a hidden group keeps off the
// preview. Spotlight's darkened outside is drawn once a frame, just before
// the first Spotlight pass, outside every Spotlight circle on the frame at
// the strongest darken among them, so Spotlights never dim each other's
// circles or darken the outside twice. Pictures the clips use (`images`, sent by the page) reach every
// effect with the frame.
//
// Browsers cap live WebGL contexts (Chrome: 16 per page but 4 per worker,
// measured; past that the oldest is lost and draws nothing), so an effect's
// context lives only while the preview or a running export draws with it,
// and a context lost anyway is set up again on the next draw.
// ponytail: one context per GL effect, so more than four distinct GL effects
// in use evict each other (each rebuild recompiles its shaders); a context
// shared by every GL effect, rebinding its program per pass, if that bites.
import type {
  Effect,
  EffectFrameContext,
  EffectParams,
} from '@/common/components/video/effects/Effect';
import {AbstractEffect, clipSeed} from '@/common/components/video/effects/Effect';
import BaseGLEffect from '@/common/components/video/effects/BaseGLEffect';
import {EFFECT_SPECS, numberParam, styleIndex} from '@/common/components/video/effects/EffectParamSpecs';
import type ScopeGLEffect from '@/common/components/video/effects/ScopeGLEffect';
import type {Effects} from '@/common/components/video/effects/Effects';
import type {Tracklet} from '@/common/tracker/Tracker';
import {CanvasForm} from 'pts';
import {
  EMPTY_DOC,
  type EffectClip,
  type EffectDoc,
  ORIGINAL,
  OVERLAY,
  type UntouchedMode,
  activeClips,
  clipTime,
  imageKeys,
  normalizeParams,
} from '~/state/effectClips';
import type MaskOverlayEffect from './MaskOverlayEffect';

/**
 * What a canvas is drawn from. `untouched` null is the preview: objects with
 * no clip get the Overlay, editing aids show and hidden groups stay off.
 */
export type DrawState = {doc: EffectDoc; drawOrder: number[]; untouched: UntouchedMode | null};

/** setup: its effect.setup, which an export waits for even when a draw started it (Title waits there for its font). */
type Ready = {effect: Effect; gl: WebGL2RenderingContext | null; setup?: Promise<void>};
type Pass = {effect: string; params: EffectParams; time?: number; duration?: number; seed?: number; key: string; idx: number[]};

const META_MASK_SLOTS = 3;
const SPOTLIGHT = 'Scope';
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
  /** Pictures the clips use, by key (state/effectImages.ts). */
  public readonly images = new Map<string, ImageBitmap>();
  private _preview: DrawState = {doc: EMPTY_DOC, drawOrder: [], untouched: null};
  /** Canvases drawn from a state of their own (an export's), not the preview's. */
  private _forms = new WeakMap<CanvasForm, DrawState>();
  /** Running exports' states: their effects stay set up whatever the preview does. */
  private _exports = new Set<DrawState>();
  private _ready = new Map<string, Ready>();
  /** Effects whose setup failed, skipped (drawn as the stage default) until a setDoc changes which effects the doc uses. */
  private _failed = new Set<string>();
  private _docEffects = '';

  constructor(
    private readonly _overlay: MaskOverlayEffect,
    private readonly _meta: Effects,
    private readonly _size: () => {width: number; height: number},
    private readonly _newCanvas = (width: number, height: number) => new OffscreenCanvas(width, height),
  ) {
    super(1);
  }

  /** The preview's clips and layer order (object ids, bottom layer first). */
  async setDoc(doc: EffectDoc, drawOrder: number[]): Promise<void> {
    this._preview = {doc, drawOrder, untouched: null};
    // not on every edit (a slider tick): a failing effect would make a new context each time
    const effects = [...new Set(doc.clips.map(c => c.effect))].sort().join();
    if (effects !== this._docEffects) {
      this._docEffects = effects;
      this._failed.clear();
    }
    await this._sync();
  }

  /** Set up every effect an export's `state` draws with and keep it until `finish(state)`. */
  async prepare(state: DrawState): Promise<void> {
    this._exports.add(state);
    await this._sync();
  }

  /** The export drawing `state` is over: free what nothing else draws with. */
  async finish(state: DrawState): Promise<void> {
    this._exports.delete(state);
    await this._sync();
  }

  /**
   * Keep effects set up, and pictures, for exactly the preview's and running
   * exports' clips (unregistered effects draw as the stage default); a dropped
   * picture is closed, and the page sends it again if a clip uses it again.
   */
  private async _sync(): Promise<void> {
    const states = [this._preview, ...this._exports];
    const used = new Set(states.flatMap(s => imageKeys(s.doc)));
    for (const [key, image] of this.images) {
      if (!used.has(key)) {
        image.close();
        this.images.delete(key);
      }
    }
    const names = new Set<string>();
    for (const state of states) {
      state.doc.clips.forEach(c => names.add(c.effect));
      if (state.untouched === 'original') {
        names.add(ORIGINAL);
      }
    }
    names.delete(OVERLAY);
    for (const name of [...this._ready.keys()]) {
      if (!names.has(name)) {
        await this._release(name);
      }
    }
    for (const name of names) {
      await this._prepare(name);
    }
  }

  /** Draw `form` (an export's canvas) from `state`, leaving the preview's state alone. */
  drawWith(form: CanvasForm, state: DrawState): void {
    this._forms.set(form, state);
  }

  /**
   * Set up Meta's effect `name` (a GL one on a WebGL context of its own),
   * unless it is set up on a live context. It is ready before `setup`
   * resolves: Meta's GL effects do their GL work synchronously, so a draw can
   * rebuild a lost one and use it.
   */
  private _prepare(name: string): Promise<void> | undefined {
    const ready = this._ready.get(name);
    if ((ready != null && ready.gl?.isContextLost() !== true) || this._failed.has(name)) {
      return ready?.setup;
    }
    this._ready.delete(name);
    const effect = this._meta[name as keyof Effects];
    const {width, height} = this._size();
    if (effect == null || width < 1 || height < 1) {
      return; // unknown, or the video is not decoded yet: the stage default until then
    }
    let canvas: OffscreenCanvas | undefined;
    let gl: WebGL2RenderingContext | null = null;
    if (effect instanceof BaseGLEffect) {
      canvas = this._newCanvas(width, height);
      gl = canvas.getContext('webgl2');
      if (gl == null) {
        this._failed.add(name);
        console.warn(`no WebGL2 context for the ${name} effect; drawn as the stage default`);
        return;
      }
      const lost = gl;
      canvas.addEventListener('webglcontextlost', () => {
        if (this._ready.get(name)?.gl === lost) {
          this._ready.delete(name);
        }
      });
    }
    const mine: Ready = {effect, gl};
    this._ready.set(name, mine);
    return (mine.setup = effect.setup({width, height, canvas, gl: gl ?? undefined}).catch(error => {
      this._failed.add(name);
      if (this._ready.get(name) === mine) {
        this._ready.delete(name);
      }
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      console.warn(`the ${name} effect failed to set up; drawn as the stage default`, error);
    }));
  }

  /** Free effect `name`'s GL resources and its context. */
  private async _release(name: string): Promise<void> {
    const ready = this._ready.get(name);
    this._ready.delete(name);
    if (ready != null) {
      await ready.effect.cleanup();
      ready.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }

  apply(form: CanvasForm, context: EffectFrameContext, tracklets: Tracklet[]): void {
    const state = this._forms.get(form) ?? this._preview;
    const preview = state.untouched == null;
    const frame = context.frameIndex;
    const active = activeClips(state.doc, frame);
    const ready = (name: string): boolean => {
      if (name === OVERLAY) {
        return false;
      }
      void this._prepare(name); // nothing while its context lives; rebuilds a lost one
      return this._ready.has(name);
    };
    const passes: Pass[] = [];
    // one pass per clip, merged with the pass below when it is the same effect
    // and settings (three masks at most for Meta's shaders, any for the Overlay)
    // a clip's clock: its time, and its animation's length (frames trimmed off the start still count, as phase)
    const add = (effect: string, params: EffectParams, clip: EffectClip | null, i: number | null, subjects: number[] = []) => {
      const fps = context.fps > 0 ? context.fps : 30;
      const t = clip == null || effect === OVERLAY ? undefined : clipTime(clip, frame, context.fps);
      const duration = t == null ? undefined : (clip!.end - clip!.start + clip!.phase) / fps;
      // a seeded effect's randomness is its clip's: its own pass
      const seed = clip != null && EFFECT_SPECS[effect]?.seeded ? clipSeed(clip.id) : undefined;
      // darken is drawn once a frame (dim), not by the pass: clips differing only in it share a pass
      const key = `${effect}\u0000${canonical(effect === SPOTLIGHT ? {...params, darken: 0} : params)}\u0000${t ?? ''}\u0000${duration ?? ''}\u0000${seed ?? ''}`;
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
        passes.push({effect, params, time: t, duration, seed, key, idx: i == null ? subjects : [i]});
      }
    };

    // background clips by row; an effect this build lacks leaves the plain frame below
    const shown = tracklets.flatMap((t, i) => (preview && this.hidden(t.id) ? [] : [i]));
    for (const c of active) {
      if (c.target.kind === 'background' && ready(c.effect)) {
        add(c.effect, c.params, c, null, EFFECT_SPECS[c.effect]?.subjects ? shown : []);
      }
    }

    // objects with a mask on this frame, bottom layer first (ids the order does not name yet go below it)
    const circles = new Map<number, number>(); // tracklet index -> circle size
    let darken = 0;
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
        const original = state.untouched === 'original' && ready(ORIGINAL);
        add(original ? ORIGINAL : OVERLAY, original ? UNCHANGED : TINT, null, i);
      }
      for (const c of mine) {
        if (c.effect === OVERLAY || ready(c.effect)) {
          add(c.effect, c.params, c, i);
          if (c.effect === SPOTLIGHT) {
            // one circle per layer (its largest, with several Spotlight clips)
            circles.set(i, Math.max(circles.get(i) ?? 0, numberParam(SPOTLIGHT, 'size', c.params)));
            darken = Math.max(darken, numberParam(SPOTLIGHT, 'darken', c.params));
          }
        } else {
          add(OVERLAY, TINT, null, i); // unknown, or not set up yet
        }
      }
    }

    for (const p of passes) {
      // pts 1.0 skips style writes it thinks are applied; the pass before (save/restore, direct ctx writes) desyncs it
      CanvasForm.resetStyleCache(form.ctx);
      const ctx = {
        ...context,
        masks: p.idx.map(i => context.masks[i]),
        maskColors: p.idx.map(i => context.maskColors[i]),
        time: p.time,
        duration: p.duration,
        seed: p.seed,
        images: this.images,
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
        const effect = this._ready.get(p.effect)!.effect;
        if (p.effect === SPOTLIGHT && darken > 0) {
          // ponytail: dim cuts out at most DIM_CIRCLES (16, the default object limit) circles; layers past it are dimmed too
          (effect as unknown as ScopeGLEffect).dim(form, context, [...circles].map(([i, size]) => ({mask: context.masks[i], size})), darken);
          darken = 0; // once a frame
        }
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
    for (const name of [...this._ready.keys()]) {
      await this._release(name);
    }
    await this._overlay.cleanup();
  }
}
