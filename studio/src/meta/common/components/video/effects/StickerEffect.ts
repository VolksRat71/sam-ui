// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Sticker: a graphic that follows its layer. A built-in shape (each a small
// canvas path, filled in its colour over a wider stroke of its outline
// colour) or a picture stored in this browser (slice 3's, by key), placed on
// the mask's bounding box: above it, below it, on its middle or a top corner,
// plus an offset, sized by the box's height (never under a share of the
// frame's). The box can be smoothed: the average of the boxes at frames
// f-k..f+k, from the masks the layer already has (Tracklet.masks, with their
// bounds), narrowed evenly at the video's ends and at an untracked frame so it
// stays centred; it depends on nothing but those masks, so seek, replay and
// export draw the same. No rotation follows the subject (a mask has none);
// only the Arrow turns, to point at the subject from where it sits. A frame
// with no mask has no sticker. Label, Price tag and Speech bubble can carry
// a label (the Title's text rules, drawn with fillText in Inter). Canvas 2D
// only, drawn on the layer's pass: above the layer, below clips on higher rows.
import type {Tracklet} from '@/common/tracker/Tracker';
import type {CanvasForm} from 'pts';
import {AbstractEffect, type EffectFrameContext} from './Effect';
import {numberParam} from './EffectParamSpecs';
import {LINE_HEIGHT, interLoaded} from './TitleEffect';

export type Bounds = [[number, number], [number, number]];

/**
 * The box at `frame`, averaged over frames frame-k..frame+k, the window
 * narrowed evenly to the frames on both sides that have a mask; null when
 * `frame` itself has none.
 */
export function smoothedBounds(masks: ReadonlyArray<{bounds: Bounds} | undefined>, frame: number, k: number): Bounds | null {
  if (masks[frame] == null) {
    return null;
  }
  let j = 0;
  while (j < k && frame - j - 1 >= 0 && masks[frame - j - 1] != null && masks[frame + j + 1] != null) {
    j++;
  }
  let [x0, y0, x1, y1] = [0, 0, 0, 0];
  for (let f = frame - j; f <= frame + j; f++) {
    const [[a, b], [c, d]] = masks[f]!.bounds;
    x0 += a;
    y0 += b;
    x1 += c;
    y1 += d;
  }
  const n = 2 * j + 1;
  return [
    [x0 / n, y0 / n],
    [x1 / n, y1 / n],
  ];
}

/**
 * The sticker's centre and height for `box` (frame px): `size` box heights
 * tall, at least `minSize` frame heights; above the box (Top), below it
 * (Bottom), on its middle or a top corner; moved by the offsets in box heights.
 */
export function placeSticker(box: Bounds, position: string, size: number, minSize: number, offsetX: number, offsetY: number, frameHeight: number): {x: number; y: number; h: number} {
  const [[x0, y0], [x1, y1]] = box;
  const bh = y1 - y0;
  const h = Math.max(size * bh, minSize * frameHeight);
  const mx = (x0 + x1) / 2;
  const [x, y] =
    position === 'Top-left' ? [x0, y0] : position === 'Top-right' ? [x1, y0] : position === 'Centre' ? [mx, (y0 + y1) / 2] : position === 'Bottom' ? [mx, y1 + h / 2] : [mx, y0 - h / 2];
  return {x: x + offsetX * bh, y: y + offsetY * bh, h};
}

type PathTarget = Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'quadraticCurveTo' | 'bezierCurveTo' | 'arc' | 'closePath'>;
type Shape = {
  /** Width over height. */
  aspect: number;
  /** The outline, centred on the origin, inside w x h. */
  path(ctx: PathTarget, w: number, h: number): void;
  /** Takes a label: the text's height and centre as shares of the sticker's height. */
  label?: {h: number; dx: number; dy: number};
};

/** A rectangle with rounded corners (quadratic corners, so every control point is inside it), from the top edge clockwise. */
function rounded(ctx: PathTarget, x0: number, y0: number, x1: number, y1: number, r: number): void {
  ctx.moveTo(x0 + r, y0);
  ctx.lineTo(x1 - r, y0);
  ctx.quadraticCurveTo(x1, y0, x1, y0 + r);
  ctx.lineTo(x1, y1 - r);
  ctx.quadraticCurveTo(x1, y1, x1 - r, y1);
  ctx.lineTo(x0 + r, y1);
  ctx.quadraticCurveTo(x0, y1, x0, y1 - r);
  ctx.lineTo(x0, y0 + r);
  ctx.quadraticCurveTo(x0, y0, x0 + r, y0);
  ctx.closePath();
}

