// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The browser engine, as studio's video worker uses it: it spawns the model
// worker (a nested worker, so the preview never waits on ONNX Runtime), feeds
// it the frames studio already decoded, loads the chosen export on first
// use, and runs clicks and track jobs. Jobs claim their objects, as the
// backend's jobs do, so two jobs never hold one object.
import type {RLEObject} from '@/jscocotools/mask';
import type {NormPoint} from '~/state/objects';
import {NEEDS_WEBGPU, webGpuAvailable} from '~/lib/webgpu';
import {modelBitmap} from './frames';
import {MemoryTrackStore, type LocalTrackStore, variantKey} from './localTracks';
import {ModelClient, spawnModelWorker} from './modelClient';
import {type Quality, VARIANTS} from './sam2/config';
import type {TrackObject, TrackStats, TrackWindow} from './sam2/tracker';

export type LocalOptions = {quality: Quality; fillHoleArea: number};

export type LocalModelStatus =
  | {status: 'loading'; quality: Quality; loaded: number; total: number}
  | {status: 'ready'; quality: Quality; ms: number}
  | {status: 'failed'; quality: Quality; error: string};

export type LocalVideo = {key: string; numFrames: number; width: number; height: number};

export type LocalHost = {
  /** A decoded frame of the open video, which the engine closes, or null. */
  frame(index: number): Promise<VideoFrame | ImageBitmap | null>;
  /** The open video, once its size and frame count are known. */
  video(): LocalVideo | null;
  onModel(status: LocalModelStatus): void;
};

export type LocalJobResult = {canceled: boolean; frames: number; ms: number; stats: TrackStats | null};

/** One pass of a job: objects tracked together, over the whole clip or one window. */
export type LocalUnit = {objects: TrackObject[]; window?: TrackWindow};

export class LocalEngine {
  private _store: LocalTrackStore;
  private _client: ModelClient | null = null;
  private _opts: LocalOptions = {quality: 512, fillHoleArea: 0};
  private _loaded: {quality: Quality; ready: Promise<void>} | null = null;
  private _configured: string | null = null;
  private _jobs = new Map<string, number[]>();
  /** Jobs cancelled between two of their passes. */
  private _canceled = new Set<string>();
  private _nextJob = 1;

  constructor(
    private readonly _host: LocalHost,
    store?: LocalTrackStore,
  ) {
    this._store = store ?? new MemoryTrackStore();
  }

  get store(): LocalTrackStore {
    return this._store;
  }

  /** Keep tracks elsewhere from now on (OPFS, with no backend). */
  useStore(store: LocalTrackStore): void {
    this._store = store;
  }

  get options(): LocalOptions {
    return this._opts;
  }

  /** The track variant the current options make (a track made otherwise is stale). */
  get variant(): string {
    return variantKey(this._opts.quality, this._opts.fillHoleArea);
  }

  setOptions(opts: LocalOptions): void {
    if (opts.quality !== this._opts.quality && this._jobs.size > 0) {
      throw new Error('a browser track job is running: change the model size when it ends');
    }
    this._opts = {...opts};
  }

  /** Every object a running job holds. */
  heldIds(): Set<number> {
    return new Set([...this._jobs.values()].flat());
  }

  private _clientOrSpawn(): ModelClient {
    if (this._client == null) {
      this._client = new ModelClient(spawnModelWorker(), async (index, size) => {
        const frame = await this._host.frame(index);
        if (frame == null) {
          throw new Error(`frame ${index} is not decoded`);
        }
        try {
          return await modelBitmap(frame, size);
        } finally {
          frame.close(); // the host's frames are the caller's to close
        }
      });
      const loaded = new Map<string, number>();
      this._client.on(e => {
        if (e.type === 'progress') {
          loaded.set(`${e.quality}:${e.file}`, e.loaded);
          const sum = [...loaded].filter(([k]) => k.startsWith(`${e.quality}:`)).reduce((s, [, v]) => s + v, 0);
          this._host.onModel({status: 'loading', quality: e.quality, loaded: sum, total: VARIANTS[e.quality].bytes});
        }
      });
    }
    return this._client;
  }

