// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The highlight layer in studio's worker. Every object gets studio's mask
// overlay; a selected-object effect (one of Meta's highlight effects: Cutout,
// Erase, Pixelate, ...) applies only to the focused object, and only when the
// UI says that object is tracked (`focusId`). Meta's own demo applies the
// chosen effect to every object.
import type {
  Effect,
  EffectFrameContext,
  EffectInit,
  EffectOptions,
} from '@/common/components/video/effects/Effect';
import {AbstractEffect} from '@/common/components/video/effects/Effect';
import type {Tracklet} from '@/common/tracker/Tracker';
import type {CanvasForm} from 'pts';
import type MaskOverlayEffect from './MaskOverlayEffect';

export default class FocusedHighlight extends AbstractEffect {
  /** The object selected-object effects apply to; null applies them to none. */
  public focusId: number | null = null;
  private _inner: Effect | null = null;

  constructor(private readonly _overlay: MaskOverlayEffect) {
    super(1);
  }

  /** The effect reported to the UI: the inner one, or the overlay. */
  get current(): Effect {
    return this._inner ?? this._overlay;
  }

  /**
   * Use Meta's `effect` for the focused object (null: the overlay only). It is
   * set up on the context's highlight WebGL canvas, as Meta's context would.
   */
  async use(effect: Effect | null, init: EffectInit | null, options?: EffectOptions): Promise<void> {
    if (effect !== this._inner) {
      await this._inner?.cleanup();
      this._inner = null;
      if (effect != null) {
        if (init == null) {
          throw new Error('the video is not decoded yet');
        }
        await effect.setup(init);
        this._inner = effect;
      }
    }
    if (options != null) {
      await this.current.update(options);
    }
  }

  apply(form: CanvasForm, context: EffectFrameContext, tracklets: Tracklet[]): void {
    const at = this._inner == null || this.focusId == null ? -1 : tracklets.findIndex(t => t.id === this.focusId);
    if (at < 0) {
      this._overlay.apply(form, context, tracklets);
      return;
    }
    const pick = <T,>(xs: T[], keep: boolean) => xs.filter((_, i) => (i === at) === keep);
    this._inner!.apply(
      form,
      {...context, masks: pick(context.masks, true), maskColors: pick(context.maskColors, true)},
      pick(tracklets, true),
    );
    this._overlay.apply(
      form,
      {...context, masks: pick(context.masks, false), maskColors: pick(context.maskColors, false)},
      pick(tracklets, false),
    );
  }

  async cleanup(): Promise<void> {
    await this._inner?.cleanup();
    this._inner = null;
    await this._overlay.cleanup();
  }
}
