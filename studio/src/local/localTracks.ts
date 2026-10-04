// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The browser engine's tracks, kept in this tab. The backend keeps the seeds
// (clicks and approved masks) and every server engine's tracks; a browser
// track lives behind LocalTrackStore, in memory for now. Phase 2 backs the
// same interface with OPFS, keyed by the video, so the calls are async.
//
// A browser track's state follows the backend's rules (tracks/store.py):
// tracked when it was made from the object's current clicks with the current
// model settings, stale when either changed since, tracking while a job
// holds the object, untracked when there is none. Absent ranges join the
// seeds key, as they join the backend's seeds hash.
//
// Every track a store is given is also kept as a version (issue #18), the
// last LOCAL_KEEP per object, so going back to earlier clicks brings their
// track back (adopt) with no job, as the backend's tracks/versions.py does.
// A version made current again counts as the newest, so it is evicted last.
import type {RLEObject} from '@/jscocotools/mask';
import {BROWSER_ENGINE} from '~/state/engines';
import {browserModelName, parseQuality} from './sam2/config';
import {DEFAULT_ENGINE, type NormPoint, type ServerObject} from '~/state/objects';
import {type FrameRange, rangesKey} from '~/state/ranges';

export {BROWSER_ENGINE};

/** An object's seed record as stored with no backend (offlineStores.ts): the files, as they are. */
export type SeedRecord = Record<string, unknown>;

export type LocalTrack = {
  objectId: number;
  /** seedsKey() of the clicks it was tracked from. */
  seedsKey: string;
  /** variantKey() of the model settings it was tracked with. */
  variant: string;
  /** Per frame; a frame without a mask (the object is gone, or marked absent) has none. */
  masks: Map<number, RLEObject>;
  nFrames: number;
  /** The seed record it was tracked from (no backend only), so its version can be restored from the list. */
  record?: SeedRecord | null;
  /** When it was tracked (ISO). */
  created?: string;
};

/** Browser track versions kept per object. */
export const LOCAL_KEEP = 10;

/** One kept browser track, as the version list shows it. */
export type LocalVersion = {
  id: string;
  seedsKey: string;
  variant: string;
  created: string | null;
  nFrames: number;
  clicks: number;
  seedFrames: number;
};

export interface LocalTrackStore {
  get(video: string, objectId: number): Promise<LocalTrack | null>;
  list(video: string): Promise<LocalTrack[]>;
  /** Make `track` the object's track, and keep it as a version. */
  put(video: string, track: LocalTrack): Promise<void>;
  /** Drop the object's track and its versions (keepVersions: the current track only). */
  delete(video: string, objectId: number, opts?: {keepVersions?: boolean}): Promise<void>;
  /** Forget every track of a video. */
  clear(video: string): Promise<void>;
  /** The object's kept versions, newest first. */
  versions(video: string, objectId: number): Promise<LocalVersion[]>;
  /** One kept version, whole. */
  version(video: string, objectId: number, id: string): Promise<LocalTrack | null>;
  /** Make the kept track of these clicks and settings current; false when none is kept. */
  adopt(video: string, objectId: number, seedsKey: string, variant: string): Promise<boolean>;
}

