// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Meta's animated effects run on their clip's clock (EffectFrameContext.time,
// and duration for the Text's pacing), not the video's frame index, so a clip
// animates from its own start; Meta's own slots (no time) keep the frame index.
import {CanvasForm} from 'pts';
import {describe, expect, it} from 'vitest';
import ArrowGLEffect from './ArrowGLEffect';
import BackgroundTextEffect from './BackgroundTextEffect';
import {EffectFrameContext, effectFrame, effectTime} from './Effect';
import {setUpGL} from './fakeGL';
import NoisyMaskEffect from './NoisyMaskEffect';
import VibrantMaskEffect from './VibrantMaskEffect';

const base = {frameIndex: 90, totalFrames: 300, fps: 30} as EffectFrameContext;

describe('effectTime', () => {
  it("is the clip's time, else the frame over fps; effectFrame counts it at 24 fps", () => {
    expect(effectTime({...base, time: 1.5})).toBe(1.5);
    expect(effectTime(base)).toBe(3);
    expect(effectTime({...base, fps: 0})).toBe(3); // 30 fps when unknown
    expect(effectFrame({...base, time: 0.5})).toBe(12);
    expect(effectFrame({...base, frameIndex: 48, fps: 24})).toBe(48); // a 24 fps video: the frame index, as before
  });
});

describe.each([
  ['Noisy', () => new NoisyMaskEffect()],
  ['Gradient', () => new VibrantMaskEffect()],
  ['Arrow', () => new ArrowGLEffect()],
])('%s', (_, make) => {
  it("animates on its clip's clock, at any video frame", async () => {
    const {effect, calls, form, context, uniforms} = await setUpGL(make());
    const frameAt = (over: Partial<EffectFrameContext>) => {
      const from = calls.length;
      effect.apply(form, {...context(1), ...over}, []);
      return uniforms(from).get('uCurrentFrame');
    };
    expect(frameAt({frameIndex: 200, time: 0})).toBe(0); // a clip's first frame
    expect(frameAt({frameIndex: 7, time: 0.5})).toBe(12);
    expect(frameAt({frameIndex: 48, fps: 24})).toBe(48); // no clip: the video's frame
  });
});

describe('BackgroundTextEffect', () => {
  /** The words the zooming heading shows (variant 0). */
  const word = (over: Partial<EffectFrameContext>) => {
    const shown: string[] = [];
    const form = new Proxy({ctx: {}} as Record<string, unknown>, {
      get(target, key) {
        if (key in target) return target[key as string];
        return (...args: unknown[]) => {
          if (key === 'textBox') shown.push(args[1] as string);
          return form;
        };
      },
    }) as unknown as CanvasForm;
    new BackgroundTextEffect().apply(form, {...base, width: 640, height: 360, frame: {} as ImageBitmap, ...over} as EffectFrameContext, []);
    return shown[0];
  };

  it("paces its words over the clip's length, not the video's", () => {
    const clip = (time: number) => word({frameIndex: 280, time, duration: 3});
    expect([0, 0.5, 1.2, 2.1, 2.9].map(clip)).toEqual(['SEGMENT', 'SEGMENT', 'ANYTHING', 'WOW', 'WOW']);
  });

  it('wraps a clock past its length, and falls back to the frame over the video', () => {
    expect(word({time: 3.5, duration: 3})).toBe('SEGMENT');
    expect(word({time: -0.5, duration: 3})).toBe('WOW');
    expect([0, 120, 290].map(frameIndex => word({frameIndex}))).toEqual(['SEGMENT', 'ANYTHING', 'WOW']);
  });
});
