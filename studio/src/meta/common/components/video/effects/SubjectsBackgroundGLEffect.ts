// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Background effects that keep the tracked subjects sharp: Replace background
// (a colour, gradient or picture behind them) and Colour pop (everything else
// grey). Unlike the other background effects they get every tracked layer's
// mask on the frame (EffectSpec.subjects; ObjectHighlight passes them) and
// draw the frame's own pixels inside their union, so a subject stays as it is
// in the video; a layer's own clips still draw over it. One pass: the union
// is made on the CPU into one buffer and one texture (both made once), since
// passes of three masks each would each paint over the subjects the pass
// before kept. A picture is uploaded only when it changes.
import {hexToRgb} from '@/common/components/video/editor/VideoEditorUtils';
import BaseGLEffect from '@/common/components/video/effects/BaseGLEffect';
import type {EffectFrameContext, EffectInit, EffectMask, EffectParams} from '@/common/components/video/effects/Effect';
import {FEATHER_REACH, numberParam} from '@/common/components/video/effects/EffectParamSpecs';
import vertexShaderSource from '@/common/components/video/effects/shaders/DefaultVert.vert?raw';
import fragmentShaderSource from '@/common/components/video/effects/shaders/SubjectsBackground.frag?raw';
import type {Tracklet} from '@/common/tracker/Tracker';
import {preAllocateTextures} from '@/common/utils/ShaderUtils';
import type {RLEObject} from '@/jscocotools/mask';
import invariant from 'invariant';
import type {CanvasForm} from 'pts';

export type SubjectsMode = 'ReplaceBackground' | 'ColorPop';

const UNIFORMS = ['uSampler', 'uSubjects', 'uImage', 'uSize', 'uMode', 'uFill', 'uColor', 'uColor2', 'uDirection', 'uImageRect', 'uFeather', 'uAmount', 'uContrast'] as const;
type Uniform = (typeof UNIFORMS)[number];

/**
 * The union of `masks` (COCO RLE, column-major) into `out`: 255 inside any,
 * else 0. Decodes the run lengths straight into `out`, allocating nothing.
 */
export function unionMasks(masks: ReadonlyArray<EffectMask>, out: Uint8Array): void {
  out.fill(0);
  for (const mask of masks) {
    const s = (mask.bitmap as RLEObject).counts;
    // as jscocotools' rleFrString: 5-bit groups, each count after the second relative to the one two back
    let p = 0;
    let i = 0;
    let at = 0;
    let back2 = 0;
    let back1 = 0;
    while (p < s.length) {
      let x = 0;
      let k = 0;
      let more = 1;
      while (more) {
        const c = s.charCodeAt(p) - 48;
        x |= (c & 0x1f) << (5 * k);
        more = c & 0x20;
        p++;
        k++;
        if (!more && c & 0x10) {
          x |= -1 << (5 * k);
        }
      }
      if (i > 2) {
        x += back2;
      }
      back2 = back1;
      back1 = x;
      if (i % 2 === 1) {
        out.fill(255, at, Math.min(at + x, out.length)); // odd runs are inside
      }
      at += x;
      i++;
    }
  }
}

/** A picture's place in the frame (Cover fills it, Contain shows all of it), as offset and size in 0..1 frame coordinates. */
export function imageRect(fit: string, image: {width: number; height: number}, width: number, height: number): [number, number, number, number] {
  const s = (fit === 'Contain' ? Math.min : Math.max)(width / image.width, height / image.height);
  const w = (image.width * s) / width;
  const h = (image.height * s) / height;
  return [(1 - w) / 2, (1 - h) / 2, w, h];
}

/** A CSS linear-gradient angle (0: to the top, 90: to the right) as the step along it per px, so 0..1 spans corner to corner. */
export function gradientDirection(degrees: number, width: number, height: number): [number, number] {
  const r = (degrees * Math.PI) / 180;
  const [x, y] = [Math.sin(r), -Math.cos(r)];
  const length = Math.abs(width * x) + Math.abs(height * y);
  return [x / length, y / length];
}

export default class SubjectsBackgroundGLEffect extends BaseGLEffect {
  private _subjects = new Uint8Array(0);
  private _subjectsTexture: WebGLTexture | null = null;
  private _imageTexture: WebGLTexture | null = null;
  private _uploaded: ImageBitmap | null = null;
  private _at: Partial<Record<Uniform, WebGLUniformLocation | null>> = {};

