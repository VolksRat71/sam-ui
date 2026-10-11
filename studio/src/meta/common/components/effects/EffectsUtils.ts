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
import type {CarbonIconType} from '@carbon/icons-react';
import {
  AppleDash,
  Badge,
  Asterisk,
  Barcode,
  CenterCircle,
  ColorPalette,
  ColorSwitch,
  Development,
  Erase,
  ImageReference,
  FaceWink,
  Humidity,
  Image,
  Lasso,
  MagicWand,
  Opacity,
  Overlay,
  Replicate,
  TextCreation,
  TextFont,
} from '@carbon/icons-react';

export type DemoEffect = {
  title: string;
  Icon: CarbonIconType;
  effectName: keyof Effects;
};

export const backgroundEffects: DemoEffect[] = [
  {title: 'Original', Icon: Image, effectName: 'Original'},
  {title: 'Erase', Icon: Erase, effectName: 'EraseBackground'},
  {
    title: 'Gradient',
    Icon: ColorPalette,
    effectName: 'Gradient',
  },
  {
    title: 'Pixelate',
    Icon: Development,
    effectName: 'Pixelate',
  },
  {title: 'Desaturate', Icon: ColorSwitch, effectName: 'Desaturate'},
  {title: 'Text (demo)', Icon: TextFont, effectName: 'BackgroundText'}, // sam-ui: Meta's fixed copy; Title is the editable one
  {title: 'Blur', Icon: Humidity, effectName: 'BackgroundBlur'},
  {title: 'Edges', Icon: AppleDash, effectName: 'Sobel'}, // sam-ui: 'Outline' is the layer effect
  // sam-ui: backgrounds that keep the tracked subjects sharp
  {title: 'Replace background', Icon: ImageReference, effectName: 'ReplaceBackground'},
  {title: 'Colour pop', Icon: Opacity, effectName: 'ColorPop'},
  {title: 'Title', Icon: TextCreation, effectName: 'Title'}, // sam-ui: an editable title behind the subjects
];

export const highlightEffects: DemoEffect[] = [
  {title: 'Original', Icon: Image, effectName: 'Cutout'},
  {title: 'Erase', Icon: Erase, effectName: 'EraseForeground'},
  {title: 'Gradient', Icon: ColorPalette, effectName: 'VibrantMask'},
  {title: 'Pixelate', Icon: Development, effectName: 'PixelateMask'},
  {title: 'Blur', Icon: Humidity, effectName: 'BlurMask'}, // sam-ui
  {
    title: 'Overlay',
    Icon: Overlay,
    effectName: 'Overlay',
  },
  {title: 'Emoji', Icon: FaceWink, effectName: 'Replace'},
  {title: 'Burst', Icon: Asterisk, effectName: 'Burst'},
  {title: 'Spotlight', Icon: CenterCircle, effectName: 'Scope'},
  {title: 'Outline', Icon: Lasso, effectName: 'Outline'},
  {title: 'Glitter', Icon: MagicWand, effectName: 'Glitter'}, // sam-ui: particles on and around the subject
  {title: 'Sticker', Icon: Badge, effectName: 'Sticker'}, // sam-ui: a shape or picture that follows the layer
  {title: 'Echo', Icon: Replicate, effectName: 'Echo'}, // sam-ui: copies from earlier frames, behind the layer
];

export const moreEffects: DemoEffect[] = [
  {title: 'Noisy', Icon: Barcode, effectName: 'NoisyMask'},
];
