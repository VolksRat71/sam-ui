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
import {Effects} from '@/common/components/video/effects/Effects';
import {Tracklet} from '@/common/tracker/Tracker';
import {RLEObject} from '@/jscocotools/mask';
import {CanvasForm} from 'pts';

export type EffectLayers = {
  background: keyof Effects;
  highlight: keyof Effects;
};

export type EffectOptions = {
  variant: number;
};

export type EffectParamValue = number | string | boolean;
export type EffectParams = Record<string, EffectParamValue>;

export type EffectInit = {
  width: number;
  height: number;
  gl?: WebGL2RenderingContext;
  canvas?: OffscreenCanvas;
};

export type EffectMask = {
  bitmap: ImageBitmap | RLEObject;
  bounds: [[number, number], [number, number]];
};

export type EffectActionPoint = {
  objectId: number;
  position: [number, number];
};

export type EffectFrameContext = {
  frameIndex: number;
  totalFrames: number;
  fps: number;
  width: number;
  height: number;
  masks: EffectMask[];
  maskColors: string[];
  frame: ImageBitmap;
  timeParameter?: number;
  /** Clip-local video time in seconds: (frame - clip.start + clip.phase) / fps (sam-ui). */
  time?: number;
  /** The clip's animation length in seconds: (clip.end - clip.start + clip.phase) / fps (sam-ui). */
  duration?: number;
  /** Pictures the clips use, by their key (state/effectImages.ts); missing ones are not in this browser (sam-ui). */
  images?: ReadonlyMap<string, ImageBitmap>;
  /** Its clip's id as a number (clipSeed), set for effects whose randomness is the clip's own (EffectSpec.seeded) (sam-ui). */
  seed?: number;
  actionPoint: EffectActionPoint | null;
};

/** An effect's clock in seconds: its clip's time, else (Meta's own slots) the video's frame over fps (sam-ui). */
export function effectTime(context: EffectFrameContext): number {
  return context.time ?? context.frameIndex / (context.fps > 0 ? context.fps : 30);
}

/**
 * effectTime as frames at 24 fps, the frame index Meta's animated shaders
 * were tuned on: the same look as before on a 24 fps video, at any frame rate,
 * counted from the clip's start (sam-ui).
 */
export function effectFrame(context: EffectFrameContext): number {
  return effectTime(context) * 24;
}

/** A clip id as a 32-bit seed (FNV-1a): the same id, the same particles, wherever the clip is drawn (sam-ui). */
export function clipSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

export interface Effect {
  variant: number;
  numVariants: number;
  params: EffectParams;
  nextVariant(): void;
  setParams(params: EffectParams): void;
  setup(init: EffectInit): Promise<void>;
  update(options: EffectOptions): Promise<void>;
  cleanup(): Promise<void>;
  apply(
    form: CanvasForm,
    context: EffectFrameContext,
    tracklets: Tracklet[],
  ): void;
}

export abstract class AbstractEffect implements Effect {
  public numVariants: number;
  public variant: number;
  params: EffectParams = {};

  constructor(numVariants: number) {
    this.numVariants = numVariants;
    this.variant = 0;
  }

  nextVariant() {
    // Cycle through variants
    this.variant = (this.variant + 1) % this.numVariants;
  }

  async setup(_init: EffectInit): Promise<void> {
    // noop
  }

  async update(options: EffectOptions): Promise<void> {
    this.variant = options.variant;
  }

  setParams(params: EffectParams): void {
    this.params = params;
  }

  async cleanup(): Promise<void> {
    // noop
  }

  abstract apply(
    form: CanvasForm,
    context: EffectFrameContext,
    tracklets: Tracklet[],
  ): void;
}