  constructor(private readonly _mode: SubjectsMode) {
    super(1);
    this.vertexShaderSource = vertexShaderSource;
    this.fragmentShaderSource = fragmentShaderSource;
  }

  protected setupUniforms(gl: WebGL2RenderingContext, program: WebGLProgram, init: EffectInit): void {
    super.setupUniforms(gl, program, init);
    this._at = Object.fromEntries(UNIFORMS.map(u => [u, gl.getUniformLocation(program, u)]));
    [this._subjectsTexture, this._imageTexture] = preAllocateTextures(gl, 2);
    gl.bindTexture(gl.TEXTURE_2D, this._imageTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // one texel until a picture comes: never an empty texture on its unit
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.bindTexture(gl.TEXTURE_2D, this._frameTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._subjects = new Uint8Array(init.width * init.height);
    this._uploaded = null;
  }

  apply(form: CanvasForm, context: EffectFrameContext, _tracklets: Tracklet[]) {
    const gl = this._gl;
    const program = this._program;
    if (!program) {
      return;
    }
    invariant(gl !== null, 'WebGL2 context is required');
    const {width, height} = context;
    const at = this._at;
    const p: EffectParams = this.params;

    gl.useProgram(program);
    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._frameTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, context.frame);

    if (this._subjects.length !== width * height) {
      this._subjects = new Uint8Array(width * height); // only if the frame size is not the one set up for
    }
    unionMasks(context.masks, this._subjects);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._subjectsTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, height, width, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, this._subjects);

    // a picture this browser does not have: the colour instead
    const image = this._mode === 'ReplaceBackground' && p.style === 'Image' ? (context.images?.get(String(p.image)) ?? null) : null;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._imageTexture);
    if (image != null && image !== this._uploaded) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      this._uploaded = image;
    }

    const fill = p.style === 'Gradient' ? 1 : image != null ? 2 : 0;
    const c1 = hexToRgb(String(p.color ?? ''));
    const c2 = hexToRgb(String(p.color2 ?? ''));
    gl.uniform1i(at.uSampler!, 0);
    gl.uniform1i(at.uSubjects!, 1);
    gl.uniform1i(at.uImage!, 2);
    gl.uniform2f(at.uSize!, width, height);
    gl.uniform1i(at.uMode!, this._mode === 'ColorPop' ? 1 : 0);
    gl.uniform1i(at.uFill!, this._mode === 'ColorPop' ? 0 : fill);
    gl.uniform3f(at.uColor!, c1.r / 255, c1.g / 255, c1.b / 255);
    gl.uniform3f(at.uColor2!, c2.r / 255, c2.g / 255, c2.b / 255);
    if (this._mode === 'ReplaceBackground') {
      const [dx, dy] = gradientDirection(numberParam('ReplaceBackground', 'angle', p), width, height);
      gl.uniform2f(at.uDirection!, dx, dy);
      const [x, y, w, h] = image == null ? [0, 0, 1, 1] : imageRect(String(p.fit), image, width, height);
      gl.uniform4f(at.uImageRect!, x, y, w, h);
      // a box of half-width f/sqrt(3) has the spread of the layer Blur's feather (as the layer Pixelate's)
      gl.uniform1f(at.uFeather!, (numberParam('ReplaceBackground', 'feather', p) * FEATHER_REACH * height) / Math.sqrt(3));
      gl.uniform1f(at.uAmount!, 0);
      gl.uniform1f(at.uContrast!, 1);
    } else {
      gl.uniform2f(at.uDirection!, 0, 0);
      gl.uniform4f(at.uImageRect!, 0, 0, 1, 1);
      gl.uniform1f(at.uFeather!, 0);
      gl.uniform1f(at.uAmount!, numberParam('ColorPop', 'amount', p));
      gl.uniform1f(at.uContrast!, numberParam('ColorPop', 'contrast', p));
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    invariant(this._canvas !== null, 'canvas is required');
    form.ctx.drawImage(this._canvas, 0, 0);
  }

  async cleanup(): Promise<void> {
    super.cleanup();
    const gl = this._gl;
    if (gl != null) {
      gl.deleteTexture(this._subjectsTexture);
      gl.deleteTexture(this._imageTexture);
    }
    this._subjectsTexture = null;
    this._imageTexture = null;
    this._uploaded = null;
    this._at = {};
  }
}