export const SHAPES: Record<string, Shape> = {
  Star: {
    aspect: 1,
    path(ctx, w, h) {
      // five points, the inner ones at 0.45; moved down so its top and bottom points sit evenly in the box
      const dy = ((1 - Math.sin((3 * Math.PI) / 10)) / 4) * h;
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? 1 : 0.45;
        ctx[i === 0 ? 'moveTo' : 'lineTo']((w / 2) * r * Math.cos(a), (h / 2) * r * Math.sin(a) + dy);
      }
      ctx.closePath();
    },
  },
  Heart: {
    aspect: 1.1,
    path(ctx, w, h) {
      const [a, b] = [w / 2, h / 2];
      ctx.moveTo(0, b);
      ctx.bezierCurveTo(-0.3 * a, 0.65 * b, -a, 0.15 * b, -a, -0.4 * b);
      ctx.bezierCurveTo(-a, -b, -0.1 * a, -b, 0, -0.55 * b);
      ctx.bezierCurveTo(0.1 * a, -b, a, -b, a, -0.4 * b);
      ctx.bezierCurveTo(a, 0.15 * b, 0.3 * a, 0.65 * b, 0, b);
      ctx.closePath();
    },
  },
  Arrow: {
    aspect: 0.7,
    path(ctx, w, h) {
      // pointing down: a shaft and a head 0.45 of its height
      const [a, b, s, neck] = [w / 2, h / 2, 0.18 * w, h / 2 - 0.45 * h];
      ctx.moveTo(-s, -b);
      ctx.lineTo(s, -b);
      ctx.lineTo(s, neck);
      ctx.lineTo(a, neck);
      ctx.lineTo(0, b);
      ctx.lineTo(-a, neck);
      ctx.lineTo(-s, neck);
      ctx.closePath();
    },
  },
  'Speech bubble': {
    aspect: 1.4,
    path(ctx, w, h) {
      // a rounded body over the top three quarters, its tail down and left
      const [a, b, r, y1] = [w / 2, h / 2, 0.2 * h, 0.25 * h];
      ctx.moveTo(-a + r, -b);
      ctx.lineTo(a - r, -b);
      ctx.quadraticCurveTo(a, -b, a, -b + r);
      ctx.lineTo(a, y1 - r);
      ctx.quadraticCurveTo(a, y1, a - r, y1);
      ctx.lineTo(-0.05 * w, y1);
      ctx.lineTo(-0.3 * w, b);
      ctx.lineTo(-0.22 * w, y1);
      ctx.lineTo(-a + r, y1);
      ctx.quadraticCurveTo(-a, y1, -a, y1 - r);
      ctx.lineTo(-a, -b + r);
      ctx.quadraticCurveTo(-a, -b, -a + r, -b);
      ctx.closePath();
    },
    label: {h: 0.5, dx: 0, dy: -0.125},
  },
  'Price tag': {
    aspect: 1.8,
    path(ctx, w, h) {
      // pointed at the left, with a hole there (filled evenodd)
      const [a, b, r, p] = [w / 2, h / 2, 0.15 * h, -w / 2 + 0.35 * h];
      ctx.moveTo(p, -b);
      ctx.lineTo(a - r, -b);
      ctx.quadraticCurveTo(a, -b, a, -b + r);
      ctx.lineTo(a, b - r);
      ctx.quadraticCurveTo(a, b, a - r, b);
      ctx.lineTo(p, b);
      ctx.lineTo(-a, 0);
      ctx.closePath();
      ctx.moveTo(p + 0.09 * h, 0);
      ctx.arc(p, 0, 0.09 * h, 0, 2 * Math.PI);
      ctx.closePath();
    },
    label: {h: 0.6, dx: 0.15, dy: 0},
  },
  Sparkle: {
    aspect: 1,
    path(ctx, w, h) {
      // four points with curved-in sides
      const [a, b] = [w / 2, h / 2];
      ctx.moveTo(0, -b);
      ctx.quadraticCurveTo(0.12 * a, -0.12 * b, a, 0);
      ctx.quadraticCurveTo(0.12 * a, 0.12 * b, 0, b);
      ctx.quadraticCurveTo(-0.12 * a, 0.12 * b, -a, 0);
      ctx.quadraticCurveTo(-0.12 * a, -0.12 * b, 0, -b);
      ctx.closePath();
    },
  },
  Crown: {
    aspect: 1.25,
    path(ctx, w, h) {
      const [a, b] = [w / 2, h / 2];
      ctx.moveTo(-0.85 * a, b);
      ctx.lineTo(0.85 * a, b);
      ctx.lineTo(a, -0.55 * b);
      ctx.lineTo(0.45 * a, 0);
      ctx.lineTo(0, -b);
      ctx.lineTo(-0.45 * a, 0);
      ctx.lineTo(-a, -0.55 * b);
      ctx.closePath();
    },
  },
  Label: {
    aspect: 2,
    path(ctx, w, h) {
      rounded(ctx, -w / 2, -h / 2, w / 2, h / 2, 0.3 * h);
    },
    label: {h: 0.6, dx: 0, dy: 0},
  },
};

