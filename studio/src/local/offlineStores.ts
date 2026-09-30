// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The no-server stores, ported from the backend's tracks/seeds.py and
// tracks/store.py, over a Kv (OPFS in the app). Keyed like the backend, by
// the video's sha256:
//   seeds/<video>/<obj>/seeds.json   {"<frame>": {"points", "labels", "mask"?}}
//   seeds/<video>/<obj>/object.json  {"name"}: metadata, never in the seeds key
//   seeds/<video>/<obj>/ranges.json  {"ranges": [{start, end, state}]}: absent
//                                    ranges, which do join the seeds key
//   tracks/<video>/<obj>/browser-sam2.json   one browser track
// Removing an object removes its seeds, name and tracks; clearing the last
// seed frame drops its tracks (a track with no seeds could never be redone).
import type {RLEObject} from '@/jscocotools/mask';
import {BROWSER_ENGINE} from '~/state/engines';
import {cleanObjectName} from '~/state/fileNames';
import type {NormPoint, ServerObject} from '~/state/objects';
import {type FrameRange, type RangeState, normalizeRanges, paintRange} from '~/state/ranges';
import {type Kv, readJson, writeJson} from './kv';
import {type LocalTrack, localTrackEntry, type LocalTrackStore, seedsKey, withLocalTracks} from './localTracks';

export type SeedFrame = {points: number[][]; labels: number[]; mask?: RLEObject};
export type Seeds = Map<number, SeedFrame>;

/** The clicks of a seed map, per frame, as the tracker and seedsKey take them. */
export function seedPoints(seeds: Seeds): Map<number, NormPoint[]> {
  const out = new Map<number, NormPoint[]>();
  for (const [f, s] of seeds) {
    if (s.points.length > 0) {
      out.set(f, s.points.map((p, i): NormPoint => [p[0], p[1], s.labels[i] === 0 ? 0 : 1]));
    }
  }
  return out;
}

export class SeedStore {
  constructor(private readonly _kv: Kv) {}

  private _dir(video: string, obj: number): string {
    return `seeds/${video}/${Math.trunc(obj)}`;
  }

  async seeds(video: string, obj: number): Promise<Seeds> {
    const raw = await readJson<Record<string, SeedFrame>>(this._kv, `${this._dir(video, obj)}/seeds.json`);
    return new Map(Object.entries(raw ?? {}).map(([f, v]) => [Number(f), v]));
  }

  /** Every object with a seeds file (or ranges, marked before any click), in id order. */
  async objects(video: string): Promise<number[]> {
    const ids: number[] = [];
    for (const name of await this._kv.list(`seeds/${video}`)) {
      const dir = `seeds/${video}/${name}`;
      if (/^\d+$/.test(name) && ((await this._kv.read(`${dir}/seeds.json`)) != null || (await this._kv.read(`${dir}/ranges.json`)) != null)) {
        ids.push(Number(name));
      }
    }
    return ids.sort((a, b) => a - b);
  }

  private async _save(video: string, obj: number, seeds: Seeds): Promise<void> {
    const out: Record<string, SeedFrame> = {};
    for (const [f, v] of [...seeds].sort((a, b) => a[0] - b[0])) {
      if (v.points.length > 0) {
        out[String(f)] = v;
      }
    }
    await writeJson(this._kv, `${this._dir(video, obj)}/seeds.json`, out);
  }

  /**
   * As SAM 2's add_new_points_or_box: clearOld replaces the frame's points,
   * else they are appended. `mask` (the mask the click made) replaces the
   * frame's approved mask.
   */
  async addPoints(
    video: string,
    obj: number,
    frame: number,
    points: number[][],
    labels: number[],
    clearOld: boolean,
    mask?: RLEObject | null,
  ): Promise<Seeds> {
    const seeds = await this.seeds(video, obj);
    const old = clearOld ? {points: [], labels: []} : (seeds.get(frame) ?? {points: [], labels: []});
    const next: SeedFrame = {
      points: [...old.points, ...points.map(p => [Number(p[0]), Number(p[1])])],
      labels: [...old.labels, ...labels.map(l => Math.trunc(Number(l)))],
    };
    if (mask != null) {
      next.mask = {size: [mask.size[0], mask.size[1]], counts: mask.counts};
    }
    seeds.set(frame, next);
    await this._save(video, obj, seeds);
    return seeds;
  }

