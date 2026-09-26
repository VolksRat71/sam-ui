// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The highlight layer studio's worker draws masks with. Meta's Overlay effect
// is a WebGL shader with three mask slots (its demo caps objects at 3); studio
// allows OBJECT_LIMIT objects, so this effect paints any number of masks on a
// 2D canvas instead, in the same colours. It implements Meta's Effect
// interface and is installed in place of AllEffects.Overlay by the worker.
import {
  AbstractEffect,
  EffectFrameContext,
} from '@/common/components/video/effects/Effect';
import type {Tracklet} from '@/common/tracker/Tracker';
import type {RLEObject} from '@/jscocotools/mask';
import type {CanvasForm} from 'pts';
import {FILL_ALPHA, paintMask} from './maskPixels';

const CACHE_FRAMES = 24;
/** Fill opacity per variant; clicking the active effect again cycles them, as in Meta's demo. */
const VARIANT_FILL = [FILL_ALPHA, 0.7, 0.25, 0.9];

export default class MaskOverlayEffect extends AbstractEffect {
  /** The object being edited is drawn a little stronger. */
  public activeObjectId: number | null = null;

  private _ids = new WeakMap<object, number>();
  private _nextId = 1;
  private _cache = new Map<string, OffscreenCanvas>();

  constructor() {
    super(VARIANT_FILL.length);
  }

  private _idOf(rle: object): number {
    let id = this._ids.get(rle);
    if (id == null) {
      id = this._nextId++;
      this._ids.set(rle, id);
    }
    return id;
  }

  apply(form: CanvasForm, context: EffectFrameContext, tracklets: Tracklet[]): void {
    const {width, height, masks, maskColors} = context;
    if (masks.length === 0 || width < 1 || height < 1) {
      return;
    }
    const key =
      `${width}x${height}:${this.variant}:${this.activeObjectId}:` +
      masks
        .map((m, i) => `${this._idOf(m.bitmap)}${maskColors[i]}`)
        .join(',');
    let canvas = this._cache.get(key);
    if (canvas == null) {
      canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (ctx == null) {
        return;
      }
      const image = ctx.createImageData(width, height);
      const pixels = new Uint32Array(image.data.buffer);
      const fill = VARIANT_FILL[this.variant % VARIANT_FILL.length];
      masks.forEach((m, i) => {
        const active = tracklets[i]?.id === this.activeObjectId;
        paintMask(
          pixels,
          width,
          height,
          m.bitmap as RLEObject,
          maskColors[i],
          active ? Math.min(1, fill + 0.15) : fill,
        );
      });
      ctx.putImageData(image, 0, 0);
      this._cache.set(key, canvas);
      if (this._cache.size > CACHE_FRAMES) {
        const oldest = this._cache.keys().next().value;
        if (oldest != null) {
          this._cache.delete(oldest);
        }
      }
    } else {
      // keep recently shown frames at the end (LRU)
      this._cache.delete(key);
      this._cache.set(key, canvas);
    }
    form.ctx.drawImage(canvas, 0, 0, width, height);
  }

  async cleanup(): Promise<void> {
    this._cache.clear();
  }
}
