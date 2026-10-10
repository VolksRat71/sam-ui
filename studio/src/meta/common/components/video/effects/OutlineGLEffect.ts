// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Outline: a stroke around each object's mask, or a soft Glow, drawn as
// decoration only (transparent inside the mask and beyond the stroke). Three
// passes on this effect's own context, all resources made once in setup:
// masks -> blurred coverage (drops specks, smooths edges), a horizontal then
// a vertical distance search (exact within the width, so wide strokes stay
// round), then the stroke. Settings come from `params` on every apply, since
// one instance draws many objects in turn.
import {hexToRgb} from '@/common/components/video/editor/VideoEditorUtils';
import BaseGLEffect from '@/common/components/video/effects/BaseGLEffect';
import {
  EffectFrameContext,
  EffectInit,
  EffectParams,
} from '@/common/components/video/effects/Effect';
import vertexShaderSource from '@/common/components/video/effects/shaders/DefaultVert.vert?raw';
import fragmentShaderSource from '@/common/components/video/effects/shaders/Outline.frag?raw';
import coverShaderSource from '@/common/components/video/effects/shaders/OutlineCover.frag?raw';
import spreadShaderSource from '@/common/components/video/effects/shaders/OutlineSpread.frag?raw';
import Logger from '@/common/logger/Logger';
import {Tracklet} from '@/common/tracker/Tracker';
import {preAllocateTextures} from '@/common/utils/ShaderUtils';
import {RLEObject, decode} from '@/jscocotools/mask';
import invariant from 'invariant';
import {CanvasForm} from 'pts';

const MASK_SLOTS = 3;
// Texture units: masks 0-2, then the two intermediate textures.
const COVER_UNIT = MASK_SLOTS;
const SPREAD_UNIT = MASK_SLOTS + 1;

// ponytail: duplicates the Outline defaults/ranges in EFFECT_SPECS (feat/effect-clips); read them from there once merged
export const OUTLINE_DEFAULTS = {width: 0.006, color: 'layer', opacity: 1, softness: 0.25, style: 'Outline'};

export type OutlineSettings = {width: number; color: string; opacity: number; softness: number; glow: boolean};

/** The effect's settings from raw params: defaults for missing or invalid values, numbers clamped to range. */
export function resolveOutlineParams(params: EffectParams): OutlineSettings {
  const num = (key: 'width' | 'opacity' | 'softness', min: number, max: number) => {
    const v = params[key];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : OUTLINE_DEFAULTS[key];
  };
  const color = params.color;
  return {
    width: num('width', 0.002, 0.05),
    color: typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : 'layer',
    opacity: num('opacity', 0, 1),
    softness: num('softness', 0, 1),
    glow: params.style === 'Glow',
  };
}

/** The stroke colour as 0..1 RGB: the layer's mask colour for 'layer', else the '#rrggbb' given. */
export function outlineRgb(color: string, layerColor: string): [number, number, number] {
  const {r, g, b} = hexToRgb(color === 'layer' ? layerColor : color);
  return [r / 255, g / 255, b / 255];
}

export default class OutlineGLEffect extends BaseGLEffect {
  private _coverProgram: WebGLProgram | null = null;
  private _spreadProgram: WebGLProgram | null = null;
  private _maskTextures: WebGLTexture[] = [];
  private _targets: WebGLTexture[] = []; // [cover, spread]
  private _framebuffers: WebGLFramebuffer[] = [];

  constructor() {
    super(1);
    this.vertexShaderSource = vertexShaderSource;
    this.fragmentShaderSource = fragmentShaderSource;
  }