  async clearFrame(video: string, obj: number, frame: number): Promise<Seeds> {
    const seeds = await this.seeds(video, obj);
    seeds.delete(frame);
    await this._save(video, obj, seeds);
    return seeds;
  }

  async removeObject(video: string, obj: number): Promise<void> {
    await this._kv.remove(this._dir(video, obj));
  }

  async clearVideo(video: string): Promise<void> {
    await this._kv.remove(`seeds/${video}`);
  }

  async ranges(video: string, obj: number): Promise<FrameRange[]> {
    const raw = await readJson<{ranges?: FrameRange[]}>(this._kv, `${this._dir(video, obj)}/ranges.json`);
    return normalizeRanges(raw?.ranges);
  }

  /** Frames start-end set to `state`, or cleared (null). None left: the file goes. */
  async paintRange(video: string, obj: number, start: number, end: number, state: RangeState | null): Promise<FrameRange[]> {
    const ranges = paintRange(await this.ranges(video, obj), start, end, state);
    const path = `${this._dir(video, obj)}/ranges.json`;
    if (ranges.length === 0) {
      await this._kv.remove(path);
    } else {
      await writeJson(this._kv, path, {ranges});
    }
    return ranges;
  }

  async name(video: string, obj: number): Promise<string | null> {
    const meta = await readJson<{name?: unknown}>(this._kv, `${this._dir(video, obj)}/object.json`);
    return typeof meta?.name === 'string' && meta.name !== '' ? meta.name : null;
  }

  async names(video: string): Promise<Record<number, string>> {
    const out: Record<number, string> = {};
    for (const n of await this._kv.list(`seeds/${video}`)) {
      if (/^\d+$/.test(n)) {
        const name = await this.name(video, Number(n));
        if (name != null) {
          out[Number(n)] = name;
        }
      }
    }
    return out;
  }

  /** Trimmed, at most 64 characters; empty removes the name. Metadata only. */
  async setName(video: string, obj: number, raw: string | null): Promise<string | null> {
    const name = cleanObjectName(raw ?? '');
    const path = `${this._dir(video, obj)}/object.json`;
    if (name == null) {
      await this._kv.remove(path);
    } else {
      await writeJson(this._kv, path, {name});
    }
    return name;
  }
}

type StoredTrack = {objectId: number; seedsKey: string; variant: string; nFrames: number; masks: Array<[number, RLEObject]>};

/** Browser tracks on a Kv: the LocalTrackStore phase 1 kept in memory. */
export class KvTrackStore implements LocalTrackStore {
  constructor(private readonly _kv: Kv) {}

  private _path(video: string, obj: number): string {
    return `tracks/${video}/${Math.trunc(obj)}/${BROWSER_ENGINE}.json`;
  }

  async get(video: string, objectId: number): Promise<LocalTrack | null> {
    const t = await readJson<StoredTrack>(this._kv, this._path(video, objectId));
    if (t == null || !Array.isArray(t.masks)) {
      return null;
    }
    return {objectId: t.objectId, seedsKey: t.seedsKey, variant: t.variant, nFrames: t.nFrames, masks: new Map(t.masks)};
  }

  async list(video: string): Promise<LocalTrack[]> {
    const out: LocalTrack[] = [];
    for (const n of await this._kv.list(`tracks/${video}`)) {
      if (/^\d+$/.test(n)) {
        const t = await this.get(video, Number(n));
        if (t != null) {
          out.push(t);
        }
      }
    }
    return out.sort((a, b) => a.objectId - b.objectId);
  }

  async put(video: string, track: LocalTrack): Promise<void> {
    const stored: StoredTrack = {...track, masks: [...track.masks].sort((a, b) => a[0] - b[0])};
    await writeJson(this._kv, this._path(video, track.objectId), stored);
  }

