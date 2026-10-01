// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The no-server stores, ported from the backend's tracks/seeds.py and
// tracks/store.py, over a Kv (OPFS in the app). Keyed like the backend, by
// the video's sha256:
//   seeds/<video>/<obj>/seeds.json   {"<frame>": {"points", "labels", "mask"?}}
//   seeds/<video>/<obj>/object.json  {"name"}: metadata, never in the seeds key
//   seeds/<video>/<obj>/ranges.json  {"ranges": [{start, end, state}]}: absent
//                                    ranges, which do join the seeds key
//   seeds/<video>/<obj>/history.json {"undo": [{key, at, files}], "redo": [...]}:
//                                    seed changes to undo (issue #18), each with
//                                    the seed record (seeds.json, ranges.json) as it was
//   tracks/<video>/<obj>/browser-sam2.json   the current browser track: {"ref": id}
//                                    naming a version, or (written before versions)
//                                    the track itself
//   tracks/<video>/<obj>/versions/<id>.json  each kept track, with its seed record
//   tracks/<video>/<obj>/versions.json       their list, oldest first (LOCAL_KEEP kept)
// Removing an object removes its seeds, name, history and tracks; clearing the
// last seed frame drops its current track (a track with no seeds could never
// be redone) but keeps its versions, so an undo brings it back.
import type {RLEObject} from '@/jscocotools/mask';
import {BROWSER_ENGINE} from '~/state/engines';
import {cleanObjectName} from '~/state/fileNames';
import type {NormPoint, ServerObject} from '~/state/objects';
import {type FrameRange, type RangeState, normalizeRanges, paintRange} from '~/state/ranges';
import {type Kv, readJson, writeJson} from './kv';
import type {SeedHistory, TrackVersion} from '~/state/history';
import {
  type LocalTrack,
  type LocalTrackStore,
  type LocalVersion,
  type SeedRecord,
  keepVersion,
  localTrackEntry,
  seedsKey,
  variantModel,
  versionId,
  versionOf,
  withLocalTracks,
} from './localTracks';