/** A short, stable name for the version of these clicks and settings (cyrb53, as hex). */
export function versionId(seedsKey: string, variant: string): string {
  const str = `${seedsKey}\u0000${variant}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** How many clicks, on how many frames, a seeds key holds (seedsKey's format). */
export function keyClicks(key: string): {clicks: number; seedFrames: number} {
  try {
    const frames = JSON.parse(key.split('|')[0]) as Array<[number, unknown[]]>;
    return {clicks: frames.reduce((n, [, p]) => n + p.length, 0), seedFrames: frames.length};
  } catch {
    return {clicks: 0, seedFrames: 0};
  }
}

export function versionOf(track: LocalTrack): LocalVersion {
  return {
    id: versionId(track.seedsKey, track.variant),
    seedsKey: track.seedsKey,
    variant: track.variant,
    created: track.created ?? null,
    nFrames: track.nFrames,
    ...keyClicks(track.seedsKey),
  };
}

/**
 * The version list (oldest first) with `add` kept as the newest, and the ids
 * that fall out of the last LOCAL_KEEP (never `protect`).
 */
export function keepVersion(
  order: ReadonlyArray<LocalVersion>,
  add: LocalVersion,
  protect: ReadonlyArray<string> = [],
): {order: LocalVersion[]; evicted: string[]} {
  const next = [...order.filter(v => v.id !== add.id), add];
  const evicted: string[] = [];
  const keep = new Set(protect);
  while (next.length - evicted.length > LOCAL_KEEP) {
    const old = next.find(v => !keep.has(v.id) && !evicted.includes(v.id) && v.id !== add.id);
    if (old == null) {
      break;
    }
    evicted.push(old.id);
  }
  return {order: next.filter(v => !evicted.includes(v.id)), evicted};
}

type MemoryObject = {current: string | null; order: LocalVersion[]; tracks: Map<string, LocalTrack>};

/** The browser engine's store beside a backend: this tab's memory, gone on reload. */
export class MemoryTrackStore implements LocalTrackStore {
  private _videos = new Map<string, Map<number, MemoryObject>>();

  private _of(video: string): Map<number, MemoryObject> {
    let m = this._videos.get(video);
    if (m == null) {
      m = new Map();
      this._videos.set(video, m);
    }
    return m;
  }

  private _obj(video: string, objectId: number): MemoryObject {
    const m = this._of(video);
    let o = m.get(objectId);
    if (o == null) {
      o = {current: null, order: [], tracks: new Map()};
      m.set(objectId, o);
    }
    return o;
  }

  async get(video: string, objectId: number): Promise<LocalTrack | null> {
    const o = this._of(video).get(objectId);
    return o?.current == null ? null : (o.tracks.get(o.current) ?? null);
  }

  async list(video: string): Promise<LocalTrack[]> {
    const out: LocalTrack[] = [];
    for (const id of this._of(video).keys()) {
      const t = await this.get(video, id);
      if (t != null) {
        out.push(t);
      }
    }
    return out.sort((a, b) => a.objectId - b.objectId);
  }

  async put(video: string, track: LocalTrack): Promise<void> {
    const o = this._obj(video, track.objectId);
    const v = versionOf(track);
    const {order, evicted} = keepVersion(o.order, v);
    o.order = order;
    evicted.forEach(id => o.tracks.delete(id));
    o.tracks.set(v.id, track);
    o.current = v.id;
  }

  async delete(video: string, objectId: number, opts?: {keepVersions?: boolean}): Promise<void> {
    if (opts?.keepVersions) {
      const o = this._of(video).get(objectId);
      if (o != null) {
        o.current = null;
      }
    } else {
      this._of(video).delete(objectId);
    }
  }

  async clear(video: string): Promise<void> {
    this._videos.delete(video);
  }

  async versions(video: string, objectId: number): Promise<LocalVersion[]> {
    return [...(this._of(video).get(objectId)?.order ?? [])].reverse();
  }

  async version(video: string, objectId: number, id: string): Promise<LocalTrack | null> {
    return this._of(video).get(objectId)?.tracks.get(id) ?? null;
  }

  async adopt(video: string, objectId: number, seedsKey: string, variant: string): Promise<boolean> {
    const o = this._of(video).get(objectId);
    const id = versionId(seedsKey, variant);
    if (o == null || !o.tracks.has(id)) {
      return false;
    }
    o.current = id;
    o.order = [...o.order.filter(v => v.id !== id), ...o.order.filter(v => v.id === id)]; // used last: evicted last
    return true;
  }
}

/**
 * A stable key of an object's clicks (frames in order, each frame's points as
 * clicked) and its absent ranges. With no ranges it is the key from before
 * ranges existed, so those browser tracks stay tracked.
 */
export function seedsKey(seeds: ReadonlyMap<number, readonly NormPoint[]>, ranges: ReadonlyArray<FrameRange> = []): string {
  const frames = [...seeds.entries()].filter(([, p]) => p.length > 0).sort((a, b) => a[0] - b[0]);
  const key = JSON.stringify(frames.map(([f, p]) => [f, p.map(q => [q[0], q[1], q[2]])]));
  const r = rangesKey(ranges);
  return r === '' ? key : `${key}|absent:${r}`;
}

/** A browser track's model settings: re-tracking is needed when these change. */
export function variantKey(quality: number, fillHoleArea: number): string {
  return `sam2.1-tiny-${quality}-fill${fillHoleArea}`;
}

export type LocalTrackEntry = {engine: string; state: string; frames: number[] | null; nFrames: number};

/** The objectTracks entry for an object's browser track. */
export function localTrackEntry(
  track: LocalTrack | null,
  current: {seedsKey: string; variant: string; running: boolean},
): LocalTrackEntry {
  const frames = track == null ? [] : [...track.masks.keys()].sort((a, b) => a - b);
  const span = frames.length > 0 ? [frames[0], frames[frames.length - 1]] : null;
  const state = current.running
    ? 'tracking'
    : track == null
      ? 'untracked'
      : track.seedsKey === current.seedsKey && track.variant === current.variant
        ? 'tracked'
        : 'stale';
  return {engine: BROWSER_ENGINE, state, frames: span, nFrames: track?.nFrames ?? 0};
}

/** The backend's objects with each one's browser track added (or replaced). */
export function withLocalTracks(
  objects: ReadonlyArray<ServerObject>,
  entries: ReadonlyMap<number, LocalTrackEntry>,
): ServerObject[] {
  return objects.map(o => {
    const entry = entries.get(o.objectId);
    if (entry == null) {
      return o;
    }
    // with no per-engine list, the top-level fields are the default engine's
    // (an empty list is a no-server object: no server engines at all)
    const base = o.tracks != null ? o.tracks : [{engine: DEFAULT_ENGINE, state: o.state, frames: o.frames, nFrames: o.nFrames}];
    return {...o, tracks: [...base.filter(t => t.engine !== entry.engine), entry]};
  });
}

/** variantKey()'s model, as exports name it (the key itself when it is not one). */
export function variantModel(variant: string): string {
  const m = /^sam2\.1-tiny-(\d+)-fill(\d+)$/.exec(variant);
  return m == null ? variant : browserModelName(parseQuality(m[1]), Number(m[2]));
}