  async delete(video: string, objectId: number): Promise<void> {
    await this._kv.remove(`tracks/${video}/${Math.trunc(objectId)}`);
  }

  async clear(video: string): Promise<void> {
    await this._kv.remove(`tracks/${video}`);
  }
}

/** An object as startSession / objectTracks describe it, from the seed store (tracks added later). */
export function offlineObject(objectId: number, seeds: Seeds, ranges: ReadonlyArray<FrameRange> = []): ServerObject {
  return {
    objectId,
    state: 'untracked',
    frames: null,
    nFrames: 0,
    seeds: [...seeds]
      .sort((a, b) => a[0] - b[0])
      .map(([frameIndex, s]) => ({frameIndex, points: s.points, labels: s.labels, mask: s.mask ?? null})),
    tracks: [],
    ranges: [...ranges],
  };
}

/**
 * The backend's TrackService, for the browser engine alone and with no
 * server: seeds, names and browser tracks per video, with the same state
 * rules (untracked, stale, tracked, and tracking while a job holds it).
 */
export class OfflineService {
  readonly seeds: SeedStore;
  readonly tracks: KvTrackStore;

  constructor(kv: Kv) {
    this.seeds = new SeedStore(kv);
    this.tracks = new KvTrackStore(kv);
  }

  recordPoints(video: string, obj: number, frame: number, points: NormPoint[], mask: RLEObject | null): Promise<Seeds> {
    return this.seeds.addPoints(video, obj, frame, points.map(p => [p[0], p[1]]), points.map(p => p[2]), true, mask);
  }

  /** Mark frames start-end absent, or clear them (null). The track goes stale, as on the backend. */
  setRange(video: string, obj: number, start: number, end: number, state: RangeState | null): Promise<FrameRange[]> {
    return this.seeds.paintRange(video, obj, start, end, state);
  }

  /** Drop one seed frame; with none left, the object's track goes too. */
  async clearFrame(video: string, obj: number, frame: number): Promise<void> {
    const left = await this.seeds.clearFrame(video, obj, frame);
    if (left.size === 0) {
      await this.tracks.delete(video, obj);
    }
  }

  async removeObject(video: string, obj: number): Promise<void> {
    await this.seeds.removeObject(video, obj);
    await this.tracks.delete(video, obj);
  }

  async clearVideo(video: string): Promise<void> {
    await this.seeds.clearVideo(video);
    await this.tracks.clear(video);
  }

  /** One object as objectTracks gives it: seeds, and the browser track's state. */
  async objectInfo(video: string, obj: number, variant: string, held: ReadonlySet<number>): Promise<ServerObject> {
    const seeds = await this.seeds.seeds(video, obj);
    const ranges = await this.seeds.ranges(video, obj);
    const entry = localTrackEntry(await this.tracks.get(video, obj), {
      seedsKey: seedsKey(seedPoints(seeds), ranges),
      variant,
      running: held.has(obj),
    });
    return withLocalTracks([offlineObject(obj, seeds, ranges)], new Map([[obj, entry]]))[0];
  }

  async objects(video: string, variant: string, held: ReadonlySet<number> = new Set()): Promise<ServerObject[]> {
    const out: ServerObject[] = [];
    for (const o of await this.seeds.objects(video)) {
      out.push(await this.objectInfo(video, o, variant, held));
    }
    return out;
  }

  /**
   * The objects a Track press runs: the ids given, else every object not
   * tracked; never one without seeds or one a running job holds.
   */
  async select(video: string, ids: number[] | null, variant: string, held: ReadonlySet<number>): Promise<number[]> {
    const objs = await this.objects(video, variant, held);
    const known = objs.filter(o => o.seeds.some(s => s.points.length > 0) && !held.has(o.objectId));
    const state = (o: ServerObject) => o.tracks?.find(t => t.engine === BROWSER_ENGINE)?.state;
    if (ids == null) {
      return known.filter(o => state(o) !== 'tracked').map(o => o.objectId);
    }
    const want = new Set(ids);
    return known.filter(o => want.has(o.objectId)).map(o => o.objectId);
  }
}
