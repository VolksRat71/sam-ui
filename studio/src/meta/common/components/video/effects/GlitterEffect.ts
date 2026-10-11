// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Glitter: sparkles that live on and around a layer's subject, emitted from
// its mask (edge, inside or both), drifting out, twinkling and fading; Meta
// Edits' Glitter is the precedent. Styles: Glitter (small flashing glints),
// Sparkle (fewer four-point stars that pulse), Dust (fine soft specks that
// float up).
//
// No simulation state: each particle is a pure function of (the clip's seed,
// its index, the clip time). Index i is a slot that emits one particle after
// another: its period, offset, and each particle's life, spawn point (u, v in
// the mask's box), drift, size, twinkle phase and colour come from a hash, so
// a frame looks the same however it is reached (seek, replay, export).
// Particles spawned before the clip's start are not drawn, so a clip starts
// clean and fills in over a life.
//
// The spawn point is sampled from the CURRENT frame's mask, relative to its
// box: the line (column or row) at u of the box, the point at v along that
// line's mask pixels (inside) or its edge pixels (where the mask ends along
// the line). So a particle stays attached to a moving subject without any
// history; it drifts from there, outward from the box's centre, by velocity
// x age. A frame with no mask draws none (ObjectHighlight passes only masks
// on the frame); the clock runs on.
//
// Canvas 2D only (no WebGL context, so it never counts against the worker's
// four): one small pre-drawn sprite per style and colour, drawn with
// drawImage. Each mask is decoded once a frame into a buffer kept between
// frames (unionMasks), with per-line counts so a sample finds its line at once.
import {hexToRgb} from '@/common/components/video/editor/VideoEditorUtils';
import type {Tracklet} from '@/common/tracker/Tracker';
import type {CanvasForm} from 'pts';
import {AbstractEffect, type EffectFrameContext, type EffectMask, effectTime} from './Effect';
import {numberParam} from './EffectParamSpecs';
import {unionMasks} from './SubjectsBackgroundGLEffect';

/** Each style's particle life (s at speed 1), twinkles per second, size swing and upward drift. */
const LOOKS: Record<string, {life: number; twinkle: number; rise: number}> = {
  Glitter: {life: 1, twinkle: 3, rise: 0},
  Sparkle: {life: 1.4, twinkle: 1.2, rise: 0},
  Dust: {life: 2.5, twinkle: 0.4, rise: 0.8},
};
/** Multicolour's colours: gold, white, pink, cyan, lavender, mint. */
const PALETTE = ['#ffd34d', '#ffffff', '#ff6ad5', '#5ce1ff', '#b48cff', '#7dffb0'];
const SPRITE = 64;
const MAX_SPRITES = 64;
/** Per-particle hashes, one block of this many per emitted particle. */
const DRAWS = 16;

function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A hash of three integers as a fraction in [0, 1). */
export function rand(seed: number, a: number, b: number): number {
  return mix(seed ^ mix(a ^ mix(b + 0x9e3779b9))) / 4294967296;
}

/** A particle at a clip time: where in the mask box it spawned (u, v), when, how far through its life. */
export type Particle = {
  /** Clip time (particle clock) it spawned at. */
  spawn: number;
  /** 0 at spawn, toward 1 at the end of its life. */
  age: number;
  u: number;
  v: number;
  /** Below 0.5: an edge particle with area Both. */
  kind: number;
  /** Picks columns or rows, weighted by the box's shape. */
  pick: number;
  angle: number;
  /** How much of the spread it drifts over its life. */
  reach: number;
  size: number;
  phase: number;
  hue: number;
};

export function newParticle(): Particle {
  return {spawn: 0, age: 0, u: 0, v: 0, kind: 0, pick: 0, angle: 0, reach: 0, size: 0, phase: 0, hue: 0};
}

/**
 * Slot `slot`'s particle at clip time `t` (s, on the particle clock) into
 * `out`, or false when none is alive: between particles, or spawned before
 * the clip's start (t 0). Lives last 0.6-1 of the slot's period, which is
 * 0.7-1.3 of `life`.
 */
export function particleAt(out: Particle, seed: number, slot: number, t: number, life: number): boolean {
  const period = life * (0.7 + 0.6 * rand(seed, slot, -1));
  const clock = t + rand(seed, slot, -2) * period; // slots out of step
  const n = Math.floor(clock / period);
  const age = clock - n * period;
  const b = n * DRAWS;
  const span = period * (0.6 + 0.4 * rand(seed, slot, b));
  if (age >= span || age > t) {
    return false;
  }
  out.spawn = t - age;
  out.age = age / span;
  out.u = rand(seed, slot, b + 1);
  out.v = rand(seed, slot, b + 2);
  out.kind = rand(seed, slot, b + 3);
  out.pick = rand(seed, slot, b + 4);
  out.angle = 2 * Math.PI * rand(seed, slot, b + 5);
  out.reach = 0.3 + 0.7 * rand(seed, slot, b + 6);
  out.size = 0.5 + rand(seed, slot, b + 7);
  out.phase = rand(seed, slot, b + 8);
  out.hue = rand(seed, slot, b + 9);
  return true;
}

