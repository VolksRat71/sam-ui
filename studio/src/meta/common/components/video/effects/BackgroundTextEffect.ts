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
// Modified by sam-ui: paced over its clip (context.time / duration) when it has one.
import {Tracklet} from '@/common/tracker/Tracker';
import {DEMO_SHORT_NAME} from '@/demo/DemoConfig';
import {Bound, CanvasForm, Num, Pt, Shaping} from 'pts';
import {AbstractEffect, EffectFrameContext} from './Effect';

export default class BackgroundTextEffect extends AbstractEffect {
  constructor() {
    super(2);
  }

  apply(
    form: CanvasForm,
    context: EffectFrameContext,
    _tracklets: Tracklet[],
  ): void {
    form.image([0, 0], context.frame);

    const words = ['SEGMENT', 'ANYTHING', 'WOW'];
    const paragraph = `${DEMO_SHORT_NAME} is designed for efficient video processing with streaming inference to enable real-time, interactive applications.`;
    // sam-ui: paced over the clip (its clock), else over the video
    const p =
      context.time != null && context.duration != null && context.duration > 0
        ? context.time / context.duration
        : context.frameIndex / context.totalFrames;
    const progress = p - Math.floor(p); // 0..1, wherever a trimmed clip's clock starts

    // Zooming heading
    if (this.variant % 2 === 0) {
      const wordIndex = Math.floor(progress * words.length);
      const fontSize = context.width / Math.max(4, words[wordIndex].length - 1);
      const sizeMax = fontSize * 1.2;

      const t = Shaping.quadraticInOut(
        Num.cycle(progress * words.length - wordIndex),
      );
      const currentSize = fontSize + Shaping.sineInOut(t, sizeMax - fontSize);
      form.fillOnly('#fff').font(currentSize, 'bold');
      const area = new Pt(
        context.width,
        context.height - (context.height / 4) * (1 - t),
      )
        .toBound()
        .scale(1.5, [context.width / 2, 0]);

      form
        .alignText('center', 'middle')
        .textBox(area, words[wordIndex], 'middle');

      // Scrolling paragraph
    } else {
      const t = Shaping.quadraticInOut(Num.cycle(progress));
      const offset = t * context.height;
      const area = Bound.fromArray([
        [0, -context.height + offset],
        [context.width, context.height],
      ]);
      form.fillOnly('#00000066').rect(area);
      form.fillOnly('#fff').font(context.width / 8, 'bold');
      form
        .fillOnly('#fff')
        .alignText('start')
        .paragraphBox(area, paragraph, 0.8, 'top', false);
    }
  }
}
