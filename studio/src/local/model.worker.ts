// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The browser SAM 2 engine's own worker: onnxruntime-web (WebGPU), the five
// SAM 2.1 tiny graphs, the per-frame feature cache and the tracker. It has no
// video of its own: it asks its host for frames (needFrame) as it needs them.
import * as ort from 'onnxruntime-web/webgpu';
import {FEATURE_CACHE_BYTES} from '~/budgets';
import {loadModelFile} from './models';
import type {FromWorker, ModelMethod, ModelMethods, ToWorker, VideoShape} from './modelProtocol';
import {type Quality, VARIANTS} from './sam2/config';
import {OrtSam2Models, type Pixels} from './sam2/ortModels';
import {Sam2Tracker} from './sam2/tracker';

// GitHub Pages cannot send the headers that cross-origin isolation (and so
// wasm threads) needs; WebGPU does the work anyway.
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let models: OrtSam2Models | null = null;
let loading: Promise<OrtSam2Models> | null = null;
let quality: Quality | null = null;
let ep: 'webgpu' | 'wasm' | null = null;
let video: (VideoShape & {key: string; fillHoleArea: number}) | null = null;
let tracker: Sam2Tracker | null = null;
const jobs = new Map<string, AbortController>();

let nextReq = 1;
const frameWaits = new Map<number, {resolve: (b: ImageBitmap) => void; reject: (e: Error) => void}>();

function requestFrame(frame: number, size: number): Promise<ImageBitmap> {
  const req = nextReq++;
  return new Promise((resolve, reject) => {
    frameWaits.set(req, {resolve, reject});
    post({type: 'needFrame', req, frame, size});
  });
}

/** Time spent waiting for the host's frames, and turning them into pixels. */
const frameTimes = {n: 0, waitMs: 0, pixelsMs: 0};

async function framePixels(frame: number, size: number): Promise<Pixels> {
  const t0 = performance.now();
  const bitmap = await requestFrame(frame, size);
  const t1 = performance.now();
  try {
    return models!.pixelsOf(bitmap);
  } finally {
    bitmap.close();
    frameTimes.n++;
    frameTimes.waitMs += t1 - t0;
    frameTimes.pixelsMs += performance.now() - t1;
  }
}

async function load(q: Quality, wanted: 'webgpu' | 'wasm'): Promise<OrtSam2Models> {
  if (models != null && quality === q && ep === wanted) {
    return models;
  }
  const variant = VARIANTS[q];
  const old = models;
  models = null;
  tracker = null;
  await old?.release();
  const created = await OrtSam2Models.create(ort, {
    ep: wanted,
    load: file =>
      loadModelFile(variant, file, p => post({type: 'event', event: {type: 'progress', quality: q, ...p}})),
    frames: framePixels,
    cacheBytes: FEATURE_CACHE_BYTES[q],
  });
  models = created;
  quality = q;
  ep = wanted;
  return created;
}

function trackerFor(m: OrtSam2Models): Sam2Tracker {
  if (video == null) {
    throw new Error('the model worker has no video (configure first)');
  }
  tracker ??= new Sam2Tracker(m, video);
  return tracker;
}

function loaded(): OrtSam2Models {
  if (models == null) {
    throw new Error('no model loaded');
  }
  return models;
}

type Handlers = {[M in ModelMethod]: (args: ModelMethods[M]['args']) => Promise<ModelMethods[M]['result']>};

const handlers: Handlers = {
  load: async ({quality: q, ep: wanted}) => {
    const t0 = performance.now();
    const target = wanted ?? ('gpu' in navigator ? 'webgpu' : 'wasm');
    loading = load(q, target);
    try {
      await loading;
    } finally {
      loading = null;
    }
    return {quality: q, ms: performance.now() - t0, bytes: VARIANTS[q].bytes};
  },
  configure: async shape => {
    if (video?.key !== shape.key) {
      models?.clearCache();
    }
    video = shape;
    tracker = null;
  },
  click: async ({frame, points}) => {
    const m = await (loading ?? Promise.resolve(loaded()));
    const t0 = performance.now();
    const res = await trackerFor(m).click(frame, points);
    return {rle: res.rle, objectScore: res.objectScore, ms: performance.now() - t0};
  },
  track: async ({job, objects, window}) => {
    const m = await (loading ?? Promise.resolve(loaded()));
    const ac = new AbortController();
    jobs.set(job, ac);
    const t0 = performance.now();
    // a job gets its own tracker (its own memories); the feature cache is shared
    const own = new Sam2Tracker(m, video ?? (() => { throw new Error('configure first'); })());
    let frames = 0;
    try {
      for await (const f of own.track(objects, ac.signal, window)) {
        frames++;
        post({type: 'event', event: {type: 'trackFrame', job, frame: f.frame, masks: [...f.masks], ms: f.ms}});
      }
      return {frames, ms: performance.now() - t0, stats: own.stats, canceled: false};
    } catch (error) {
      if (ac.signal.aborted) {
        return {frames, ms: performance.now() - t0, stats: own.stats, canceled: true};
      }
      throw error;
    } finally {
      jobs.delete(job);
    }
  },
  cancel: async ({job}) => {
    const ac = jobs.get(job);
    ac?.abort();
    return ac != null;
  },
  stats: async () => ({
    quality,
    ep,
    cachedFrames: models?.cachedFrames ?? 0,
    cachedBytes: models?.cachedBytes ?? 0,
    times: {...(models?.times ?? {}), frameWait: {n: frameTimes.n, ms: frameTimes.waitMs}, framePixels: {n: frameTimes.n, ms: frameTimes.pixelsMs}},
  }),
};

self.addEventListener('message', async (event: MessageEvent<ToWorker>) => {
  const data = event.data;
  if (data.type === 'frame') {
    const wait = frameWaits.get(data.req);
    frameWaits.delete(data.req);
    if (wait == null) {
      data.bitmap?.close();
    } else if (data.bitmap == null) {
      wait.reject(new Error(data.error ?? 'no frame'));
    } else {
      wait.resolve(data.bitmap);
    }
    return;
  }
  if (data.type === 'call') {
    try {
      const handler = handlers[data.method] as (args: unknown) => Promise<unknown>;
      post({type: 'reply', id: data.id, ok: true, value: await handler(data.args)});
    } catch (error) {
      post({type: 'reply', id: data.id, ok: false, error: error instanceof Error ? error.message : String(error)});
    }
  }
});