  /** The model loaded at the current size, and told about the open video. */
  private async _ready(): Promise<ModelClient> {
    if (!(await webGpuAvailable())) {
      throw new Error(NEEDS_WEBGPU); // never a broken engine: no WebGPU, no model
    }
    const client = this._clientOrSpawn();
    const quality = this._opts.quality;
    if (this._loaded?.quality !== quality) {
      this._configured = null;
      const ready = (async () => {
        this._host.onModel({status: 'loading', quality, loaded: 0, total: VARIANTS[quality].bytes});
        try {
          const res = await client.call('load', {quality, ep: 'webgpu'});
          this._host.onModel({status: 'ready', quality, ms: res.ms});
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this._host.onModel({status: 'failed', quality, error: message});
          throw error;
        }
      })();
      this._loaded = {quality, ready};
      ready.catch(() => {
        if (this._loaded?.ready === ready) {
          this._loaded = null; // the next call tries again
        }
      });
    }
    await this._loaded!.ready;
    const video = this._host.video();
    if (video == null) {
      throw new Error('the video is not decoded yet');
    }
    const key = JSON.stringify([video, this._opts.fillHoleArea]);
    if (this._configured !== key) {
      await client.call('configure', {...video, fillHoleArea: this._opts.fillHoleArea});
      this._configured = key;
    }
    return client;
  }

  /** One frame's mask from its clicks. */
  async click(frame: number, points: NormPoint[]): Promise<{rle: RLEObject; ms: number}> {
    const client = await this._ready();
    const res = await client.call('click', {frame, points});
    return {rle: res.rle, ms: res.ms};
  }

  /** Claim `ids` for a new job; returns its id. The caller must run or release it. */
  claim(ids: number[]): string {
    const held = this.heldIds();
    const clash = ids.filter(id => held.has(id));
    if (clash.length > 0) {
      throw new Error(`objects ${clash.join(', ')} are already being tracked`);
    }
    const job = `local-${this._nextJob++}`;
    this._jobs.set(job, [...ids]);
    return job;
  }

  release(job: string): void {
    this._jobs.delete(job);
  }

  isLocalJob(job: string | null): boolean {
    return job != null && job.startsWith('local-');
  }

  /**
   * Run a claimed job, one pass per unit, each with fresh memories (a window
   * never sees another's). `onFrame` gets every frame of every pass. Releases
   * the claim when it ends.
   */
  async run(
    job: string,
    units: LocalUnit[],
    onFrame: (frame: number, masks: Map<number, RLEObject>) => void,
  ): Promise<LocalJobResult> {
    try {
      const client = await this._ready();
      const off = client.on(e => {
        if (e.type === 'trackFrame' && e.job === job) {
          onFrame(e.frame, new Map(e.masks));
        }
      });
      try {
        const total: LocalJobResult = {canceled: false, frames: 0, ms: 0, stats: null};
        for (const unit of units) {
          if (this._canceled.has(job)) {
            return {...total, canceled: true};
          }
          const res = await client.call('track', {job, objects: unit.objects, window: unit.window});
          total.frames += res.frames;
          total.ms += res.ms;
          total.stats = res.stats;
          if (res.canceled) {
            return {...total, canceled: true};
          }
        }
        // where the time went, for the console (per graph, and the frames)
        const stats = await client.call('stats', {}).catch(() => null);
        if (stats != null && total.frames > 0) {
          const per = Object.fromEntries(Object.entries(stats.times).map(([k, v]) => [k, v.n > 0 ? +(v.ms / v.n).toFixed(1) : 0]));
          console.info(`browser engine: ${total.frames} frames in ${(total.ms / 1000).toFixed(1)} s (${(total.ms / total.frames).toFixed(0)} ms a frame); ms per run since load:`, per);
        }
        return total;
      } finally {
        off();
      }
    } finally {
      this._jobs.delete(job);
      this._canceled.delete(job);
    }
  }

  /** Cancel one job, or every job with null. */
  async cancel(job: string | null): Promise<boolean> {
    const jobs = job == null ? [...this._jobs.keys()] : [job];
    const flagged = jobs.filter(j => this._jobs.has(j));
    flagged.forEach(j => this._canceled.add(j)); // a job between two passes stops too
    if (this._client == null || jobs.length === 0) {
      return false;
    }
    const res = await Promise.all(jobs.map(j => this._client!.call('cancel', {job: j})));
    return res.some(Boolean) || flagged.length > 0;
  }

  dispose(): void {
    this._client?.terminate();
    this._client = null;
    this._loaded = null;
    this._configured = null;
  }
}
