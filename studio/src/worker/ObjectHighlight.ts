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

export default class ObjectHighlight extends AbstractEffect {
  private _effects = new Map<number, ObjectEffectSpec>();
  private _ready = new Map<string, Effect>();

  constructor(
    private readonly _overlay: MaskOverlayEffect,
    private readonly _meta: Effects,
    private readonly _size: () => {width: number; height: number},
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

  /** Set every object's effect (objects not listed get the Overlay). */
  async setEffects(effects: Record<number, ObjectEffectSpec>): Promise<void> {
    this._effects = new Map(Object.entries(effects).map(([k, v]) => [Number(k), v]));
    const names = new Set([...this._effects.values()].map(e => e.name).filter(n => n !== OVERLAY));
    for (const name of names) {
      await this._prepare(name);
    }
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

  /** Set up anything still waiting for the decoded size. */
  async prepareAll(): Promise<void> {
    for (const e of this._effects.values()) {
      if (e.name !== OVERLAY) {
        await this._prepare(e.name);
      }
    }
  }

  apply(form: CanvasForm, context: EffectFrameContext, tracklets: Tracklet[]): void {
    const groups = new Map<string, number[]>();
    const plain: number[] = [];
    tracklets.forEach((t, i) => {
      const e = this._effects.get(t.id);
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
      const effect = this._ready.get(name)!;
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
    for (const e of this._ready.values()) {
      await e.cleanup();
    }
    this._ready.clear();
    await this._overlay.cleanup();
  }
}
