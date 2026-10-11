/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Modified by sam-ui: Spotlight's settings (shape, colour, size, ring
// thickness) come from params; its six variants are styles that set them, the
// 'Soft' ones still drawing the fill half see-through. Darken outside is not
// drawn per pass: `dim` draws it once a frame outside every Spotlight circle
// (ObjectHighlight calls it), so Spotlights never dim each other's circles.
import {hexToRgb} from '@/common/components/video/editor/VideoEditorUtils';
import BaseGLEffect from '@/common/components/video/effects/BaseGLEffect';
import {
  EffectFrameContext,
  EffectInit,
} from '@/common/components/video/effects/Effect';
import {numberParam} from '@/common/components/video/effects/EffectParamSpecs';
import vertexShaderSource from '@/common/components/video/effects/shaders/DefaultVert.vert?raw';
import fragmentShaderSource from '@/common/components/video/effects/shaders/Scope.frag?raw';
import {EffectMask} from '@/common/components/video/effects/Effect';
import {Tracklet} from '@/common/tracker/Tracker';
import {normalizeBounds, preAllocateTextures} from '@/common/utils/ShaderUtils';
import {RLEObject, decode} from '@/jscocotools/mask';
import invariant from 'invariant';
import {CanvasForm} from 'pts';

/** The most circles one dim pass cuts out (the shader's arrays; studio's default object limit). */
export const DIM_CIRCLES = 16;

export default class ScopeGLEffect extends BaseGLEffect {
  private _dimBoxes = new Float32Array(4 * DIM_CIRCLES);
  private _dimScales = new Float32Array(DIM_CIRCLES);

  private _numMasks: number = 0;
  private _numMasksUniformLocation: WebGLUniformLocation | null = null;

  // Must from start 2, main texture takes 0 and 1.
  private _masksTextureUnitStart: number = 2;
  private _maskTextures: WebGLTexture[] = [];

  constructor() {
    super(6);
    this.vertexShaderSource = vertexShaderSource;
    this.fragmentShaderSource = fragmentShaderSource;
  }

  protected setupUniforms(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    init: EffectInit,
  ): void {
    super.setupUniforms(gl, program, init);

    this._numMasksUniformLocation = gl.getUniformLocation(program, 'uNumMasks');
    gl.uniform1i(this._numMasksUniformLocation, this._numMasks);

    // We know the max number of textures, pre-allocate 3.
    this._maskTextures = preAllocateTextures(gl, 3);
  }

  apply(form: CanvasForm, context: EffectFrameContext, _tracklets: Tracklet[]) {
    const gl = this._gl;
    const program = this._program;

    if (!program) {
      return;
    }
    invariant(gl !== null, 'WebGL2 context is required');

    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // dynamic uniforms per frame
    gl.uniform1i(this._numMasksUniformLocation, context.masks.length);
    const p = this.params;
    gl.uniform1i(gl.getUniformLocation(program, 'uFillColor'), p.shape === 'Ring' ? 1 : 0);
    gl.uniform1i(
      gl.getUniformLocation(program, 'uTransparency'),
      Math.floor(this.variant / 2) % 3 === 2 ? 1 : 0,
    );
    gl.uniform1f(gl.getUniformLocation(program, 'uScale'), numberParam('Scope', 'size', p));
    gl.uniform1f(gl.getUniformLocation(program, 'uThickness'), numberParam('Scope', 'thickness', p));
    gl.uniform1i(gl.getUniformLocation(program, 'uDimCount'), 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._frameTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      context.width,
      context.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      context.frame,
    );

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // Create and bind 2D textures for each mask
    context.masks.forEach((mask, index) => {
      const decodedMask = decode([mask.bitmap as RLEObject]);
      const maskData = decodedMask.data as Uint8Array;
      gl.activeTexture(gl.TEXTURE0 + index + this._masksTextureUnitStart);
      gl.bindTexture(gl.TEXTURE_2D, this._maskTextures[index]);

      const boundaries = normalizeBounds(
        mask.bounds[0],
        mask.bounds[1],
        context.width,
        context.height,
      );

      // dynamic uniforms per mask
      gl.uniform1i(
        gl.getUniformLocation(program, `uMaskTexture${index}`),
        this._masksTextureUnitStart + index,
      );
      // the layer's colour, or the one chosen (alpha 128 either way: what the Soft styles draw with)
      const color = hexToRgb(p.color === 'layer' || typeof p.color !== 'string' ? context.maskColors[index] : p.color);
      gl.uniform4f(
        gl.getUniformLocation(program, `uMaskColor${index}`),
        color.r,
        color.g,
        color.b,
        color.a,
      );
      gl.uniform4fv(gl.getUniformLocation(program, `bbox${index}`), boundaries);

      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.LUMINANCE,
        context.height,
        context.width,
        0,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        maskData,
      );
    });

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Unbind textures
    gl.bindTexture(gl.TEXTURE_2D, null);
    context.masks.forEach((_, index) => {
      gl.activeTexture(gl.TEXTURE0 + index + this._masksTextureUnitStart);
      gl.bindTexture(gl.TEXTURE_2D, null);
    });

    const ctx = form.ctx;
    invariant(this._canvas !== null, 'canvas is required');
    ctx.drawImage(this._canvas, 0, 0);
  }

  /**
   * Black at `darken` over everything outside the circles of these masks
   * (each at its clip's size), and nothing inside them: Spotlight's darkened
   * outside, drawn once a frame under the circles.
   * ponytail: circles past DIM_CIRCLES are not cut out; a bigger array if the object limit grows.
   */
  dim(form: CanvasForm, context: EffectFrameContext, circles: ReadonlyArray<{mask: EffectMask; size: number}>, darken: number) {
    const gl = this._gl;
    const program = this._program;
    if (!program || circles.length === 0) {
      return;
    }
    invariant(gl !== null, 'WebGL2 context is required');
    const n = Math.min(circles.length, DIM_CIRCLES);
    for (let k = 0; k < n; k++) {
      const [[x0, y0], [x1, y1]] = circles[k].mask.bounds;
      // as normalizeBounds, so a circle's edge falls where its pass draws it
      this._dimBoxes[4 * k] = x0 / context.width;
      this._dimBoxes[4 * k + 1] = y0 / context.height;
      this._dimBoxes[4 * k + 2] = x1 / context.width;
      this._dimBoxes[4 * k + 3] = y1 / context.height;
      this._dimScales[k] = circles[k].size;
    }
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(gl.getUniformLocation(program, 'uDimCount'), n);
    gl.uniform4fv(gl.getUniformLocation(program, 'uDimBox'), this._dimBoxes);
    gl.uniform1fv(gl.getUniformLocation(program, 'uDimScale'), this._dimScales);
    gl.uniform1f(gl.getUniformLocation(program, 'uDarken'), darken);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    invariant(this._canvas !== null, 'canvas is required');
    form.ctx.drawImage(this._canvas, 0, 0);
  }

  async cleanup(): Promise<void> {
    super.cleanup();

    if (this._gl != null) {
      // Delete mask textures to prevent memory leaks
      this._maskTextures.forEach(texture => {
        if (texture != null && this._gl != null) {
          this._gl.deleteTexture(texture);
        }
      });
      this._maskTextures = [];
    }
  }
}