  protected setupUniforms(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    init: EffectInit,
  ): void {
    super.setupUniforms(gl, program, init);
    this._coverProgram = this._link(gl, coverShaderSource);
    this._spreadProgram = this._link(gl, spreadShaderSource);

    this._maskTextures = preAllocateTextures(gl, MASK_SLOTS);
    for (const texture of this._maskTextures) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    this._targets = preAllocateTextures(gl, 2);
    this._framebuffers = this._targets.map(texture => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, init.width, init.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      invariant(fb !== null, 'framebuffer required');
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      return fb;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private _link(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram {
    const program = gl.createProgram();
    invariant(program !== null, 'program required');
    for (const [type, source] of [
      [gl.VERTEX_SHADER, this.vertexShaderSource],
      [gl.FRAGMENT_SHADER, fragmentSource],
    ] as const) {
      const shader = gl.createShader(type);
      invariant(shader !== null, 'shader required');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader); // freed with the program
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      Logger.error(gl.getProgramInfoLog(program));
    }
    return program;
  }

  apply(form: CanvasForm, context: EffectFrameContext, _tracklets: Tracklet[]) {
    const gl = this._gl;
    const program = this._program;
    const cover = this._coverProgram;
    const spread = this._spreadProgram;
    invariant(gl !== null, 'WebGL2 context is required');
    if (program === null || cover === null || spread === null) {
      return;
    }
    const masks = context.masks.slice(0, MASK_SLOTS);
    if (masks.length === 0) {
      return;
    }
    const {width, height} = context;
    const s = resolveOutlineParams(this.params);
    const widthPx = s.width * height;
    const radius = Math.ceil(widthPx + 1);
    const at = (p: WebGLProgram, name: string) => gl.getUniformLocation(p, name);

    gl.viewport(0, 0, width, height);

    // Pass 1: masks -> coverage
    gl.useProgram(cover);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    masks.forEach((mask, index) => {
      const maskData = decode([mask.bitmap as RLEObject]).data as Uint8Array;
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, this._maskTextures[index]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, height, width, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, maskData);
    });
    for (let i = 0; i < MASK_SLOTS; i++) {
      gl.uniform1i(at(cover, `uMaskTexture${i}`), i);
    }
    gl.uniform1i(at(cover, 'uNumMasks'), masks.length);
    gl.uniform1f(at(cover, 'uSpread'), 0.5 + 1.5 * s.softness);
    gl.uniform2f(at(cover, 'uSize'), width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._framebuffers[0]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 2: horizontal distance
    gl.useProgram(spread);
    gl.activeTexture(gl.TEXTURE0 + COVER_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this._targets[0]);
    gl.uniform1i(at(spread, 'uCover'), COVER_UNIT);
    gl.uniform1i(at(spread, 'uRadius'), radius);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._framebuffers[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 3: vertical distance + stroke, to the canvas
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0 + SPREAD_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this._targets[1]);
    gl.uniform1i(at(program, 'uSpread'), SPREAD_UNIT);
    gl.uniform1i(at(program, 'uNumMasks'), masks.length);
    gl.uniform1i(at(program, 'uRadius'), radius);
    gl.uniform1f(at(program, 'uWidth'), widthPx);
    gl.uniform1f(at(program, 'uSoftness'), s.softness);
    gl.uniform1f(at(program, 'uOpacity'), s.opacity);
    gl.uniform1i(at(program, 'uGlow'), s.glow ? 1 : 0);
    for (let i = 0; i < MASK_SLOTS; i++) {
      gl.uniform3fv(at(program, `uColor${i}`), outlineRgb(s.color, context.maskColors[i] ?? ''));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    invariant(this._canvas !== null, 'canvas is required');
    form.ctx.drawImage(this._canvas, 0, 0);
  }

  async cleanup(): Promise<void> {
    super.cleanup();
    const gl = this._gl;
    if (gl != null) {
      [...this._maskTextures, ...this._targets].forEach(t => gl.deleteTexture(t));
      this._framebuffers.forEach(fb => gl.deleteFramebuffer(fb));
      [this._coverProgram, this._spreadProgram].forEach(p => p != null && gl.deleteProgram(p));
    }
    this._maskTextures = [];
    this._targets = [];
    this._framebuffers = [];
    this._coverProgram = null;
    this._spreadProgram = null;
  }
}
