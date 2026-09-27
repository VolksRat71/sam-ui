// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The browser engine's parity page (e2e/parity.html, driven by
// e2e/parity.mjs). It decodes a fixture clip, runs the model worker on the
// fixture's seeds, and compares every frame with the Python SAM 2.1 tiny
// reference in e2e/fixtures/parity/<clip>.ref.json. The result lands in
// window.__parity (and on the page).
//
// Query: ?clip=squares|twotone&quality=512|1024&fills=0,8&ep=webgpu|wasm
import {ALL_FORMATS, Input, UrlSource, VideoSampleSink} from 'mediabunny';
import type {RLEObject} from '@/jscocotools/mask';
import type {NormPoint} from '~/state/objects';
import {modelBitmap} from './frames';
import {ModelClient, spawnModelWorker} from './modelClient';
import type {ModelEvent} from './modelProtocol';
import {parseQuality} from './sam2/config';
import {rleIou, rleToMask} from './sam2/masks';
import type {TrackObject} from './sam2/tracker';

type Ref = {
  clip: string;
  width: number;
  height: number;
  n_frames: number;
  seeds: Record<string, Record<string, {points: number[][]; labels: number[]}>>;
  frames: Record<string, Record<string, RLEObject>>;
};

type ObjectScore = {min: number; mean: number; minFrame: number; perFrame: number[]};
type RunResult = {
  fillHoleArea: number;
  frames: number;
  trackMs: number;
  msPerFrame: number;
  medianFrameMs: number;
  objects: Record<string, ObjectScore>;
  twotone?: {frames: Array<{frame: number; red: number; orange: number}>; ok: boolean};
  stats: unknown;
};

declare global {
  interface Window {
    __parity?: {ok: true; result: unknown} | {ok: false; error: string};
  }
}

const log = (line: string) => {
  const pre = document.getElementById('log');
  if (pre != null) {
    pre.textContent += `${line}\n`;
  }
  console.log(line);
};

async function decodeClip(url: string): Promise<VideoFrame[]> {
  const input = new Input({source: new UrlSource(url), formats: ALL_FORMATS});
  const track = await input.getPrimaryVideoTrack();
  if (track == null) {
    throw new Error(`${url}: no video track`);
  }
  const frames: VideoFrame[] = [];
  for await (const sample of new VideoSampleSink(track).samples()) {
    frames.push(sample.toVideoFrame());
    sample.close();
  }
  return frames;
}

function objectsOf(ref: Ref): TrackObject[] {
  return Object.entries(ref.seeds).map(([id, perFrame]) => ({
    id: Number(id),
    seeds: Object.entries(perFrame).map(([frame, s]) => ({
      frame: Number(frame),
      points: s.points.map((p, i) => [p[0], p[1], s.labels[i]] as NormPoint),
    })),
  }));
}

/** twotone: how much of the red and the orange half a mask covers (the clip's own geometry). */
function halves(rle: RLEObject, frame: number): {red: number; orange: number} {
  const {mask, width} = rleToMask(rle);
  const x = 30 + 5 * frame;
  const cover = (x0: number, x1: number) => {
    let on = 0;
    let n = 0;
    for (let yy = 100; yy < 150; yy++) {
      for (let xx = Math.max(x0, 0); xx < Math.min(x1, width); xx++) {
        on += mask[yy * width + xx];
        n++;
      }
    }
    return n === 0 ? 0 : on / n;
  };
  return {red: cover(x, x + 50), orange: cover(x + 50, x + 100)};
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
}

