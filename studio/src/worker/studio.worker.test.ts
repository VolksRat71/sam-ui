// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The worker's effect handlers with Meta's context, the session, the encoder
// and the effects faked: an effect edit only redraws (U7), and an export
// stops naming a frame that fails to draw, leaving a selection made during it
// in place (U8).
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {StudioCall, StudioReply} from './protocol';

const h = vi.hoisted(() => ({
  drawn: [] as Array<{form: unknown; effect: string; active?: number | null}>,
  failAt: -1,
  context: null as null | {goToFrame: ReturnType<typeof vi.fn>},
  overlay: null as null | {activeObjectId: number | null},
  session: null as null | Record<string, ReturnType<typeof vi.fn>>,
  midExport: null as null | (() => Promise<void>),
}));

vi.mock('@/common/error/ErrorSerializationUtils', () => ({registerSerializableConstructors: () => {}}));

vi.mock('@/common/components/video/effects/Effects', () => {
  const fake = (name: string) => ({
    numVariants: 4,
    variant: 0,
    params: {},
    setParams() {},
    setup: async () => {},
    cleanup: async () => {},
    apply: (form: unknown) => h.drawn.push({form, effect: name}),
  });
  return {default: {Original: fake('Original'), Overlay: fake('MetaOverlay'), Cutout: fake('Cutout'), PixelateMask: fake('PixelateMask')}};
});

vi.mock('./MaskOverlayEffect', () => ({
  default: class {
    variant = 0;
    activeObjectId: number | null = null;
    faded = () => false;
    constructor() {
      h.overlay = this;
    }
    apply(form: unknown) {
      h.drawn.push({form, effect: 'Overlay', active: this.activeObjectId});
    }
  },
}));

vi.mock('@/common/components/video/VideoWorkerContext', async () => {
  const {default: AllEffects} = await import('@/common/components/video/effects/Effects');
  return {
    default: class {
      width = 8;
      height = 8;
      frameIndex = 0;
      goToFrame = vi.fn();
      _decodedVideo = {fps: 10, numFrames: 3, frames: [{}, {}, {}]};
      // the highlight slot (ObjectHighlight, installed before construction), as Meta's renderer runs it
      highlight = AllEffects.Overlay;
      constructor() {
        h.context = this;
      }
      async _drawFrameImpl(form: unknown, index: number): Promise<boolean> {
        if (index === h.failAt) {
          return false;
        }
        const ctx = {frameIndex: index, fps: 10, width: 8, height: 8, masks: [{bitmap: {}}], maskColors: ['#ff0000']};
        this.highlight.apply(form as never, ctx as never, [{id: 1}] as never);
        return true;
      }
    },
  };
});

vi.mock('./StudioSession', () => ({
  default: class {
    constructor(_context: unknown, overlay: {activeObjectId: number | null}) {
      const track = vi.fn();
      h.session = {
        track,
        setPoints: vi.fn(),
        textPrompt: vi.fn(),
        repaint: vi.fn(),
        setActiveObject: vi.fn((id: number | null) => {
          overlay.activeObjectId = id;
        }),
      };
      Object.assign(this, h.session);
    }
  },
}));

vi.mock('./exportVideo', () => ({
  encodeMp4: async (o: {numFrames: number; draw: (form: unknown, i: number) => Promise<void>}) => {
    const form = {export: true};
    for (let i = 0; i < o.numFrames; i++) {
      await o.draw(form, i);
      if (i === 0) {
        await h.midExport?.();
      }
    }
    return new ArrayBuffer(4);
  },
}));

let listener: (e: {data: unknown}) => Promise<void>;
const replies: StudioReply[] = [];
let id = 0;

async function call(method: StudioCall['method'], args: unknown): Promise<StudioReply> {
  const n = ++id;
  await listener({data: {action: 'studioCall', id: n, method, args}});
  return replies.find(r => r.id === n)!;
}

const doc = (effect: string) => ({
  version: 2,
  clips: [{id: 'c1', target: {kind: 'object', id: 1}, effect, params: {style: 'Fine'}, start: 0, end: 3, row: 0, phase: 0}],
});

describe('studio.worker effect handlers', () => {
  beforeEach(async () => {
    vi.resetModules();
    h.drawn = [];
    h.failAt = -1;
    h.midExport = null;
    replies.length = 0;
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() {
        return {};
      }
    });
    vi.stubGlobal('self', {
      addEventListener: (_type: string, fn: typeof listener) => {
        listener = fn;
      },
      postMessage: (m: StudioReply) => replies.push(m),
    });
    await import('./studio.worker');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('an effect edit only redraws: no tracking, segmenting or repaint (U7)', async () => {
    const reply = await call('setEffectDoc', {doc: doc('PixelateMask'), drawOrder: [1]});
    expect(reply.ok).toBe(true);
    expect(h.context!.goToFrame).toHaveBeenCalledTimes(1);
    for (const spy of Object.values(h.session!)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('an export draws its own clips without editing aids, and a selection made during it survives (U8)', async () => {
    await call('setEffectDoc', {doc: doc('Cutout'), drawOrder: [1]});
    await call('setActiveObject', {objectId: 2});
    h.midExport = async () => {
      await call('setActiveObject', {objectId: 5}); // the person clicks a layer mid-export
      await call('setEffectDoc', {doc: doc('Cutout'), drawOrder: [1]});
    };
    const reply = await call('exportVideo', {doc: {version: 2, clips: []}, drawOrder: [1], untouched: 'shown'});
    expect(reply.ok).toBe(true);
    const exported = h.drawn.filter(d => (d.form as {export?: boolean}).export);
    // every frame from the export's clips (none: untouched 'shown' is the Overlay), never emphasised
    expect(exported.map(d => [d.effect, d.active])).toEqual([0, 1, 2].map(() => ['Overlay', null]));
    expect(h.overlay!.activeObjectId).toBe(5);
  });

  it('a frame that fails to draw stops the export with its number, and the next export runs (U8)', async () => {
    h.failAt = 2;
    const reply = await call('exportVideo', {doc: doc('PixelateMask'), drawOrder: [1], untouched: 'original'});
    expect(reply).toMatchObject({ok: false, error: 'Frame 3 could not be drawn, so the export stopped.'});
    h.failAt = -1;
    expect((await call('exportVideo', {doc: doc('PixelateMask'), drawOrder: [1], untouched: 'original'})).ok).toBe(true);
  });
});
