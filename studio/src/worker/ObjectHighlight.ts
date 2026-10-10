// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The highlight layer in studio's worker: every object drawn with its own
// selected-object effect. Meta's demo applies one highlight effect to all
// objects; here each object has its own (Original, Pixelate, Emoji, ...), an
// object without one gets studio's many-mask Overlay, and the same code
// draws the preview and the video export.
//
// Meta's GL effects each get their own OffscreenCanvas and WebGL context (an
// effect assumes its program and buffers stay bound between frames, so two
// cannot share one context). One effect instance serves every object that
// uses it: its variant is set before each draw. Meta's shaders hold three
// masks, so objects sharing an effect are drawn three at a time; the effects
// are transparent outside their masks, so the passes composite.
//
// Browsers cap live WebGL contexts (Chrome: 16, then the oldest is lost and
// draws nothing), so an effect's context lives only while some object uses
// the effect, and a context lost anyway is set up again on the next draw.
import type {
  Effect,
  EffectFrameContext,
} from '@/common/components/video/effects/Effect';
import {AbstractEffect} from '@/common/components/video/effects/Effect';
import type {Effects} from '@/common/components/video/effects/Effects';
import type {Tracklet} from '@/common/tracker/Tracker';
import type {CanvasForm} from 'pts';
import type MaskOverlayEffect from './MaskOverlayEffect';

export type ObjectEffectSpec = {name: string; variant: number};

const OVERLAY = 'Overlay';
const META_MASK_SLOTS = 3;

type Ready = {effect: Effect; gl: WebGL2RenderingContext};

export default class ObjectHighlight extends AbstractEffect {
  /** Objects kept off the drawing (a hidden group's members; off in exports). */
  public hidden: (objectId: number) => boolean = () => false;
  private _effects = new Map<number, ObjectEffectSpec>();
  private _ready = new Map<string, Ready>();

  constructor(
    private readonly _overlay: MaskOverlayEffect,
    private readonly _meta: Effects,
    private readonly _size: () => {width: number; height: number},
    private readonly _newCanvas = (width: number, height: number) => new OffscreenCanvas(width, height),
  ) {
    super(1);
    this._overlay.variantOf = id => {
      const e = this._effects.get(id);
      return e == null || e.name === OVERLAY ? (e?.variant ?? 0) : undefined;
    };
  }

  /** Numbers of variants, for the UI to cycle through. */
  variantCounts(names: string[]): Record<string, number> {
    const out: Record<string, number> = {[OVERLAY]: this._overlay.numVariants};
    for (const n of names) {
      const e = this._meta[n as keyof Effects];
      if (e != null && n !== OVERLAY) {
        out[n] = e.numVariants;
      }
    }
    return out;
  }

  /** Set every object's effect (objects not listed get the Overlay); frees effects no object uses. */
  async setEffects(effects: Record<number, ObjectEffectSpec>): Promise<void> {
    this._effects = new Map(Object.entries(effects).map(([k, v]) => [Number(k), v]));
    const names = new Set([...this._effects.values()].map(e => e.name).filter(n => n !== OVERLAY));
    for (const name of [...this._ready.keys()]) {
      if (!names.has(name)) {
        await this._release(name);
      }
    }
    for (const name of names) {
      await this._prepare(name);
    }
  }

  /**
   * Set up Meta's effect `name` on a WebGL context of its own, unless it has
   * a live one. It is ready before `setup` resolves: Meta's GL effects do
   * their GL work synchronously, so a draw can rebuild a lost one and use it.
   */
  private _prepare(name: string): Promise<void> | undefined {
    if (this._ready.get(name)?.gl.isContextLost() === false) {
      return;
    }
    this._ready.delete(name);
    const effect = this._meta[name as keyof Effects];
    const {width, height} = this._size();
    if (effect == null || width < 1 || height < 1) {
      return; // unknown, or the video is not decoded yet: drawn as Overlay until then
    }
    const canvas = this._newCanvas(width, height);
    const gl = canvas.getContext('webgl2');
    if (gl == null) {
      throw new Error(`no WebGL2 context for the ${name} effect`);
    }
    canvas.addEventListener('webglcontextlost', () => {
      if (this._ready.get(name)?.gl === gl) {
        this._ready.delete(name);
      }
    });
    this._ready.set(name, {effect, gl});
    return effect.setup({width, height, canvas, gl});
  }

  /** Free effect `name`'s GL resources and its context. */
  private async _release(name: string): Promise<void> {
    const ready = this._ready.get(name);
    this._ready.delete(name);
    if (ready != null) {
      await ready.effect.cleanup();
      ready.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }

  apply(form: CanvasForm, context: EffectFrameContext, tracklets: Tracklet[]): void {
    const groups = new Map<string, number[]>();
    const plain: number[] = [];
    tracklets.forEach((t, i) => {
      if (this.hidden(t.id)) {
        return;
      }
      const e = this._effects.get(t.id);
      if (e != null && e.name !== OVERLAY) {
        void this._prepare(e.name); // nothing while its context lives; rebuilds a lost one
      }
      if (e == null || e.name === OVERLAY || !this._ready.has(e.name)) {
        plain.push(i);
      } else {
        const key = `${e.name}\u0000${e.variant}`;
        groups.set(key, [...(groups.get(key) ?? []), i]);
      }
    });
    const pick = (idx: number[]) => ({
      ctx: {...context, masks: idx.map(i => context.masks[i]), maskColors: idx.map(i => context.maskColors[i])},
      tracklets: idx.map(i => tracklets[i]),
    });
    for (const [key, idx] of groups) {
      const [name, variant] = key.split('\u0000');
      const effect = this._ready.get(name)!.effect;
      effect.variant = Number(variant);
      for (let at = 0; at < idx.length; at += META_MASK_SLOTS) {
        const part = pick(idx.slice(at, at + META_MASK_SLOTS));
        effect.apply(form, part.ctx, part.tracklets);
      }
    }
    if (plain.length > 0) {
      const part = pick(plain);
      this._overlay.apply(form, part.ctx, part.tracklets);
    }
  }

  async cleanup(): Promise<void> {
    for (const name of [...this._ready.keys()]) {
      await this._release(name);
    }
    await this._overlay.cleanup();
  }
}