/** The Arrow's turn at each position (from pointing down), so it points at the subject. */
const ARROW_TURN: Record<string, number> = {Bottom: Math.PI, 'Top-left': -Math.PI / 4, 'Top-right': Math.PI / 4};
/** A labelled shape widens to its text plus this many heights, up to MAX_ASPECT heights wide. */
const LABEL_PAD = 0.6;
const MAX_ASPECT = 4;
const FONT = 'Inter';

export default class StickerEffect extends AbstractEffect {
  constructor() {
    super(Object.keys(SHAPES).length + 1);
  }

  async setup(): Promise<void> {
    if (!(await interLoaded())) {
      console.warn('Inter did not load: Sticker labels draw in the fallback sans-serif');
    }
  }

  apply(form: CanvasForm, context: EffectFrameContext, tracklets: Tracklet[]): void {
    const ctx = form.ctx;
    const p = this.params;
    const style = String(p.style);
    const shape = SHAPES[style];
    const picture = shape == null ? context.images?.get(String(p.image)) : undefined;
    if (shape == null && picture == null) {
      return; // Your picture with none picked, or one this browser lacks
    }
    const k = numberParam('Sticker', 'smooth', p);
    context.masks.forEach((mask, i) => {
      const box = smoothedBounds(tracklets[i]?.masks ?? [], context.frameIndex, k) ?? mask.bounds;
      const {x, y, h} = placeSticker(
        box,
        String(p.position),
        numberParam('Sticker', 'size', p),
        numberParam('Sticker', 'minSize', p),
        numberParam('Sticker', 'offsetX', p),
        numberParam('Sticker', 'offsetY', p),
        context.height,
      );
      ctx.save();
      ctx.translate(x, y);
      if (picture != null) {
        const w = (h * picture.width) / picture.height;
        ctx.drawImage(picture, -w / 2, -h / 2, w, h);
        ctx.restore();
        return;
      }
      const text = shape.label == null ? '' : String(p.text ?? '');
      const lines = text === '' ? [] : text.split('\n');
      let w = shape.aspect * h;
      let size = 0;
      let widths: number[] = [];
      if (lines.length > 0) {
        size = (shape.label!.h * h) / (lines.length * LINE_HEIGHT);
        ctx.font = `700 ${size}px ${FONT}, sans-serif`;
        widths = lines.map(l => ctx.measureText(l).width);
        const need = Math.max(...widths) + LABEL_PAD * h;
        w = Math.min(MAX_ASPECT * h, Math.max(w, need));
        if (need > w) {
          // wider than the widest shape: smaller text, measured again
          size *= (w - LABEL_PAD * h) / Math.max(...widths);
          ctx.font = `700 ${size}px ${FONT}, sans-serif`;
          widths = lines.map(l => ctx.measureText(l).width);
        }
      }
      if (style === 'Arrow' && ARROW_TURN[String(p.position)] != null) {
        ctx.rotate(ARROW_TURN[String(p.position)]);
      }
      ctx.beginPath();
      shape.path(ctx, w, h);
      const outline = numberParam('Sticker', 'outlineWidth', p) * h;
      ctx.lineJoin = 'round';
      if (outline > 0) {
        ctx.strokeStyle = p.outline === 'layer' ? context.maskColors[i] : String(p.outline);
        ctx.lineWidth = 2 * outline; // the fill covers its inner half
        ctx.stroke();
      }
      ctx.fillStyle = p.color === 'layer' ? context.maskColors[i] : String(p.color); // '#rrggbb' or 'layer' (normalizeParams)
      ctx.fill('evenodd');
      if (lines.length > 0) {
        ctx.fillStyle = String(p.textColor);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const {dx, dy} = shape.label!;
        lines.forEach((l, j) => ctx.fillText(l, dx * h, dy * h + (j - (lines.length - 1) / 2) * size * LINE_HEIGHT));
      }
      ctx.restore();
    });
  }
}
