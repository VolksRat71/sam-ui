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
// Modified by sam-ui: Meta's BackgroundBlurEffect drew a 625-tap box at its
// strongest, counted the centre texel twice and wrapped round the frame's
// edges. Now a separable Gaussian in two passes on this effect's own context
// (resources made once in setup), its radius a fraction of the frame height
// from params, with the box's spread at the same radius, so the Light/Medium/
// Strong styles look as the 3/6/12 px boxes did at 720p. `masked` makes it
// the layer Blur: each mask blurred from its own pixels only (nothing from
// the background or another object bleeds into its edge), drawn inside it
// with a feathered edge.
import BaseGLEffect from '@/common/components/video/effects/BaseGLEffect';
import {
  EffectFrameContext,
  EffectInit,
  EffectParams,
} from '@/common/components/video/effects/Effect';
import {FEATHER_REACH, numberParam} from '@/common/components/video/effects/EffectParamSpecs';
import fragmentShaderSource from '@/common/components/video/effects/shaders/Blur.frag?raw';
import vertexShaderSource from '@/common/components/video/effects/shaders/DefaultVert.vert?raw';
import {Tracklet} from '@/common/tracker/Tracker';
import {preAllocateTextures} from '@/common/utils/ShaderUtils';
import {RLEObject, decode} from '@/jscocotools/mask';
import invariant from 'invariant';
import {CanvasForm} from 'pts';

const MASK_SLOTS = 3;
// Texture units: the frame 0, masks 1-3, then pass 1's outputs: a colour per mask 4-6, the feathers 7.
const PASS1_UNIT = MASK_SLOTS + 1;
const FEATHER = MASK_SLOTS; // the feathers' attachment
// pass 1's attachments: a colour per mask and the feathers; the background is one mask
const LAYER_SLOTS = [0, 1, 2, FEATHER];
const BACKGROUND_SLOTS = [0, FEATHER];

/** The Gaussian's sigma with the spread of a (2r+1)-tap box: sqrt(r(r+1)/3). */
export function blurSigma(radiusPx: number): number {
  return Math.sqrt((radiusPx * (radiusPx + 1)) / 3);
}

export type BlurSettings = {sigma: number; taps: number; featherSigma: number; featherTaps: number};

/** What the passes draw with, in pixels of a frame `height` tall: the radius in whole pixels, taps out to 3 sigma. */
export function resolveBlurParams(effect: 'BackgroundBlur' | 'BlurMask', params: EffectParams, height: number): BlurSettings {
  const sigma = blurSigma(Math.max(1, Math.round(numberParam(effect, 'radius', params) * height)));
  const featherPx = effect === 'BlurMask' ? numberParam(effect, 'feather', params) * FEATHER_REACH * height : 0;
  return {sigma, taps: Math.ceil(3 * sigma), featherSigma: featherPx / 3, featherTaps: Math.ceil(featherPx)};
}

export default class BlurGLEffect extends BaseGLEffect {
  private _maskTextures: WebGLTexture[] = [];
  private _targets: WebGLTexture[] = []; // pass 1's, by slot (LAYER_SLOTS / BACKGROUND_SLOTS)
  private _framebuffer: WebGLFramebuffer | null = null;

  constructor(private readonly _masked = false) {
    super(3);

    this.vertexShaderSource = vertexShaderSource;
    this.fragmentShaderSource = fragmentShaderSource;
  }

  protected setupUniforms(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    init: EffectInit,
  ): void {
    super.setupUniforms(gl, program, init);
    gl.bindTexture(gl.TEXTURE_2D, this._frameTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._maskTextures = this._masked ? preAllocateTextures(gl, MASK_SLOTS) : [];

    const slots = this._masked ? LAYER_SLOTS : BACKGROUND_SLOTS;
    this._targets = preAllocateTextures(gl, slots.length);
    const fb = gl.createFramebuffer();
    invariant(fb !== null, 'framebuffer required');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const attachments = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3];
    this._targets.forEach((target, i) => {
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, init.width, init.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, attachments[slots[i]], gl.TEXTURE_2D, target, 0);
    });
    gl.drawBuffers(attachments.map((a, i) => (slots.includes(i) ? a : gl.NONE)));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._framebuffer = fb;
  }

  apply(form: CanvasForm, context: EffectFrameContext, _tracklets: Tracklet[]) {
    const gl = this._gl;
    const program = this._program;
    if (!program) {
      return;
    }
    invariant(gl !== null, 'WebGL2 context is required');
    const masks = this._masked ? context.masks.slice(0, MASK_SLOTS) : [];
    if (this._masked && masks.length === 0) {
      return;
    }
    const {width, height} = context;
    const s = resolveBlurParams(this._masked ? 'BlurMask' : 'BackgroundBlur', this.params, height);
    const at = (name: string) => gl.getUniformLocation(program, name);

    gl.useProgram(program);
    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._frameTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, context.frame);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    masks.forEach((mask, index) => {
      const maskData = decode([mask.bitmap as RLEObject]).data as Uint8Array;
      gl.activeTexture(gl.TEXTURE0 + 1 + index);
      gl.bindTexture(gl.TEXTURE_2D, this._maskTextures[index]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, height, width, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, maskData);
    });

    gl.uniform1i(at('uSampler'), 0);
    for (let i = 0; i < MASK_SLOTS; i++) {
      gl.uniform1i(at(`uMaskTexture${i}`), 1 + i);
    }
    for (let i = 0; i < MASK_SLOTS; i++) {
      gl.uniform1i(at(`uPass1_${i}`), PASS1_UNIT + i);
    }
    gl.uniform1i(at('uFeather'), PASS1_UNIT + FEATHER);
    gl.uniform1i(at('uNumMasks'), masks.length);
    gl.uniform2f(at('uSize'), width, height);
    gl.uniform1f(at('uSigma'), s.sigma);
    gl.uniform1i(at('uTaps'), s.taps);
    gl.uniform1f(at('uFeatherSigma'), s.featherSigma);
    gl.uniform1i(at('uFeatherTaps'), s.featherTaps);

    // Pass 1: across, to the texture
    gl.uniform1i(at('uVertical'), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._framebuffer);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 2: down, to the canvas
    const slots = this._masked ? LAYER_SLOTS : BACKGROUND_SLOTS;
    this._targets.forEach((target, i) => {
      gl.activeTexture(gl.TEXTURE0 + PASS1_UNIT + slots[i]);
      gl.bindTexture(gl.TEXTURE_2D, target);
    });
    gl.uniform1i(at('uVertical'), 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // unbind pass 1's outputs: still bound when the next pass 1 draws into them, the
    // one program samples them there (a feedback loop: Chrome drops that draw, freezing the blur)
    slots.forEach(slot => {
      gl.activeTexture(gl.TEXTURE0 + PASS1_UNIT + slot);
      gl.bindTexture(gl.TEXTURE_2D, null);
    });

    invariant(this._canvas !== null, 'canvas is required');
    form.ctx.drawImage(this._canvas, 0, 0);
  }

  async cleanup(): Promise<void> {
    super.cleanup();
    const gl = this._gl;
    if (gl != null) {
      [...this._maskTextures, ...this._targets].forEach(t => gl.deleteTexture(t));
      if (this._framebuffer != null) {
        gl.deleteFramebuffer(this._framebuffer);
      }
    }
    this._maskTextures = [];
    this._targets = [];
    this._framebuffer = null;
  }
}