/** A mask's pixel counts per column and row of its box: inside, and on its edge along that line. */
export type MaskLines = {colIn: Int32Array; colEdge: Int32Array; rowIn: Int32Array; rowEdge: Int32Array};

/** Fill `l` for mask `m` (column-major, `h` rows, non-zero inside) in its box [x0, y0, x1, y1]. */
export function maskLines(m: Uint8Array, h: number, box: Int32Array, l: MaskLines): void {
  const [x0, y0, x1, y1] = box;
  l.colIn.fill(0);
  l.colEdge.fill(0);
  l.rowIn.fill(0);
  l.rowEdge.fill(0);
  for (let x = x0; x < x1; x++) {
    for (let y = y0, i = x * h + y0; y < y1; y++, i++) {
      if (m[i] === 0) {
        continue;
      }
      l.colIn[x]++;
      l.rowIn[y]++;
      if (y === y0 || y === y1 - 1 || m[i - 1] === 0 || m[i + 1] === 0) {
        l.colEdge[x]++;
      }
      if (x === x0 || x === x1 - 1 || m[i - h] === 0 || m[i + h] === 0) {
        l.rowEdge[y]++;
      }
    }
  }
}

/** The position along line `line` (a column, or a row) of its k-th mask (or edge) pixel between lo and hi. */
function nth(m: Uint8Array, h: number, line: number, byRow: boolean, lo: number, hi: number, edge: boolean, k: number): number {
  const stride = byRow ? h : 1;
  const base = byRow ? line : line * h;
  for (let p = lo, n = 0; p < hi; p++) {
    const i = base + p * stride;
    if (m[i] !== 0 && (!edge || p === lo || p === hi - 1 || m[i - stride] === 0 || m[i + stride] === 0) && n++ === k) {
      return p;
    }
  }
  return lo; // not reached: k is below the line's count
}

/**
 * A spawn point on mask `m` for a particle's (u, v), into `out` as pixel
 * centres: the column at u of the box (or the row, byRow), and the point at v
 * among that line's mask pixels (or edge pixels). A line with none (the box
 * spans a gap) gives way to the nearest one with some. False for an empty mask.
 */
export function spawnPoint(out: Float64Array, m: Uint8Array, h: number, box: Int32Array, l: MaskLines, u: number, v: number, edge: boolean, byRow: boolean): boolean {
  const x0 = box[0], y0 = box[1], x1 = box[2], y1 = box[3];
  const first = byRow ? y0 : x0;
  const lines = (byRow ? y1 : x1) - first;
  const counts = byRow ? (edge ? l.rowEdge : l.rowIn) : edge ? l.colEdge : l.colIn;
  const c = first + Math.min(lines - 1, Math.floor(u * lines));
  for (let d = 0; d < lines; d++) {
    for (let s = d === 0 ? 1 : -1; s <= 1; s += 2) {
      const line = c + s * d;
      if (line < first || line >= first + lines || counts[line] === 0) {
        continue;
      }
      const p = nth(m, h, line, byRow, byRow ? x0 : y0, byRow ? x1 : y1, edge, Math.floor(v * counts[line]));
      out[0] = (byRow ? p : line) + 0.5;
      out[1] = (byRow ? line : p) + 0.5;
      return true;
    }
  }
  return false;
}

