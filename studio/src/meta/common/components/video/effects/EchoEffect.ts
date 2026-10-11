// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Echo: delayed copies of a layer trailing behind it. On frame f its clip
// draws the layer as it was on frames f - k * spacing (k = 1..count), each cut
// out of that frame with that frame's mask, farthest first, under the layer
// as it is now: the stage inside the current mask (the video, or what clips
// below drew there) is put back over the copies, as the Title does. Echo
// fades each copy more than the one before; Strobe draws them alike. Only
// frames inside the clip are used, so a clip starts clean, and the earlier
// frames come from the worker (historyFrames, EffectFrameContext.history),
// never from what was drawn before: a frame looks the same however it is
// reached. Canvas 2D only: no WebGL context, so it never counts against the
// worker's four.
import type {Tracklet} from '@/common/tracker/Tracker';
import type {RLEObject} from '@/jscocotools/mask';
import type {CanvasForm} from 'pts';
import {AbstractEffect, type EffectFrameContext, type EffectMask, type EffectParams} from './Effect';
import {numberParam} from './EffectParamSpecs';
import {unionMasks} from './SubjectsBackgroundGLEffect';

/** How strongly a tint colours a copy (over the copy's own pixels). */
export const TINT_STRENGTH = 0.6;

type Scratch = {canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D};
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The frames clip `start`'s echoes on `frame` come from, nearest first: f - k * spacing for k = 1..count, none before the clip's start. */
export function echoFrames(params: EffectParams, start: number, frame: number): number[] {
  const count = numberParam('Echo', 'count', params);
  const spacing = numberParam('Echo', 'spacing', params);
  const out: number[] = [];
  for (let k = 1; k <= count && frame - k * spacing >= start; k++) {
    out.push(frame - k * spacing);
  }
  return out;
}

/** Copy k's opacity (k = 1 is the nearest): Strobe's all alike, Echo's each `falloff` fainter than the one before. */
export function echoAlpha(params: EffectParams, k: number): number {
  const opacity = numberParam('Echo', 'opacity', params);
  return params.style === 'Strobe' ? opacity : opacity * (1 - numberParam('Echo', 'falloff', params)) ** (k - 1);
}

export default class EchoEffect extends AbstractEffect {
  /** A mask decoded (column-major), its alpha in rows, and two canvases: the current layer cut out, a copy cut out. Made on the first draw, kept. */
  private _decoded = new Uint8Array(0);
  private _image: ImageData | null = null;
  private _cut: Scratch | null = null;
  private _copy: Scratch | null = null;

  constructor() {
    super(1);
  }

  historyFrames(clip: {start: number; params: EffectParams}, frame: number): number[] {
    return echoFrames(clip.params, clip.start, frame);
  }

  apply(form: CanvasForm, context: EffectFrameContext, tracklets: Tracklet[]): void {
    const history = context.history;
    if (history == null || history.size === 0 || !this._ready(context.width, context.height)) {
      return; // the clip's first frames: nothing to echo yet
    }
    const ctx = form.ctx;
    const p = this.params;
    const spacing = numberParam('Echo', 'spacing', p);
    const count = numberParam('Echo', 'count', p);
    tracklets.forEach((t, j) => {
      const now = this._masked(this._cut!, context.masks[j], ctx.canvas, null);
      if (now == null) {
        return;
      }
      const tint = p.tint === 'Layer colour' ? context.maskColors[j] : p.tint === 'Custom' ? String(p.color) : null;
      // farthest first, so nearer copies lie over farther ones
      for (let k = count; k >= 1; k--) {
        const past = history.get(context.frameIndex - k * spacing);
        const mask = past?.masks.get(t.id);
        if (past == null || mask == null) {
          continue; // not in the clip, or the layer was not found then
        }
        const at = this._masked(this._copy!, mask, past.frame, tint);
        if (at != null) {
          ctx.globalAlpha = echoAlpha(p, k);
          ctx.drawImage(this._copy!.canvas, ...at, ...at);
        }
      }
      ctx.globalAlpha = 1;
      ctx.drawImage(this._cut!.canvas, ...now, ...now);
    });
  }

  /** Scratch canvases and buffers for a `w` x `h` frame. */
  private _ready(w: number, h: number): boolean {
    if (this._image?.width === w && this._image.height === h) {
      return true;
    }
    const scratch = (): Scratch | null => {
      const canvas = new OffscreenCanvas(w, h);
      const c = canvas.getContext('2d');
      return c == null ? null : {canvas, ctx: c};
    };
    this._cut = scratch();
    this._copy = scratch();
    if (this._cut == null || this._copy == null) {
      return false;
    }
    this._decoded = new Uint8Array(w * h);
    this._image = new ImageData(w, h);
    return true;
  }

  /**
   * `source` inside `mask` onto `into` (and a tint over it), within the
   * mask's bounds: those bounds as [x, y, w, h], the only part of `into` the
   * caller may read; null for an empty mask.
   */
  private _masked(into: Scratch, mask: EffectMask, source: CanvasImageSource, tint: string | null): [number, number, number, number] | null {
    const image = this._image!;
    const {width: w, height: h} = image;
    const [[bx0, by0], [bx1, by1]] = mask.bounds;
    const x0 = Math.max(0, Math.floor(bx0));
    const y0 = Math.max(0, Math.floor(by0));
    const x1 = Math.min(w, Math.ceil(bx1));
    const y1 = Math.min(h, Math.ceil(by1));
    if (x1 <= x0 || y1 <= y0) {
      return null;
    }
    unionMasks([{bitmap: mask.bitmap as RLEObject, bounds: mask.bounds}], this._decoded);
    // the mask as alpha (column-major to rows), inside its bounds only
    const a = image.data;
    for (let y = y0; y < y1; y++) {
      for (let x = x0, i = (y * w + x0) * 4 + 3; x < x1; x++, i += 4) {
        a[i] = this._decoded[x * h + y];
      }
    }
    const at: [number, number, number, number] = [x0, y0, x1 - x0, y1 - y0];
    const c: Ctx2D = into.ctx;
    c.putImageData(image, 0, 0, ...at);
    c.globalCompositeOperation = 'source-in';
    c.drawImage(source, ...at, ...at);
    if (tint != null) {
      c.globalCompositeOperation = 'source-atop';
      c.globalAlpha = TINT_STRENGTH;
      c.fillStyle = tint;
      c.fillRect(...at);
      c.globalAlpha = 1;
    }
    c.globalCompositeOperation = 'source-over';
    return at;
  }

  async cleanup(): Promise<void> {
    this._cut = null;
    this._copy = null;
    this._image = null;
    this._decoded = new Uint8Array(0);
  }
}
