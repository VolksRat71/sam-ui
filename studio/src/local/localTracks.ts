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
// holds the object, untracked when there is none.
import type {RLEObject} from '@/jscocotools/mask';
import {BROWSER_ENGINE} from '~/state/engines';
import {browserModelName, parseQuality} from './sam2/config';
import {DEFAULT_ENGINE, type NormPoint, type ServerObject} from '~/state/objects';

export {BROWSER_ENGINE};

export type LocalTrack = {
  objectId: number;
  /** seedsKey() of the clicks it was tracked from. */
  seedsKey: string;
  /** variantKey() of the model settings it was tracked with. */
  variant: string;
  /** Per frame; a frame without a mask (the object is gone) has none. */
  masks: Map<number, RLEObject>;
  nFrames: number;
};

export interface LocalTrackStore {
  get(video: string, objectId: number): Promise<LocalTrack | null>;
  list(video: string): Promise<LocalTrack[]>;
  put(video: string, track: LocalTrack): Promise<void>;
  delete(video: string, objectId: number): Promise<void>;
  /** Forget every track of a video. */
  clear(video: string): Promise<void>;
}

/** This phase's store: this tab's memory, gone on reload. */
export class MemoryTrackStore implements LocalTrackStore {
  private _videos = new Map<string, Map<number, LocalTrack>>();

  private _of(video: string): Map<number, LocalTrack> {
    let m = this._videos.get(video);
    if (m == null) {
      m = new Map();
      this._videos.set(video, m);
    }
    return m;
  }

  async get(video: string, objectId: number): Promise<LocalTrack | null> {
    return this._of(video).get(objectId) ?? null;
  }

  async list(video: string): Promise<LocalTrack[]> {
    return [...this._of(video).values()].sort((a, b) => a.objectId - b.objectId);
  }

  async put(video: string, track: LocalTrack): Promise<void> {
    this._of(video).set(track.objectId, track);
  }

  async delete(video: string, objectId: number): Promise<void> {
    this._of(video).delete(objectId);
  }

  async clear(video: string): Promise<void> {
    this._videos.delete(video);
  }
}

/** A stable key of an object's clicks: frames in order, each frame's points as clicked. */
export function seedsKey(seeds: ReadonlyMap<number, readonly NormPoint[]>): string {
  const frames = [...seeds.entries()].filter(([, p]) => p.length > 0).sort((a, b) => a[0] - b[0]);
  return JSON.stringify(frames.map(([f, p]) => [f, p.map(q => [q[0], q[1], q[2]])]));
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