/** A style's sprite in `colour`, white at its heart, SPRITE px square. */
function drawSprite(style: string, colour: string): OffscreenCanvas {
  const canvas = new OffscreenCanvas(SPRITE, SPRITE);
  const ctx = canvas.getContext('2d')!;
  const {r, g, b} = hexToRgb(colour);
  const rgba = (a: number) => `rgba(${r}, ${g}, ${b}, ${a})`;
  const c = SPRITE / 2;
  const glow = (inner: string, a: number, reach: number) => {
    const grad = ctx.createRadialGradient(c, c, 0, c, c, reach);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.35, rgba(a));
    grad.addColorStop(1, rgba(0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SPRITE, SPRITE);
  };
  // a four-point star: points at `outer`, waist at `inner`
  const star = (outer: number, inner: number, fill: string) => {
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4 - Math.PI / 2;
      const rr = k % 2 === 0 ? outer : inner;
      ctx.lineTo(c + rr * Math.cos(a), c + rr * Math.sin(a));
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  if (style === 'Dust') {
    glow('rgba(255, 255, 255, 0.95)', 0.8, c);
  } else if (style === 'Sparkle') {
    glow(rgba(0.55), 0.3, c);
    star(c - 1, 3, rgba(1));
    star(c * 0.45, 2, '#ffffff');
  } else {
    glow(rgba(0.4), 0.2, c);
    star(c * 0.8, c * 0.22, rgba(1));
    star(c * 0.3, c * 0.1, '#ffffff');
  }
  return canvas;
}

export default class GlitterEffect extends AbstractEffect {
  /** The mask being drawn, decoded; its per-line counts; its box. Sized to the frame on first use, kept. */
  private _mask = new Uint8Array(0);
  private _lines: MaskLines = {colIn: new Int32Array(0), colEdge: new Int32Array(0), rowIn: new Int32Array(0), rowEdge: new Int32Array(0)};
  private _box = new Int32Array(4);
  private _one: EffectMask[] = [];
  private _q = newParticle();
  private _at = new Float64Array(2);
  private _sprites = new Map<string, OffscreenCanvas>();

  constructor() {
    super(1);
  }

  apply(form: CanvasForm, context: EffectFrameContext, _tracklets: Tracklet[]): void {
    const ctx = form.ctx;
    const p = this.params;
    const {width: w, height: h} = context;
    const style = LOOKS[String(p.style)] != null ? String(p.style) : 'Glitter';
    const look = LOOKS[style];
    const t = effectTime(context) * numberParam('Glitter', 'speed', p);
    const count = Math.round(numberParam('Glitter', 'density', p));
    const size = numberParam('Glitter', 'size', p) * h;
    const spread = numberParam('Glitter', 'spread', p) * h;
    const area = String(p.area);
    const multi = p.colours === 'Multicolour';
    if (this._mask.length !== w * h) {
      this._mask = new Uint8Array(w * h);
      this._lines = {colIn: new Int32Array(w), colEdge: new Int32Array(w), rowIn: new Int32Array(h), rowEdge: new Int32Array(h)};
    }
    const q = this._q;
    const at = this._at;
    const box = this._box;
    ctx.save();
    for (let k = 0; k < context.masks.length; k++) {
      const mask = context.masks[k];
      const [[bx0, by0], [bx1, by1]] = mask.bounds;
      box[0] = Math.max(0, Math.floor(bx0));
      box[1] = Math.max(0, Math.floor(by0));
      box[2] = Math.min(w, Math.ceil(bx1));
      box[3] = Math.min(h, Math.ceil(by1));
      const bw = box[2] - box[0];
      const bh = box[3] - box[1];
      if (bw <= 0 || bh <= 0) {
        continue;
      }
      this._one[0] = mask;
      unionMasks(this._one, this._mask);
      maskLines(this._mask, h, box, this._lines);
      const cx = (box[0] + box[2]) / 2;
      const cy = (box[1] + box[3]) / 2;
      const seed = ((context.seed ?? 0) + Math.imul(k, 0x9e3779b9)) >>> 0;
      const colour = p.color === 'layer' ? (context.maskColors[k] ?? '#ffffff') : String(p.color);
      for (let i = 0; i < count; i++) {
        if (!particleAt(q, seed, i, t, look.life)) {
          continue;
        }
        const edge = area === 'Edge' || (area === 'Both' && q.kind < 0.5);
        if (!spawnPoint(at, this._mask, h, box, this._lines, q.u, q.v, edge, q.pick * (bw + bh) < bh)) {
          continue;
        }
        // outward from the box's centre, turned by its own angle (Dust floats up), by velocity x age
        const ox = at[0] - cx;
        const oy = at[1] - cy;
        const ol = Math.hypot(ox, oy) || 1;
        const dx = ox / ol + Math.cos(q.angle);
        const dy = oy / ol + Math.sin(q.angle) - look.rise;
        const reach = (spread * q.reach * q.age) / (Math.hypot(dx, dy) || 1);
        // in over its first 15 %, out over its last 40 %; the twinkle on the particle clock
        const fade = Math.min(1, q.age / 0.15, (1 - q.age) / 0.4);
        const twinkle = 0.5 + 0.5 * Math.sin(2 * Math.PI * (look.twinkle * t + q.phase));
        const alpha = style === 'Glitter' ? fade * (0.25 + 0.75 * twinkle ** 3) : style === 'Dust' ? fade * (0.6 + 0.4 * twinkle) : fade;
        const s = size * q.size * (style === 'Sparkle' ? 0.35 + 0.65 * twinkle : 1);
        if (alpha <= 0 || s <= 0) {
          continue;
        }
        ctx.globalAlpha = alpha;
        ctx.drawImage(this._sprite(style, multi ? PALETTE[Math.floor(q.hue * PALETTE.length)] : colour), at[0] + dx * reach - s / 2, at[1] + dy * reach - s / 2, s, s);
      }
    }
    ctx.restore();
  }

  /** The sprite for a style and colour, drawn once; the cache starts over past MAX_SPRITES (a colour picker dragged). */
  private _sprite(style: string, colour: string): OffscreenCanvas {
    const key = `${style}${colour}`;
    let sprite = this._sprites.get(key);
    if (sprite == null) {
      if (this._sprites.size >= MAX_SPRITES) {
        this._sprites.clear();
      }
      sprite = drawSprite(style, colour);
      this._sprites.set(key, sprite);
    }
    return sprite;
  }

  async cleanup(): Promise<void> {
    this._sprites.clear();
    this._mask = new Uint8Array(0);
    this._one = [];
  }
}
