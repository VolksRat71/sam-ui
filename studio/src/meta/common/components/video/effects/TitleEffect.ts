// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Title: an editable title on the background stage, in the bundled Inter (the
// worker loads it, VideoWorkerContext). Behind subjects (the default), the
// frame's own pixels inside every tracked layer's mask on the frame (their
// union, EffectSpec.subjects; ObjectHighlight passes them) are put back over
// the text, so the subjects stand in front of it; a layer's own clips still
// draw over them. In front, the text is simply drawn. Canvas 2D only: no WebGL
// context, so it never counts against the worker's four. The typed text is
// drawn with fillText alone, never parsed as markup. Its entrance runs on the
// clip's clock, so a frame looks the same however it is reached.
import type {Tracklet} from '@/common/tracker/Tracker';
import type {CanvasForm} from 'pts';
import {AbstractEffect, type EffectFrameContext, effectTime} from './Effect';
import {numberParam} from './EffectParamSpecs';
import {unionMasks} from './SubjectsBackgroundGLEffect';

const FONT = 'Inter';
/** Line spacing, in font sizes. */
export const LINE_HEIGHT = 1.15;
const MAX_LINES = 3;

/** Resolves once the worker's Inter has loaded: true, or false (it failed, or no font set) and the title draws in the fallback sans-serif. */
export async function interLoaded(fonts: FontFaceSet | undefined = (globalThis as {fonts?: FontFaceSet}).fonts): Promise<boolean> {
  try {
    return fonts != null && (await fonts.load(`16px ${FONT}`)).length > 0;
  } catch {
    return false;
  }
}

/**
 * The entrance at clip time `t` (s) over its first `seconds`: opacity, how
 * far below its place the text is (in font sizes) and its scale. An ease out;
 * Pop overshoots a little before it settles.
 */
export function entranceAt(animation: string, t: number, seconds: number): {alpha: number; rise: number; scale: number} {
  const e = animation === 'None' || seconds <= 0 ? 1 : Math.min(1, Math.max(0, t / seconds));
  const out = 1 - (1 - e) ** 3;
  if (animation === 'Rise') {
    return {alpha: out, rise: 0.5 * (1 - out), scale: 1};
  }
  if (animation === 'Pop') {
    const back = 1 + 2.70158 * (e - 1) ** 3 + 1.70158 * (e - 1) ** 2; // easeOutBack
    return {alpha: out, rise: 0, scale: 0.5 + 0.5 * back};
  }
  return {alpha: animation === 'Fade' ? out : 1, rise: 0, scale: 1};
}

/**
 * Where each line goes, for textAlign `align` and textBaseline 'middle': the
 * block of lines (`widths` wide) centred on (cx, cy), each line aligned
 * within the widest.
 */
export function lineOrigins(widths: number[], align: string, cx: number, cy: number, lineHeight: number): Array<[number, number]> {
  const half = Math.max(0, ...widths) / 2;
  const x = align === 'Left' ? cx - half : align === 'Right' ? cx + half : cx;
  return widths.map((_, i) => [x, cy + (i - (widths.length - 1) / 2) * lineHeight]);
}

const TEXT_ALIGN: Record<string, CanvasTextAlign> = {Left: 'left', Centre: 'center', Right: 'right'};

export default class TitleEffect extends AbstractEffect {
  /** The subjects' union (column-major, as the masks), and the frame inside it on a canvas of its own: made on the first Behind subjects draw, kept. */
  private _union = new Uint8Array(0);
  private _cut: {canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D; image: ImageData} | null = null;

  constructor() {
    super(1);
  }

  async setup(): Promise<void> {
    if (!(await interLoaded())) {
      console.warn('Inter did not load: the Title draws in the fallback sans-serif');
    }
  }

  apply(form: CanvasForm, context: EffectFrameContext, _tracklets: Tracklet[]): void {
    const ctx = form.ctx;
    const p = this.params;
    const {width, height} = context;
    const size = numberParam('Title', 'size', p) * height;
    const {alpha, rise, scale} = entranceAt(String(p.animation), effectTime(context), numberParam('Title', 'entrance', p));
    if (alpha > 0) {
      const lines = String(p.text ?? '').split('\n', MAX_LINES);
      const align = String(p.align);
      ctx.save();
      ctx.font = `${numberParam('Title', 'weight', p)} ${size}px ${FONT}, sans-serif`;
      ctx.fillStyle = String(p.color); // '#rrggbb' (normalizeParams)
      ctx.globalAlpha = alpha;
      ctx.textAlign = TEXT_ALIGN[align] ?? 'center';
      ctx.textBaseline = 'middle';
      // scaled (Pop) about the block's centre
      ctx.translate(numberParam('Title', 'x', p) * width, numberParam('Title', 'y', p) * height + rise * size);
      ctx.scale(scale, scale);
      const at = lineOrigins(lines.map(l => ctx.measureText(l).width), align, 0, 0, size * LINE_HEIGHT);
      lines.forEach((l, i) => ctx.fillText(l, at[i][0], at[i][1]));
      ctx.restore();
    }
    if (p.placement !== 'In front' && context.masks.length > 0) {
      this._subjectsOver(ctx, context);
    }
  }

  /** Draw the frame's pixels inside the subjects' union over `ctx`, exactly (the union is all or nothing). */
  private _subjectsOver(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, context: EffectFrameContext): void {
    const {width: w, height: h} = context;
    if (this._cut == null || this._cut.canvas.width !== w || this._cut.canvas.height !== h) {
      const canvas = new OffscreenCanvas(w, h);
      const c = canvas.getContext('2d');
      if (c == null) {
        return;
      }
      this._cut = {canvas, ctx: c, image: new ImageData(w, h)};
      this._union = new Uint8Array(w * h);
    }
    const {canvas, ctx: cut, image} = this._cut;
    unionMasks(context.masks, this._union);
    // the union as alpha (column-major to rows); rgb stays 0
    const a = image.data;
    for (let x = 0, i = 0; x < w; x++) {
      for (let y = 0; y < h; y++, i++) {
        a[(y * w + x) * 4 + 3] = this._union[i];
      }
    }
    cut.putImageData(image, 0, 0);
    cut.globalCompositeOperation = 'source-in';
    cut.drawImage(context.frame, 0, 0);
    cut.globalCompositeOperation = 'source-over';
    ctx.drawImage(canvas, 0, 0);
  }

  async cleanup(): Promise<void> {
    this._cut = null;
    this._union = new Uint8Array(0);
  }
}