async function main(): Promise<unknown> {
  const q = new URLSearchParams(location.search);
  const clip = q.get('clip') ?? 'squares';
  const quality = parseQuality(q.get('quality') ?? 1024);
  const fills = (q.get('fills') ?? '0,8').split(',').map(Number);
  const ep = q.get('ep') === 'wasm' ? 'wasm' : 'webgpu';
  const base = '/e2e/fixtures/parity';
  const ref = (await (await fetch(`${base}/${clip}.ref.json`)).json()) as Ref;
  const frames = await decodeClip(`${base}/${ref.clip}`);
  log(`${clip}: ${frames.length} frames decoded (${frames[0].displayWidth}x${frames[0].displayHeight}), ref ${ref.n_frames}`);
  if (frames.length !== ref.n_frames) {
    throw new Error(`decoded ${frames.length} frames, the reference has ${ref.n_frames}`);
  }

  const client = new ModelClient(spawnModelWorker(), (frame, size) => modelBitmap(frames[frame], size));
  let downloaded = 0;
  client.on((e: ModelEvent) => {
    if (e.type === 'progress' && e.loaded === e.total) {
      downloaded += e.total;
    }
  });
  const loaded = await client.call('load', {quality, ep});
  log(`load ${quality} on ${ep}: ${loaded.ms.toFixed(0)} ms, ${(downloaded / 1e6).toFixed(1)} MB read`);

  // click latency, on a frame the tracker will not start from: cold (the
  // first run of each graph compiles its shaders), repeat (cached features),
  // then another frame (encoder + decoder, warm)
  const video = {numFrames: ref.n_frames, width: ref.width, height: ref.height};
  await client.call('configure', {...video, key: `${clip}-clicks`, fillHoleArea: 0});
  const objects = objectsOf(ref);
  const pts = objects[0].seeds[0].points as NormPoint[];
  const a = ref.n_frames - 1;
  const cold = await client.call('click', {frame: a, points: pts});
  const repeat = await client.call('click', {frame: a, points: pts});
  const warm = await client.call('click', {frame: a - 1, points: pts});
  const repeat2 = await client.call('click', {frame: a - 1, points: pts});
  const clicks = {coldMs: cold.ms, repeatMs: repeat.ms, newFrameWarmMs: warm.ms, repeatWarmMs: repeat2.ms};
  log(`click: cold ${cold.ms.toFixed(0)} ms, repeat ${repeat.ms.toFixed(0)}, new frame ${warm.ms.toFixed(0)}, repeat ${repeat2.ms.toFixed(0)}`);

  const runs: RunResult[] = [];
  for (const [i, fillHoleArea] of fills.entries()) {
    // a new key drops the feature cache, so the first run times the encoder too
    await client.call('configure', {...video, key: `${clip}-track-${i === 0 ? 'cold' : 'warm'}`, fillHoleArea});
    const got = new Map<number, Map<number, RLEObject>>();
    const frameMs: number[] = [];
    const off = client.on(e => {
      if (e.type === 'trackFrame' && e.job === `run-${i}`) {
        got.set(e.frame, new Map(e.masks));
        frameMs.push(e.ms);
      }
    });
    const res = await client.call('track', {job: `run-${i}`, objects});
    off();
    const scores: Record<string, ObjectScore> = {};
    for (const o of objects) {
      const perFrame: number[] = [];
      for (let f = 0; f < ref.n_frames; f++) {
        const mine = got.get(f)?.get(o.id);
        const theirs = ref.frames[String(o.id)][String(f)];
        perFrame.push(mine == null ? 0 : rleIou(mine, theirs));
      }
      const min = Math.min(...perFrame);
      scores[String(o.id)] = {
        min,
        mean: perFrame.reduce((s, v) => s + v, 0) / perFrame.length,
        minFrame: perFrame.indexOf(min),
        perFrame: perFrame.map(v => Math.round(v * 1e4) / 1e4),
      };
    }
    const run: RunResult = {
      fillHoleArea,
      frames: res.frames,
      trackMs: res.ms,
      msPerFrame: res.ms / Math.max(res.frames, 1),
      medianFrameMs: median(frameMs),
      objects: scores,
      stats: res.stats,
    };
    if (clip === 'twotone') {
      const rows = [];
      for (let f = 10; f < ref.n_frames; f++) {
        rows.push({frame: f, ...halves(got.get(f)!.get(0)!, f)});
      }
      run.twotone = {frames: rows, ok: rows.every(r => r.red > 0.9 && r.orange < 0.05)};
    }
    runs.push(run);
    log(
      `fill ${fillHoleArea}: ${res.frames} frames, ${run.msPerFrame.toFixed(0)} ms/frame (median ${run.medianFrameMs.toFixed(0)}); ` +
        Object.entries(scores)
          .map(([id, s]) => `obj ${id} IoU min ${s.min.toFixed(4)} (f${s.minFrame}) mean ${s.mean.toFixed(4)}`)
          .join('; ') +
        (run.twotone != null ? `; red-only after f10: ${run.twotone.ok}` : ''),
    );
  }
  const stats = await client.call('stats', {});
  client.terminate();
  frames.forEach(f => f.close());
  return {clip, quality, ep, load: loaded, downloadedBytes: downloaded, clicks, runs, stats};
}

main().then(
  result => (window.__parity = {ok: true, result}),
  (error: unknown) => {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    log(`FAILED: ${message}`);
    window.__parity = {ok: false, error: message};
  },
);