/** Seed changes each object can undo, as on the backend. */
export const LOCAL_UNDO_DEPTH = 50;

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

  /** The files that make the seeds key, as stored (null where absent). */
  static readonly RECORD_FILES = ['seeds.json', 'ranges.json'];

  async record(video: string, obj: number): Promise<SeedRecord> {
    const out: SeedRecord = {};
    for (const name of SeedStore.RECORD_FILES) {
      out[name] = await readJson<unknown>(this._kv, `${this._dir(video, obj)}/${name}`);
    }
    return out;
  }

  /**
   * Write a seed record back as it was recorded. A record from before the
   * object's first click still writes an empty seeds.json, so the object stays
   * listed, with its history to redo.
   */
  async putRecord(video: string, obj: number, record: SeedRecord): Promise<void> {
    for (const name of SeedStore.RECORD_FILES) {
      const path = `${this._dir(video, obj)}/${name}`;
      if (name === 'seeds.json' && record[name] == null) {
        await writeJson(this._kv, path, {});
      } else if (record[name] == null) {
        await this._kv.remove(path);
      } else {
        await writeJson(this._kv, path, record[name]);
      }
    }
  }

  /** The seeds key of a record: what browser tracks of it are stored under. */
  static recordKey(record: SeedRecord): string {
    const raw = (record['seeds.json'] ?? {}) as Record<string, SeedFrame>;
    const seeds: Seeds = new Map(Object.entries(raw).map(([f, v]) => [Number(f), v]));
    const ranges = normalizeRanges((record['ranges.json'] as {ranges?: FrameRange[]} | null)?.ranges);
    return seedsKey(seedPoints(seeds), ranges);
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

type StoredTrack = {
  objectId: number;
  seedsKey: string;
  variant: string;
  nFrames: number;
  masks: Array<[number, RLEObject]>;
  record?: SeedRecord | null;
  created?: string;
};

/** Browser tracks on a Kv: the current one names a kept version (see the layout above). */
export class KvTrackStore implements LocalTrackStore {
  constructor(private readonly _kv: Kv) {}

  private _dir(video: string, obj: number): string {
    return `tracks/${video}/${Math.trunc(obj)}`;
  }

  private _path(video: string, obj: number): string {
    return `${this._dir(video, obj)}/${BROWSER_ENGINE}.json`;
  }

  private _versionPath(video: string, obj: number, id: string): string {
    return `${this._dir(video, obj)}/versions/${id}.json`;
  }

  private static _track(t: StoredTrack | null): LocalTrack | null {
    if (t == null || !Array.isArray(t.masks)) {
      return null;
    }
    return {
      objectId: t.objectId,
      seedsKey: t.seedsKey,
      variant: t.variant,
      nFrames: t.nFrames,
      masks: new Map(t.masks),
      record: t.record ?? null,
      created: t.created,
    };
  }

  private static _stored(track: LocalTrack): StoredTrack {
    return {...track, masks: [...track.masks].sort((a, b) => a[0] - b[0])};
  }

  async get(video: string, objectId: number): Promise<LocalTrack | null> {
    const t = await readJson<StoredTrack & {ref?: string}>(this._kv, this._path(video, objectId));
    if (t?.ref != null) {
      return this.version(video, objectId, t.ref);
    }
    return KvTrackStore._track(t); // stored before versions: the track itself
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

  private async _order(video: string, obj: number): Promise<LocalVersion[]> {
    return (await readJson<{versions?: LocalVersion[]}>(this._kv, `${this._dir(video, obj)}/versions.json`))?.versions ?? [];
  }

  private async _keep(video: string, track: LocalTrack): Promise<string> {
    const v = versionOf(track);
    await writeJson(this._kv, this._versionPath(video, track.objectId, v.id), KvTrackStore._stored(track));
    const {order, evicted} = keepVersion(await this._order(video, track.objectId), v);
    for (const id of evicted) {
      await this._kv.remove(this._versionPath(video, track.objectId, id));
    }
    await writeJson(this._kv, `${this._dir(video, track.objectId)}/versions.json`, {versions: order});
    return v.id;
  }

  async put(video: string, track: LocalTrack): Promise<void> {
    const old = await readJson<StoredTrack & {ref?: string}>(this._kv, this._path(video, track.objectId));
    const legacy = old?.ref == null ? KvTrackStore._track(old) : null;
    if (legacy != null) {
      await this._keep(video, legacy); // a track from before versions is kept as one first
    }
    const id = await this._keep(video, track);
    await writeJson(this._kv, this._path(video, track.objectId), {objectId: track.objectId, ref: id});
  }

  async delete(video: string, objectId: number, opts?: {keepVersions?: boolean}): Promise<void> {
    if (opts?.keepVersions) {
      const old = await readJson<StoredTrack & {ref?: string}>(this._kv, this._path(video, objectId));
      const legacy = old?.ref == null ? KvTrackStore._track(old) : null;
      if (legacy != null) {
        await this._keep(video, legacy); // the only copy of a track from before versions
      }
    }
    await this._kv.remove(opts?.keepVersions ? this._path(video, objectId) : this._dir(video, objectId));
  }

  async clear(video: string): Promise<void> {
    await this._kv.remove(`tracks/${video}`);
  }

  async versions(video: string, objectId: number): Promise<LocalVersion[]> {
    return [...(await this._order(video, objectId))].reverse();
  }

  async version(video: string, objectId: number, id: string): Promise<LocalTrack | null> {
    return KvTrackStore._track(await readJson<StoredTrack>(this._kv, this._versionPath(video, objectId, id)));
  }

  async adopt(video: string, objectId: number, key: string, variant: string): Promise<boolean> {
    const id = versionId(key, variant);
    const order = await this._order(video, objectId);
    const v = order.find(x => x.id === id);
    if (v == null || (await this._kv.read(this._versionPath(video, objectId, id))) == null) {
      return false;
    }
    await writeJson(this._kv, this._path(video, objectId), {objectId, ref: id});
    // made current again: the newest, so evicted last
    await writeJson(this._kv, `${this._dir(video, objectId)}/versions.json`, {
      versions: [...order.filter(x => x.id !== id), v],
    });
    return true;
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
type HistoryEntry = {key: string; at: string; files: SeedRecord};
type History = {undo: HistoryEntry[]; redo: HistoryEntry[]};

export class OfflineService {
  readonly seeds: SeedStore;
  readonly tracks: KvTrackStore;

  /** `held`: the objects a running job holds, whose seeds and track an undo must not swap. */
  constructor(
    private readonly _kv: Kv,
    private readonly _held: () => ReadonlySet<number> = () => new Set(),
  ) {
    this.seeds = new SeedStore(_kv);
    this.tracks = new KvTrackStore(_kv);
  }

  // -- seed changes, each one undoable -----------------------------------------------

  private _historyPath(video: string, obj: number): string {
    return `seeds/${video}/${Math.trunc(obj)}/history.json`;
  }

  async history(video: string, obj: number): Promise<History> {
    const h = await readJson<Partial<History>>(this._kv, this._historyPath(video, obj));
    return {undo: h?.undo ?? [], redo: h?.redo ?? []};
  }

  private async _setHistory(video: string, obj: number, h: History): Promise<void> {
    await writeJson(this._kv, this._historyPath(video, obj), {
      undo: h.undo.slice(-LOCAL_UNDO_DEPTH),
      redo: h.redo.slice(-LOCAL_UNDO_DEPTH),
    });
  }

  /**
   * Around a change of the object's seed record: the record before it goes
   * on the undo history (when the change changed anything) and redo is
   * cleared. Clicks a kept track was made from get it back, as on the backend.
   */
  private async _change<T>(video: string, obj: number, variant: string | null, fn: () => Promise<T>): Promise<T> {
    const before = await this.seeds.record(video, obj);
    const key = SeedStore.recordKey(before);
    const out = await fn();
    const after = await this.seeds.record(video, obj);
    const now = SeedStore.recordKey(after);
    if (now !== key) {
      if (variant != null && !this._held().has(obj) && (await this.seeds.seeds(video, obj)).size > 0) {
        await this.tracks.adopt(video, obj, now, variant);
      }
      const h = await this.history(video, obj);
      await this._setHistory(video, obj, {undo: [...h.undo, {key, at: new Date().toISOString(), files: before}], redo: []});
    }
    return out;
  }

  recordPoints(video: string, obj: number, frame: number, points: NormPoint[], mask: RLEObject | null, variant: string | null = null): Promise<Seeds> {
    return this._change(video, obj, variant, () =>
      this.seeds.addPoints(video, obj, frame, points.map(p => [p[0], p[1]]), points.map(p => p[2]), true, mask),
    );
  }

  /** Mark frames start-end absent, or clear them (null). The track goes stale, as on the backend. */
  setRange(video: string, obj: number, start: number, end: number, state: RangeState | null, variant: string | null = null): Promise<FrameRange[]> {
    return this._change(video, obj, variant, () => this.seeds.paintRange(video, obj, start, end, state));
  }

  /** Drop one seed frame; with none left, the object's track goes too (its versions stay). */
  async clearFrame(video: string, obj: number, frame: number, variant: string | null = null): Promise<void> {
    await this._change(video, obj, variant, async () => {
      const left = await this.seeds.clearFrame(video, obj, frame);
      if (left.size === 0) {
        await this.tracks.delete(video, obj, {keepVersions: true});
      }
    });
  }

  private _checkFree(obj: number): void {
    if (this._held().has(obj)) {
      throw new Error(`object ${obj} is being tracked: wait for its job to finish, or cancel it, then undo`);
    }
  }

  /** Make `files` the seed record, and the kept track of it (if any) current. */
  private async _apply(video: string, obj: number, files: SeedRecord, variant: string): Promise<void> {
    await this.seeds.putRecord(video, obj, files);
    if ((await this.seeds.seeds(video, obj)).size === 0) {
      await this.tracks.delete(video, obj, {keepVersions: true});
    } else {
      await this.tracks.adopt(video, obj, SeedStore.recordKey(files), variant);
    }
  }

  private async _step(video: string, obj: number, variant: string, from: 'undo' | 'redo'): Promise<ServerObject> {
    this._checkFree(obj);
    const h = await this.history(video, obj);
    const entry = h[from].pop();
    if (entry == null) {
      throw new Error(`object ${obj} has nothing to ${from}`);
    }
    const current = await this.seeds.record(video, obj);
    await this._apply(video, obj, entry.files, variant);
    const to = from === 'undo' ? 'redo' : 'undo';
    h[to].push({key: SeedStore.recordKey(current), at: new Date().toISOString(), files: current});
    await this._setHistory(video, obj, h);
    return this.objectInfo(video, obj, variant, this._held());
  }

  /** Put back the clicks from before the object's last seed change, with their kept track. */
  undo(video: string, obj: number, variant: string): Promise<ServerObject> {
    return this._step(video, obj, variant, 'undo');
  }

  redo(video: string, obj: number, variant: string): Promise<ServerObject> {
    return this._step(video, obj, variant, 'redo');
  }

  /** Go back to a kept version from the list: a seed change like any other, so it can be undone. */
  async restoreVersion(video: string, obj: number, id: string, variant: string): Promise<ServerObject> {
    this._checkFree(obj);
    const v = await this.tracks.version(video, obj, id);
    if (v?.record == null) {
      throw new Error(`object ${obj} keeps no version ${id}`);
    }
    await this._change(video, obj, null, () => this._apply(video, obj, v.record!, v.variant));
    return this.objectInfo(video, obj, variant, this._held());
  }

  /** What the object can undo and redo, and its kept browser tracks, newest first. */
  async versionsInfo(video: string, obj: number, variant: string): Promise<SeedHistory> {
    const h = await this.history(video, obj);
    const current = SeedStore.recordKey(await this.seeds.record(video, obj));
    const versions: TrackVersion[] = (await this.tracks.versions(video, obj)).map(v => ({
      key: v.id,
      engine: BROWSER_ENGINE,
      model: variantModel(v.variant),
      created: v.created,
      elapsedS: null,
      nFrames: v.nFrames,
      clicks: v.clicks,
      seedFrames: v.seedFrames,
      bounded: false,
      current: v.seedsKey === current && v.variant === variant,
    }));
    return {canUndo: h.undo.length > 0, canRedo: h.redo.length > 0, versions};
  }

  async removeObject(video: string, obj: number): Promise<void> {
    await this.seeds.removeObject(video, obj);
    await this.tracks.delete(video, obj);
  }

  async clearVideo(video: string): Promise<void> {
    await this.seeds.clearVideo(video);
    await this.tracks.clear(video);
  }

  /** One object as objectTracks gives it: seeds, the browser track's state, and its history. */
  async objectInfo(video: string, obj: number, variant: string, held: ReadonlySet<number>): Promise<ServerObject> {
    const seeds = await this.seeds.seeds(video, obj);
    const ranges = await this.seeds.ranges(video, obj);
    const entry = localTrackEntry(await this.tracks.get(video, obj), {
      seedsKey: seedsKey(seedPoints(seeds), ranges),
      variant,
      running: held.has(obj),
    });
    const o = withLocalTracks([offlineObject(obj, seeds, ranges)], new Map([[obj, entry]]))[0];
    return {...o, history: await this.versionsInfo(video, obj, variant)};
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
