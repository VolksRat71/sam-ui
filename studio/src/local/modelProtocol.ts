// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Messages between a host (studio's video worker, or the parity page) and
// the model worker (model.worker.ts). Calls are request/response; the
// worker also pushes events, and asks its host for frames (needFrame), which
// come back as ImageBitmaps at the model's input size, transferred.
import type {RLEObject} from '@/jscocotools/mask';
import type {NormPoint} from '~/state/objects';
import type {Quality} from './sam2/config';
import type {TrackObject, TrackStats, TrackWindow} from './sam2/tracker';

export type VideoShape = {numFrames: number; width: number; height: number};

export type ModelStats = {
  quality: Quality | null;
  ep: string | null;
  cachedFrames: number;
  cachedBytes: number;
  /** Per graph: runs and total ms since load. */
  times: Record<string, {n: number; ms: number}>;
};

export type ModelMethods = {
  /** Load one of the two exports (downloading it if needed); `ep` defaults to webgpu. */
  load: {args: {quality: Quality; ep?: 'webgpu' | 'wasm'}; result: {quality: Quality; ms: number; bytes: number}};
  /** The video the frames come from; a change drops the feature cache. */
  configure: {args: VideoShape & {key: string; fillHoleArea: number}; result: void};
  click: {args: {frame: number; points: NormPoint[]}; result: {rle: RLEObject; objectScore: number; ms: number}};
  /** Resolves when the job ends; frames arrive as `trackFrame` events. */
  /** `window` confines the run to frames lo-hi (absent ranges split an object's track). */
  track: {
    args: {job: string; objects: TrackObject[]; window?: TrackWindow};
    result: {frames: number; ms: number; stats: TrackStats; canceled: boolean};
  };
  cancel: {args: {job: string}; result: boolean};
  stats: {args: Record<string, never>; result: ModelStats};
};
export type ModelMethod = keyof ModelMethods;

export type ModelEvent =
  | {type: 'progress'; quality: Quality; file: string; loaded: number; total: number; source: string}
  | {type: 'trackFrame'; job: string; frame: number; masks: Array<[number, RLEObject]>; ms: number};

export type ToWorker =
  | {type: 'call'; id: number; method: ModelMethod; args: unknown}
  | {type: 'frame'; req: number; bitmap: ImageBitmap | null; error?: string};

export type FromWorker =
  | {type: 'reply'; id: number; ok: true; value: unknown}
  | {type: 'reply'; id: number; ok: false; error: string}
  | {type: 'event'; event: ModelEvent}
  | {type: 'needFrame'; req: number; frame: number; size: number};
