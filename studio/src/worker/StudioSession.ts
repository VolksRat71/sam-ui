/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Modified by sam-ui: adapted from SAM2Model.ts in Meta's SAM 2 demo frontend
// for per-object track jobs (/track_objects, /track_masks), restored objects
// and client-assigned ids; a job only ever replaces the masks of its own objects.
// The browser engine (src/local, "browser-sam2") runs clicks and track jobs in
// this worker's nested model worker; its tracks stay in this tab.
// Absent ranges (state/ranges.ts): no mask is ever shown on a frame where its
// object is marked absent, and browser jobs track each window on its own.
import {generateThumbnail} from '@/common/components/video/editor/VideoEditorUtils';
import type VideoWorkerContext from '@/common/components/video/VideoWorkerContext';
import type {Mask, SegmentationPoint, Tracklet} from '@/common/tracker/Tracker';
import {createEnvironment} from '@/graphql/RelayEnvironment';
import {type RLEObject, toBbox} from '@/jscocotools/mask';
import {
  type GraphQLTaggedNode,
  type IEnvironment,
  type MutationParameters,
  commitMutation,
  fetchQuery,
  graphql,
} from 'relay-runtime';
import {
  type DonePart,
  type ErrorPart,
  jobOutcome,
  parseObjectsHeader,
  readTrackStream,
} from '~/api/trackStream';
import {OpfsKv} from '~/local/kv';
import {LocalEngine, type LocalOptions} from '~/local/LocalEngine';
import {OfflineService, SeedStore} from '~/local/offlineStores';
import {localTrackEntry, seedsKey, variantModel, withLocalTracks, type LocalTrackEntry} from '~/local/localTracks';
import type {Layout} from '~/state/layout';
import {layoutFromResponse} from '~/state/layoutSync';
import type {ExportedObject, ExportGroup, ExportKind} from '~/state/maskExport';
import {buildExport} from './maskExports';
import type {TrackObject} from '~/local/sam2/tracker';
import {BROWSER_ENGINE, engineLabel} from '~/state/engines';
import {maskSegments} from '~/state/segments';
import {type FrameRange, absentAt, normalizeRanges, planUnits} from '~/state/ranges';
import {colorFor, DEFAULT_ENGINE, type NormPoint, type ServerObject} from '~/state/objects';
import type MaskOverlayEffect from './MaskOverlayEffect';
import {paintAlpha} from './maskPixels';
import type {
  Disagreement,
  EngineInfo,
  ExportManifest,
  ExportRequest,
  RunningJob,
  SessionInfo,
  StudioEvent,
  TrackResult,
} from './protocol';
import type {StudioSessionAddPointsMutation} from './__generated__/StudioSessionAddPointsMutation.graphql';
import type {StudioSessionCancelMutation} from './__generated__/StudioSessionCancelMutation.graphql';
import type {StudioSessionClearFrameMutation} from './__generated__/StudioSessionClearFrameMutation.graphql';
import type {StudioSessionClearTrackMutation} from './__generated__/StudioSessionClearTrackMutation.graphql';
import type {StudioSessionClearVideoMutation} from './__generated__/StudioSessionClearVideoMutation.graphql';
import type {StudioSessionCloseMutation} from './__generated__/StudioSessionCloseMutation.graphql';
import type {StudioSessionObjectTracksQuery} from './__generated__/StudioSessionObjectTracksQuery.graphql';
import type {StudioSessionRemoveObjectMutation} from './__generated__/StudioSessionRemoveObjectMutation.graphql';
import type {StudioSessionSetRangeMutation} from './__generated__/StudioSessionSetRangeMutation.graphql';
import type {StudioSessionStartMutation} from './__generated__/StudioSessionStartMutation.graphql';
import type {StudioSessionUndoMutation} from './__generated__/StudioSessionUndoMutation.graphql';
import type {StudioSessionRedoMutation} from './__generated__/StudioSessionRedoMutation.graphql';
import type {StudioSessionRestoreVersionMutation} from './__generated__/StudioSessionRestoreVersionMutation.graphql';
import type {StudioSessionMoveClicksMutation} from './__generated__/StudioSessionMoveClicksMutation.graphql';

type RleList = ReadonlyArray<{
  readonly objectId: number;
  readonly rleMask: {readonly size: ReadonlyArray<number>; readonly counts: string};
}>;

// Each operation spells out the ObjectTrack fields it needs (ServerObject):
// ObjectTrack has no id, so a shared fragment would buy nothing in the store.
const START = graphql`
  mutation StudioSessionStartMutation($input: StartSessionInput!) {
    startSession(input: $input) {
      sessionId
      objects {
        objectId
        state
        frames
        nFrames
        seeds {
          frameIndex
          points
          labels
          mask {
            size
            counts
          }
        }
        tracks {
          engine
          state
          frames
          nFrames
        }
        ranges {
          start
          end
          state
        }
        history {
          canUndo
          canRedo
          versions {
            key
            engine
            model
            created
            elapsedS
            nFrames
            clicks
            seedFrames
            bounded
            current
          }
        }
      }
    }
  }
`;

const CLOSE = graphql`
  mutation StudioSessionCloseMutation($input: CloseSessionInput!) {
    closeSession(input: $input) {
      success
    }
  }
`;

const ADD_POINTS = graphql`
  mutation StudioSessionAddPointsMutation($input: AddPointsInput!) {
    addPoints(input: $input) {
      frameIndex
      rleMaskList {
        objectId
        rleMask {
          size
          counts
        }
      }
    }
  }
`;

const CLEAR_FRAME = graphql`
  mutation StudioSessionClearFrameMutation($input: ClearPointsInFrameInput!) {
    clearPointsInFrame(input: $input) {
      frameIndex
      rleMaskList {
        objectId
        rleMask {
          size
          counts
        }
      }
    }
  }
`;

const REMOVE_OBJECT = graphql`
  mutation StudioSessionRemoveObjectMutation($input: RemoveObjectInput!) {
    removeObject(input: $input) {
      frameIndex
    }
  }
`;

const CLEAR_TRACK = graphql`
  mutation StudioSessionClearTrackMutation($input: ClearTrackInput!) {
    clearTrack(input: $input) {
      objectId
      state
      frames
      nFrames
      seeds {
        frameIndex
        points
        labels
        mask {
          size
          counts
        }
      }
      tracks {
        engine
        state
        frames
        nFrames
      }
      ranges {
        start
        end
        state
      }
      history {
        canUndo
        canRedo
        versions {
          key
          engine
          model
          created
          elapsedS
          nFrames
          clicks
          seedFrames
          bounded
          current
        }
      }
    }
  }
`;

const SET_RANGE = graphql`
  mutation StudioSessionSetRangeMutation($input: SetObjectRangeInput!) {
    setObjectRange(input: $input) {
      objectId
      state
      frames
      nFrames
      seeds {
        frameIndex
        points
        labels
        mask {
          size
          counts
        }
      }
      tracks {
        engine
        state
        frames
        nFrames
      }
      ranges {
        start
        end
        state
      }
      history {
        canUndo
        canRedo
        versions {
          key
          engine
          model
          created
          elapsedS
          nFrames
          clicks
          seedFrames
          bounded
          current
        }
      }
    }
  }
`;

const UNDO = graphql`
  mutation StudioSessionUndoMutation($input: SeedHistoryInput!) {
    undoSeeds(input: $input) {
      objectId
      state
      frames
      nFrames
      seeds {
        frameIndex
        points
        labels
        mask {
          size
          counts
        }
      }
      tracks {
        engine
        state
        frames
        nFrames
      }
      ranges {
        start
        end
        state
      }
      history {
        canUndo
        canRedo
        versions {
          key
          engine
          model
          created
          elapsedS
          nFrames
          clicks
          seedFrames
          bounded
          current
        }
      }
    }
  }
`;

const REDO = graphql`
  mutation StudioSessionRedoMutation($input: SeedHistoryInput!) {
    redoSeeds(input: $input) {
      objectId
      state
      frames
      nFrames
      seeds {
        frameIndex
        points
        labels
        mask {
          size
          counts
        }
      }
      tracks {
        engine
        state
        frames
        nFrames
      }
      ranges {
        start
        end
        state
      }
      history {
        canUndo
        canRedo
        versions {
          key
          engine
          model
          created
          elapsedS
          nFrames
          clicks
          seedFrames
          bounded
          current
        }
      }
    }
  }
`;

const RESTORE_VERSION = graphql`
  mutation StudioSessionRestoreVersionMutation($input: RestoreVersionInput!) {
    restoreVersion(input: $input) {
      objectId
      state
      frames
      nFrames
      seeds {
        frameIndex
        points
        labels
        mask {
          size
          counts
        }
      }
      tracks {
        engine
        state
        frames
        nFrames
      }
      ranges {
        start
        end
        state
      }
      history {
        canUndo
        canRedo
        versions {
          key
          engine
          model
          created
          elapsedS
          nFrames
          clicks
          seedFrames
          bounded
          current
        }
      }
    }
  }
`;

const MOVE_CLICKS = graphql`
  mutation StudioSessionMoveClicksMutation($input: MoveClicksInput!) {
    moveClicks(input: $input) {
      objectId
      state
      frames
      nFrames
      seeds {
        frameIndex
        points
        labels
        mask {
          size
          counts
        }
      }
      tracks {
        engine
        state
        frames
        nFrames
      }
      ranges {
        start
        end
        state
      }
      history {
        canUndo
        canRedo
        versions {
          key
          engine
          model
          created
          elapsedS
          nFrames
          clicks
          seedFrames
          bounded
          current
        }
      }
    }
  }
`;

const CLEAR_VIDEO = graphql`
  mutation StudioSessionClearVideoMutation($input: ClearPointsInVideoInput!) {
    clearPointsInVideo(input: $input) {
      success
    }
  }
`;

const CANCEL = graphql`
  mutation StudioSessionCancelMutation($input: CancelPropagateInVideoInput!) {
    cancelPropagateInVideo(input: $input) {
      success
    }
  }
`;

const OBJECT_TRACKS = graphql`
  query StudioSessionObjectTracksQuery($sessionId: String!) {
    objectTracks(sessionId: $sessionId) {
      objectId
      state
      frames
      nFrames
      seeds {
        frameIndex
        points
        labels
        mask {
          size
          counts
        }
      }
      tracks {
        engine
        state
        frames
        nFrames
      }
      ranges {
        start
        end
        state
      }
      history {
        canUndo
        canRedo
        versions {
          key
          engine
          model
          created
          elapsedS
          nFrames
          clicks
          seedFrames
          bounded
          current
        }
      }
    }
  }
`;

function mutate<T extends MutationParameters>(
  env: IEnvironment,
  mutation: GraphQLTaggedNode,
  variables: T['variables'],
): Promise<T['response']> {
  return new Promise((resolve, reject) => {
    commitMutation<T>(env, {
      mutation,
      variables,
      onCompleted: (response, errors) => {
        if (errors != null && errors.length > 0) {
          reject(new Error(errors.map(e => e.message).join('; ')));
        } else {
          resolve(response);
        }
      },
      onError: reject,
    });
  });
}

/** Copy Relay's frozen records into plain objects that survive postMessage. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toMask(rle: {readonly size: ReadonlyArray<number>; readonly counts: string}): Mask | undefined {
  const data: RLEObject = {size: [rle.size[0], rle.size[1]], counts: rle.counts};
  const [x, y, w, h] = toBbox([data]);
  if (!(w > 0 && h > 0)) {
    return undefined; // an empty mask draws nothing
  }
  return {
    data,
    shape: [data.size[0], data.size[1]],
    bounds: [
      [x, y],
      [x + w, y + h],
    ],
    isEmpty: false,
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A server object's clicks, per frame. */
function seedPointsOf(o: ServerObject): Map<number, NormPoint[]> {
  const out = new Map<number, NormPoint[]>();
  for (const s of o.seeds) {
    if (s.points.length > 0) {
      out.set(s.frameIndex, s.points.map((p, i): NormPoint => [p[0], p[1], s.labels[i] === 0 ? 0 : 1]));
    }
  }
  return out;
}

export default class StudioSession {
  private _endpoint = '';
  private _env: IEnvironment | null = null;
  private _sessionId: string | null = null;
  private _tracklets = new Map<number, Tracklet>();
  /** Per object, the mask each seed frame's last click produced. */
  private _seedMasks = new Map<number, Map<number, Mask>>();
  private _seedPoints = new Map<number, Map<number, NormPoint[]>>();
  /** Per object, its absent ranges: no mask is shown inside them. */
  private _ranges = new Map<number, FrameRange[]>();
  /** The engine whose tracks the preview shows (and Track runs). */
  private _engine = DEFAULT_ENGINE;
  /** The open video's path. */
  private _videoPath: string | null = null;
  /** What its browser tracks (and, with no backend, its seeds) are stored under. */
  private _storeKey: string | null = null;
  /** Set with no backend: seeds, names and tracks live in this browser (OPFS). */
  private _offline: OfflineService | null = null;
  private readonly _local: LocalEngine;

  constructor(
    private readonly _context: VideoWorkerContext,
    private readonly _overlay: MaskOverlayEffect,
    private readonly _emit: (event: StudioEvent) => void,
  ) {
    this._local = new LocalEngine({
      frame: index => this._frameAt(index),
      video: () => {
        const decoded = this._context['_decodedVideo'];
        if (decoded == null || this._videoPath == null || !(this._context.width > 0)) {
          return null;
        }
        return {key: this._videoPath, numFrames: decoded.numFrames, width: this._context.width, height: this._context.height};
      },
      onModel: model => this._emit({type: 'localModel', model}),
    });
  }

  private get _isLocal(): boolean {
    return this._engine === BROWSER_ENGINE;
  }

  // -- setup -----------------------------------------------------------------

  init(endpoint: string, offline = false): void {
    this._endpoint = endpoint;
    if (offline) {
      if (!OpfsKv.available()) {
        throw new Error('this browser has no Origin Private File System, which studio needs without a backend');
      }
      // a job's objects are never swapped under it by an undo
      this._offline = new OfflineService(new OpfsKv(), () => this._local.heldIds());
      this._local.useStore(this._offline.tracks);
    } else {
      this._env = createEnvironment(endpoint);
    }
  }

  /** The browser engine's model variant key, for track states. */
  private get _variant(): string {
    return this._local.variant;
  }

  private get env(): IEnvironment {
    if (this._env == null) {
      throw new Error('studio worker not initialised');
    }
    return this._env;
  }

  private get sessionId(): string {
    if (this._sessionId == null) {
      throw new Error('no active session');
    }
    return this._sessionId;
  }

  async startSession(path: string, key?: string): Promise<SessionInfo> {
    this._reset();
    let objects: ServerObject[];
    if (this._offline != null) {
      // no backend: the video's sha256 keys its seeds and tracks, as on the server
      this._storeKey = key ?? path;
      this._sessionId = `offline-${this._storeKey}`;
      objects = await this._offline.objects(this._storeKey, this._variant, this._local.heldIds());
    } else {
      const res = await mutate<StudioSessionStartMutation>(this.env, START, {input: {path}});
      this._sessionId = res.startSession.sessionId;
      this._storeKey = path;
      objects = plain(res.startSession.objects) as ServerObject[];
    }
    this._videoPath = path;
    for (const o of objects) {
      this._ranges.set(o.objectId, normalizeRanges(o.ranges));
      const t = this._tracklet(o.objectId);
      const masks = new Map<number, Mask>();
      for (const s of o.seeds) {
        this._setSeedPoints(t, s.frameIndex, s.points.map((p, i) => [p[0], p[1], s.labels[i] === 0 ? 0 : 1]));
        // the mask each seed frame's last click approved: shown even with no track
        const mask = s.mask == null ? undefined : toMask(s.mask);
        if (mask != null) {
          masks.set(s.frameIndex, mask);
          this._setMask(t, s.frameIndex, mask);
        }
      }
      this._seedMasks.set(o.objectId, masks);
    }
    this._render(false);
    // thumbnails from the seed masks, once the decoder reaches those frames
    void this._thumbnails(objects.map(o => o.objectId)).then(() => this._render(true));
    return {sessionId: this._sessionId, objects};
  }

  async closeSession(): Promise<void> {
    const id = this._sessionId;
    this._reset();
    if (id != null && this._offline == null) {
      await mutate<StudioSessionCloseMutation>(this.env, CLOSE, {input: {sessionId: id}});
    }
  }

  private _reset(): void {
    this._sessionId = null;
    this._tracklets.clear();
    this._seedMasks.clear();
    this._seedPoints.clear();
    this._ranges.clear();
    this._context.clearMasks();
  }

  // -- clicks ----------------------------------------------------------------

  async setPoints(objectId: number, frameIndex: number, points: NormPoint[]): Promise<void> {
    if (points.length > 0 && absentAt(this._ranges.get(objectId), frameIndex)) {
      // the backend refuses these too; the UI says so before it sends
      throw new Error(`frame ${frameIndex + 1} is marked absent for this object: unmark it to click here`);
    }
    const t = this._tracklet(objectId);
    let list: RleList;
    if (this._offline != null) {
      // no backend: the browser engine answers, and its mask is the approved one
      const video = this._storeKey!;
      if (points.length === 0) {
        await this._offline.clearFrame(video, objectId, frameIndex, this._variant);
        this._seedMasks.get(objectId)?.delete(frameIndex);
        list = [];
      } else {
        const {rle} = await this._local.click(frameIndex, points);
        await this._offline.recordPoints(video, objectId, frameIndex, points, rle, this._variant);
        list = [{objectId, rleMask: rle}];
      }
    } else if (points.length === 0) {
      const res = await mutate<StudioSessionClearFrameMutation>(this.env, CLEAR_FRAME, {
        input: {sessionId: this.sessionId, frameIndex, objectId},
      });
      list = res.clearPointsInFrame.rleMaskList;
      this._seedMasks.get(objectId)?.delete(frameIndex);
    } else {
      // the backend stores the seeds either way; with the browser engine on
      // screen, the mask shown (and approved) is the browser's own
      const server = mutate<StudioSessionAddPointsMutation>(this.env, ADD_POINTS, {
        input: {
          sessionId: this.sessionId,
          frameIndex,
          objectId,
          points: points.map(p => [p[0], p[1]]),
          labels: points.map(p => p[2]),
          clearOldPoints: true,
        },
      });
      const local = this._isLocal ? this._local.click(frameIndex, points) : null;
      const [res, mine] = await Promise.all([server, local?.catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))]);
      list = res.addPoints.rleMaskList;
      if (mine instanceof Error) {
        this._emit({type: 'warning', message: `${engineLabel(BROWSER_ENGINE)} could not segment this click (${mine.message}); showing the backend's SAM 2 mask`});
      } else if (mine != null) {
        list = [{objectId, rleMask: mine.rle}];
      }
    }
    this._setSeedPoints(t, frameIndex, points);
    if (this._offline == null && this._storeKey != null && points.length > 0 && !this._local.heldIds().has(objectId)) {
      // back on clicks a kept browser track was made from (a click taken off): it is current again
      await this._local.store.adopt(this._storeKey, objectId, seedsKey(this._seedPoints.get(objectId) ?? new Map(), this._ranges.get(objectId) ?? []), this._variant);
    }
    // addPoints answers with every object on this frame; only the clicked
    // object's mask is new. The others' (from tracks) stay as they are.
    const mine = list.find(m => m.objectId === objectId);
    const mask = mine == null ? undefined : toMask(mine.rleMask);
    this._setMask(t, frameIndex, mask);
    if (points.length > 0) {
      const seeds = this._seedMasks.get(objectId) ?? new Map<number, Mask>();
      if (mask != null) {
        seeds.set(frameIndex, mask);
      } else {
        seeds.delete(frameIndex);
      }
      this._seedMasks.set(objectId, seeds);
      if (mask != null) {
        await this._thumbnail(t, frameIndex);
      }
    }
    this._context.updateTracklets(frameIndex, this._list(), true);
    this._emitTracklets();
  }

  async removeObject(objectId: number): Promise<void> {
    if (this._offline != null) {
      await this._offline.removeObject(this._storeKey!, objectId);
    } else {
      await mutate<StudioSessionRemoveObjectMutation>(this.env, REMOVE_OBJECT, {
        input: {sessionId: this.sessionId, objectId},
      });
    }
    const t = this._tracklets.get(objectId);
    this._tracklets.delete(objectId);
    this._seedMasks.delete(objectId);
    this._seedPoints.delete(objectId);
    this._ranges.delete(objectId);
    if (this._storeKey != null) {
      await this._local.store.delete(this._storeKey, objectId);
    }
    if (t != null) {
      this._context.clearTrackletMasks(t);
    }
    this._render(true);
  }

  // -- tracks ----------------------------------------------------------------

  /** The backend's objects, each with its browser track (this tab's) added. */
  async objectTracks(): Promise<ServerObject[]> {
    const objects =
      this._offline != null
        ? await this._offline.objects(this._storeKey!, this._variant, this._local.heldIds())
        : await this._withLocal(await this._serverObjectTracks());
    for (const o of objects) {
      this._ranges.set(o.objectId, normalizeRanges(o.ranges));
    }
    return objects;
  }

  /**
   * Mark frames start-end of an object absent, or clear them (state null).
   * Marking empties those frames on screen at once; unmarking repaints the
   * object from its cached track, which the backend blanks only where a
   * range still stands.
   */
  async setRange(objectId: number, start: number, end: number, state: 'absent' | null): Promise<ServerObject> {
    let result: ServerObject | undefined;
    if (this._offline != null) {
      await this._offline.setRange(this._storeKey!, objectId, start, end, state, this._variant);
      result = (await this.objectTracks()).find(o => o.objectId === objectId);
    } else {
      const res = await mutate<StudioSessionSetRangeMutation>(this.env, SET_RANGE, {
        input: {sessionId: this.sessionId, objectId, start: Math.min(start, end), end: Math.max(start, end), state},
      });
      result = (await this._withLocal([plain(res.setObjectRange) as ServerObject]))[0];
    }
    if (result == null) {
      throw new Error(`object ${objectId} is not known`);
    }
    const ranges = normalizeRanges(result.ranges);
    this._ranges.set(objectId, ranges);
    const t = this._tracklet(objectId);
    if (state != null) {
      for (let f = Math.min(start, end); f <= Math.max(start, end); f++) {
        this._setMask(t, f, undefined);
      }
      this._render(true);
    } else {
      // the frames just unmarked show what the cache holds there again
      this._keepSeedMasksOnly(t);
      await this.repaint([objectId]);
    }
    return result;
  }

  // -- undo, versions and moving clicks (issue #18) -----------------------------

  /**
   * Undo the object's last seed change. Its earlier track comes back from its
   * kept version with no job when it has one (the backend's tracks/versions.py,
   * or this browser's store), and the preview shows it at once.
   */
  async undo(objectId: number): Promise<ServerObject> {
    return this._seedStep(objectId, 'undo');
  }

  async redo(objectId: number): Promise<ServerObject> {
    return this._seedStep(objectId, 'redo');
  }

  private async _seedStep(objectId: number, which: 'undo' | 'redo'): Promise<ServerObject> {
    let o: ServerObject;
    if (this._offline != null) {
      const video = this._storeKey!;
      o = which === 'undo' ? await this._offline.undo(video, objectId, this._variant) : await this._offline.redo(video, objectId, this._variant);
    } else {
      const input = {sessionId: this.sessionId, objectId};
      o =
        which === 'undo'
          ? (plain((await mutate<StudioSessionUndoMutation>(this.env, UNDO, {input})).undoSeeds) as ServerObject)
          : (plain((await mutate<StudioSessionRedoMutation>(this.env, REDO, {input})).redoSeeds) as ServerObject);
      o = await this._afterSeedChange(o);
    }
    await this._showChanged([o]);
    return o;
  }

  /** Go back to one of the object's kept versions from its list (undoable). */
  async restoreVersion(objectId: number, key: string, engine: string): Promise<ServerObject> {
    let o: ServerObject;
    if (this._offline != null) {
      o = await this._offline.restoreVersion(this._storeKey!, objectId, key, this._variant);
    } else {
      if (engine === BROWSER_ENGINE) {
        throw new Error(`${engineLabel(BROWSER_ENGINE)} versions come back with undo here; the list restores the backend's`);
      }
      const res = await mutate<StudioSessionRestoreVersionMutation>(this.env, RESTORE_VERSION, {
        input: {sessionId: this.sessionId, objectId, key},
      });
      o = await this._afterSeedChange(plain(res.restoreVersion) as ServerObject);
    }
    await this._showChanged([o]);
    return o;
  }

  /**
   * Move one object's clicks on a frame to another object (clicks that landed
   * on the wrong one): one undo step for each. Needs the backend, whose SAM 2
   * segments them for the target; with no backend the browser engine does.
   */
  async moveClicks(frameIndex: number, fromId: number, toId: number): Promise<ServerObject[]> {
    if (absentAt(this._ranges.get(toId), frameIndex)) {
      throw new Error(`frame ${frameIndex + 1} is marked absent for that object: unmark it to move clicks there`);
    }
    let out: ServerObject[];
    if (this._offline != null) {
      const video = this._storeKey!;
      const moving = this._seedPoints.get(fromId)?.get(frameIndex) ?? [];
      if (moving.length === 0) {
        throw new Error(`no clicks on frame ${frameIndex + 1} to move`);
      }
      const held = this._local.heldIds();
      if (held.has(fromId) || held.has(toId)) {
        throw new Error('one of these objects is being tracked: wait for its job, or cancel it');
      }
      const points = [...(this._seedPoints.get(toId)?.get(frameIndex) ?? []), ...moving];
      const {rle} = await this._local.click(frameIndex, points);
      await this._offline.clearFrame(video, fromId, frameIndex, this._variant);
      await this._offline.recordPoints(video, toId, frameIndex, points, rle, this._variant);
      out = [
        await this._offline.objectInfo(video, fromId, this._variant, held),
        await this._offline.objectInfo(video, toId, this._variant, held),
      ];
    } else {
      const res = await mutate<StudioSessionMoveClicksMutation>(this.env, MOVE_CLICKS, {
        input: {sessionId: this.sessionId, frameIndex, fromObjectId: fromId, toObjectId: toId},
      });
      out = [];
      for (const o of plain(res.moveClicks) as ServerObject[]) {
        out.push(await this._afterSeedChange(o));
      }
    }
    await this._showChanged(out);
    return out;
  }

  /**
   * With a backend: a browser track kept for the object's clicks as they now
   * are becomes current again (this tab's store), and the object gets its
   * browser track state.
   */
  private async _afterSeedChange(o: ServerObject): Promise<ServerObject> {
    if (this._storeKey != null && !this._local.heldIds().has(o.objectId) && o.seeds.some(s => s.points.length > 0)) {
      await this._local.store.adopt(this._storeKey, o.objectId, seedsKey(seedPointsOf(o), normalizeRanges(o.ranges)), this._variant);
    }
    return (await this._withLocal([o]))[0];
  }

  /** Show objects whose seeds changed under the preview: their clicks, seed masks, and cached track. */
  private async _showChanged(objects: ServerObject[]): Promise<void> {
    for (const o of objects) {
      this._ranges.set(o.objectId, normalizeRanges(o.ranges));
      const t = this._tracklet(o.objectId);
      const now = seedPointsOf(o);
      for (const f of [...(this._seedPoints.get(o.objectId)?.keys() ?? [])]) {
        if (!now.has(f)) {
          this._setSeedPoints(t, f, []);
        }
      }
      for (const [f, pts] of now) {
        this._setSeedPoints(t, f, pts);
      }
      const masks = new Map<number, Mask>();
      for (const s of o.seeds) {
        const m = s.mask == null ? undefined : toMask(s.mask);
        if (m != null) {
          masks.set(s.frameIndex, m);
        }
      }
      this._seedMasks.set(o.objectId, masks);
      this._keepSeedMasksOnly(t);
    }
    this._render(true);
    if (this._sessionId != null) {
      await this.repaint(objects.map(o => o.objectId));
    }
  }

  /** The objects with their seeds, from the backend (or, with none, from this browser). */
  private async _serverObjectTracks(): Promise<ServerObject[]> {
    if (this._offline != null) {
      return this._offline.objects(this._storeKey!, this._variant, this._local.heldIds());
    }
    const res = await fetchQuery<StudioSessionObjectTracksQuery>(
      this.env,
      OBJECT_TRACKS,
      {sessionId: this.sessionId},
      {fetchPolicy: 'network-only'},
    ).toPromise();
    return plain(res?.objectTracks ?? []) as ServerObject[];
  }

  private async _withLocal(objects: ServerObject[]): Promise<ServerObject[]> {
    if (this._storeKey == null) {
      return objects;
    }
    const held = this._local.heldIds();
    const entries = new Map<number, LocalTrackEntry>();
    for (const o of objects) {
      const track = await this._local.store.get(this._storeKey, o.objectId);
      entries.set(
        o.objectId,
        localTrackEntry(track, {
          seedsKey: seedsKey(seedPointsOf(o), normalizeRanges(o.ranges)),
          variant: this._local.variant,
          running: held.has(o.objectId),
        }),
      );
    }
    return withLocalTracks(objects, entries);
  }

  /** Drop one engine's cached track (engine null: every engine's). */
  async clearTrack(objectId: number, engine: string | null): Promise<ServerObject> {
    if (engine == null || engine === BROWSER_ENGINE) {
      if (this._storeKey != null) {
        await this._local.store.delete(this._storeKey, objectId);
      }
    }
    let result: ServerObject | undefined;
    if (engine === BROWSER_ENGINE || this._offline != null) {
      result = (await this.objectTracks()).find(o => o.objectId === objectId);
    } else {
      const res = await mutate<StudioSessionClearTrackMutation>(this.env, CLEAR_TRACK, {
        input: {sessionId: this.sessionId, objectId, engine},
      });
      result = (await this._withLocal([plain(res.clearTrack) as ServerObject]))[0];
    }
    const t = this._tracklets.get(objectId);
    if (t != null && (engine == null || engine === this._engine)) {
      this._keepSeedMasksOnly(t);
    }
    this._render(true);
    if (result == null) {
      throw new Error(`object ${objectId} has no clicks`);
    }
    return result;
  }

  async startOver(): Promise<void> {
    await this._local.cancel(null);
    if (this._offline != null) {
      await this._offline.clearVideo(this._storeKey!);
    } else {
      await mutate<StudioSessionClearVideoMutation>(this.env, CLEAR_VIDEO, {
        input: {sessionId: this.sessionId},
      });
    }
    if (this._storeKey != null) {
      await this._local.store.clear(this._storeKey);
    }
    this._tracklets.clear();
    this._seedMasks.clear();
    this._seedPoints.clear();
    this._context.clearMasks();
    this._render(true);
  }

  /** Cancel one job (POST /cancel_track), or every job of the session. */
  async cancelTrack(jobId: string | null): Promise<boolean> {
    if (this._local.isLocalJob(jobId) || this._offline != null) {
      return this._local.cancel(jobId);
    }
    if (jobId == null) {
      const [res, local] = await Promise.all([
        mutate<StudioSessionCancelMutation>(this.env, CANCEL, {input: {sessionId: this.sessionId}}),
        this._local.cancel(null),
      ]);
      return res.cancelPropagateInVideo.success || local;
    }
    const response = await fetch(`${this._endpoint}/cancel_track`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: this.sessionId, job_id: jobId}),
    });
    if (!response.ok) {
      throw new Error(`cancel_track: HTTP ${response.status}`);
    }
    return Boolean(((await response.json()) as {canceled?: boolean}).canceled);
  }

  /** POST /export: a 400 carries the reason ({error}), which is what the user sees. */
  async exportFolder(request: ExportRequest): Promise<ExportManifest> {
    if (request.engine === BROWSER_ENGINE) {
      throw new Error(
        `Export for rotoscoping writes tracks the backend holds, and ${engineLabel(BROWSER_ENGINE)} tracks stay in this tab for now. Track with SAM 2 to export.`,
      );
    }
    const response = await fetch(`${this._endpoint}/export`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: this.sessionId, ...request}),
    });
    const body = (await response.json().catch(() => null)) as (ExportManifest & {error?: string}) | null;
    if (!response.ok || body == null) {
      throw new Error(body?.error ?? `export: HTTP ${response.status}`);
    }
    return body;
  }

  /** Every job running on this video (POST /track_jobs), other tabs' included. */
  async trackJobs(): Promise<RunningJob[]> {
    if (this._offline != null) {
      return []; // this page's own jobs are all there are
    }
    const response = await fetch(`${this._endpoint}/track_jobs`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: this.sessionId}),
    });
    if (!response.ok) {
      throw new Error(`track_jobs: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      jobs?: Array<{job_id: string; objects: number[]; frames_done: number; n_frames: number | null; elapsed_s: number}>;
    };
    return (body.jobs ?? []).map(j => ({
      jobId: j.job_id,
      objects: j.objects,
      framesDone: j.frames_done,
      nFrames: j.n_frames,
      elapsedS: j.elapsed_s,
    }));
  }

  /**
   * Run one track job for `objectIds` (the backend claims the ones no other
   * job holds). Only those objects' masks are replaced as the stream arrives;
   * every other object keeps what it shows, and the view stays on the frame
   * the user is on, so clicking goes on while jobs run. A job that does not
   * finish caches nothing on the backend, so its objects are repainted from
   * their cached tracks instead.
   */
  async track(objectIds: number[], key: number, engine: string): Promise<TrackResult> {
    if (engine === BROWSER_ENGINE) {
      return this._trackLocal(objectIds, key);
    }
    const response = await fetch(`${this._endpoint}/track_objects`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: this.sessionId, object_ids: objectIds, engine}),
    });
    if (!response.ok) {
      // an unknown or unavailable engine is a 400 {error}, before any stream
      const body = (await response.json().catch(() => null)) as {error?: string} | null;
      return {
        selected: [],
        jobId: null,
        outcome: {ok: false, error: body?.error ?? `track_objects: HTTP ${response.status}`, objects: []},
      };
    }
    const selected = parseObjectsHeader(response.headers.get('Objects-Tracked'));
    const jobId = response.headers.get('Job-Id');
    const bounded = parseObjectsHeader(response.headers.get('Objects-Bounded'));
    this._emit({type: 'jobStarted', key, jobId, selected, bounded});
    // a job's masks are drawn only while its engine is the one on screen
    const shown = () => engine === this._engine;
    if (shown()) {
      for (const id of selected) {
        this._keepSeedMasksOnly(this._tracklet(id));
      }
      this._render(true);
    }

    let closing: DonePart | ErrorPart | null = null;
    let streamError: string | null = null;
    let n = 0;
    try {
      for await (const part of readTrackStream(
        response.headers.get('Content-Type'),
        response.body,
      )) {
        if (part.kind !== 'frame') {
          closing = part;
          continue;
        }
        this._emit({type: 'trackFrame', key, frameIndex: part.frameIndex});
        if (!shown()) {
          continue;
        }
        for (const r of part.results) {
          this._setMask(this._tracklet(r.objectId), part.frameIndex, toMask(r.mask));
        }
        // redraw only when the frame on screen changed; never move the view
        this._context.updateTracklets(
          this._context.frameIndex,
          this._list(),
          part.frameIndex === this._context.frameIndex,
        );
        if (++n % 12 === 0) {
          this._emitTracklets();
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error.message : String(error);
    }

    const outcome =
      streamError != null
        ? ({ok: false, error: streamError, objects: selected} as const)
        : jobOutcome(closing);
    if (!shown()) {
      // the view moved to another engine meanwhile: nothing of this job is on screen
      return {selected, jobId, outcome};
    }
    if (!outcome.ok || Object.keys(outcome.failed).length > 0) {
      const lost = outcome.ok ? Object.keys(outcome.failed).map(Number) : selected;
      for (const id of lost) {
        const t = this._tracklets.get(id);
        if (t != null) {
          this._keepSeedMasksOnly(t);
        }
      }
      if (lost.length > 0) {
        await this.repaint(lost).catch(err =>
          this._emit({type: 'warning', message: `could not repaint cached tracks: ${String(err)}`}),
        );
      }
    } else {
      await this._thumbnails(outcome.tracked);
    }
    this._render(true);
    return {selected, jobId, outcome};
  }

  /**
   * A browser track job, the local twin of the server path above: it claims
   * its objects, tracks them from the backend's seeds with each seed frame's
   * approved mask (the mask its latest click showed, from either engine),
   * streams frames into the preview while the browser engine is on screen,
   * and keeps the track only when the whole job finishes.
   */
  private async _trackLocal(objectIds: number[], key: number): Promise<TrackResult> {
    const video = this._storeKey;
    if (video == null) {
      throw new Error('no active session');
    }
    const objects = await this._serverObjectTracks();
    const held = this._local.heldIds();
    const byId = new Map(objects.map(o => [o.objectId, o]));
    const selected = [...new Set(objectIds)]
      .filter(id => !held.has(id) && (byId.get(id)?.seeds.some(s => s.points.length > 0) ?? false))
      .sort((a, b) => a - b);
    const jobId = this._local.claim(selected);
    this._emit({type: 'jobStarted', key, jobId, selected});
    if (selected.length === 0) {
      this._local.release(jobId);
      return {selected, jobId, outcome: {ok: true, objects: [], tracked: [], failed: {}}};
    }
    // taken at the start, as the backend does: clicks edited mid-job leave the track stale
    const keys = new Map<number, string>();
    const records = new Map<number, Record<string, unknown> | null>();
    const variant = this._local.variant;
    const jobObjects = selected.map(id => {
      const o = byId.get(id)!;
      const points = seedPointsOf(o);
      const ranges = normalizeRanges(o.ranges);
      keys.set(id, seedsKey(points, ranges));
      const approved = this._seedMasks.get(id);
      return {
        id,
        ranges,
        seeds: [...points].map(([frame, pts]) => ({frame, points: pts, mask: (approved?.get(frame)?.data as RLEObject | undefined) ?? null})),
      };
    });
    // one pass per window between absent ranges, each from its own seeds; with
    // no ranges that is one pass over the whole clip, as before ranges existed.
    // Frames outside every seeded window get no mask: empty.
    if (this._offline != null) {
      for (const id of selected) {
        // so the list can restore its version; a click that came in since makes
        // the record another set of clicks, which the version must not claim
        const record = await this._offline.seeds.record(video, id);
        records.set(id, SeedStore.recordKey(record) === keys.get(id) ? record : null);
      }
    }
    const units = planUnits(jobObjects).map(u => ({
      objects: u.objects.map((o): TrackObject => ({id: o.id, seeds: o.seeds})),
      window: u.window.lo === 0 && u.window.hi == null ? undefined : u.window,
    }));
    const shown = () => this._isLocal;
    if (shown()) {
      for (const id of selected) {
        this._keepSeedMasksOnly(this._tracklet(id));
      }
      this._render(true);
    }
    const masks = new Map(selected.map(id => [id, new Map<number, RLEObject>()]));
    let n = 0;
    let error: string | null = null;
    let canceled = false;
    try {
      const res = await this._local.run(jobId, units, (frame, frameMasks) => {
        this._emit({type: 'trackFrame', key, frameIndex: frame});
        for (const [id, rle] of frameMasks) {
          masks.get(id)?.set(frame, rle);
        }
        if (!shown()) {
          return;
        }
        for (const [id, rle] of frameMasks) {
          this._setMask(this._tracklet(id), frame, toMask(rle));
        }
        this._context.updateTracklets(this._context.frameIndex, this._list(), frame === this._context.frameIndex);
        if (++n % 12 === 0) {
          this._emitTracklets();
        }
      });
      canceled = res.canceled;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (error == null && !canceled) {
      for (const id of selected) {
        const m = masks.get(id)!;
        await this._local.store.put(video, {
          objectId: id,
          seedsKey: keys.get(id)!,
          variant,
          masks: m,
          nFrames: m.size,
          record: records.get(id) ?? null,
          created: new Date().toISOString(),
        });
      }
    }
    const outcome =
      error != null
        ? ({ok: false, error, objects: selected} as const)
        : canceled
          ? ({ok: false, error: 'cancelled', objects: selected} as const)
          : ({ok: true, objects: selected, tracked: selected, failed: {}} as const);
    if (shown()) {
      if (!outcome.ok) {
        for (const id of selected) {
          this._keepSeedMasksOnly(this._tracklet(id));
        }
        await this.repaint(selected);
      } else {
        await this._thumbnails(selected);
      }
      this._render(true);
    }
    return {selected, jobId, outcome};
  }

  /**
   * A mask export, built here: the masks of the engine on screen (for the
   * browser engine, its stored tracks), the video's size, fps and frame
   * count, and the provenance the files carry.
   */
  async exportMasks(args: {
    kind: ExportKind;
    objects: ExportedObject[];
    engine: string;
    engineLabel: string;
    model: string;
    groups?: ExportGroup[];
    union?: boolean;
  }): Promise<ArrayBuffer> {
    const decoded = this._context['_decodedVideo'];
    if (decoded == null || this._videoPath == null || this._storeKey == null) {
      throw new Error('the video is not open yet');
    }
    const local = new Map<number, Map<number, RLEObject>>();
    const objects = [...args.objects];
    if (args.engine === BROWSER_ENGINE) {
      for (const [i, o] of objects.entries()) {
        const track = await this._local.store.get(this._storeKey, o.objectId);
        if (track == null) {
          throw new Error(`${o.label} has no ${engineLabel(BROWSER_ENGINE)} track`);
        }
        local.set(o.objectId, track.masks);
        objects[i] = {...o, model: variantModel(track.variant)};
      }
    }
    const provenance = {
      engine: args.engine,
      engineLabel: args.engineLabel,
      model: args.model,
      video: this._videoPath,
      frames: decoded.numFrames,
      fps: decoded.fps,
      width: this._context.width,
      height: this._context.height,
      exported: new Date().toISOString(),
    };
    const bytes = await buildExport(
      args.kind,
      provenance,
      objects,
      {
        maskAt: (id, frame) =>
          args.engine === BROWSER_ENGINE
            ? (local.get(id)?.get(frame) ?? null)
            : ((this._tracklets.get(id)?.masks[frame]?.data as RLEObject | undefined) ?? null),
        seedsOf: id => this._seedPoints.get(id) ?? new Map(),
      },
      done => this._emit({type: 'exportProgress', done}),
      {groups: args.groups, union: args.union},
    );
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  /**
   * POST /object_layout. Only a missing route (a backend from before layouts)
   * is "unsupported"; a network or server error throws, because the stored
   * layout is then unknown, not empty (state/layoutSync.ts).
   */
  async objectLayout(): Promise<{layout: Layout; supported: boolean}> {
    if (this._offline != null) {
      return {layout: await this._offline.layout(this._storeKey!), supported: true};
    }
    const response = await fetch(`${this._endpoint}/object_layout`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: this.sessionId}),
    }).catch(() => null);
    const body = response?.ok ? await response.json().catch(() => null) : null;
    return layoutFromResponse(response?.status ?? null, body);
  }

  /** POST /set_object_layout. A backend from before layouts answers 404: not saved, no error. */
  async setObjectLayout(layout: Layout): Promise<{saved: boolean}> {
    if (this._offline != null) {
      await this._offline.setLayout(this._storeKey!, layout);
      return {saved: true};
    }
    const response = await fetch(`${this._endpoint}/set_object_layout`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: this.sessionId, layout}),
    }).catch(() => null);
    if (response == null || response.status === 404 || response.status === 405) {
      return {saved: false};
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {error?: string} | null;
      throw new Error(body?.error ?? `set_object_layout: HTTP ${response.status}`);
    }
    return {saved: true};
  }

  /** POST /rename_object. A backend from before names answers 404: not saved, no error. */
  async renameObject(objectId: number, name: string | null): Promise<{saved: boolean}> {
    if (this._offline != null) {
      await this._offline.seeds.setName(this._storeKey!, objectId, name);
      return {saved: true};
    }
    // an older backend has no such route: its CORS preflight fails (a
    // network error) or the call 404s; either way the name stays unsaved
    const response = await fetch(`${this._endpoint}/rename_object`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: this.sessionId, object_id: objectId, name}),
    }).catch(() => null);
    if (response == null || response.status === 404 || response.status === 405) {
      return {saved: false};
    }
    if (!response.ok) {
      throw new Error(`rename_object: HTTP ${response.status}`);
    }
    return {saved: true};
  }

  /** POST /object_names; a backend from before names has none (404). */
  async objectNames(): Promise<{names: Record<number, string>; supported: boolean}> {
    if (this._offline != null) {
      return {names: await this._offline.seeds.names(this._storeKey!), supported: true};
    }
    const response = await fetch(`${this._endpoint}/object_names`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: this.sessionId}),
    }).catch(() => null);
    if (response == null || response.status === 404 || response.status === 405) {
      return {names: {}, supported: false};
    }
    if (!response.ok) {
      throw new Error(`object_names: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {names?: Record<string, string>};
    return {names: Object.fromEntries(Object.entries(body.names ?? {}).map(([k, v]) => [Number(k), v])), supported: true};
  }

  /** The browser engine's model size and hole fill. */
  setLocalOptions(options: LocalOptions): void {
    this._local.setOptions(options);
  }

  /** Stream cached tracks (all objects, or `objectIds`) into the preview. */
  async repaint(objectIds?: number[]): Promise<void> {
    if (this._isLocal) {
      return this._repaintLocal(objectIds);
    }
    this._emit({type: 'repaint', active: true});
    try {
      const response = await fetch(`${this._endpoint}/track_masks`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({session_id: this.sessionId, object_ids: objectIds ?? null, engine: this._engine}),
      });
      if (!response.ok) {
        throw new Error(`track_masks: HTTP ${response.status}`);
      }
      for await (const part of readTrackStream(
        response.headers.get('Content-Type'),
        response.body,
      )) {
        if (part.kind !== 'frame') {
          continue;
        }
        for (const r of part.results) {
          this._setMask(this._tracklet(r.objectId), part.frameIndex, toMask(r.mask));
        }
      }
      this._render(true);
      await this._thumbnails([...this._tracklets.keys()]);
      this._render(true);
    } finally {
      this._emit({type: 'repaint', active: false});
    }
  }

  /** repaint() for the browser engine: from this tab's store. */
  private async _repaintLocal(objectIds?: number[]): Promise<void> {
    if (this._storeKey == null) {
      return;
    }
    const wanted = objectIds == null ? null : new Set(objectIds);
    for (const track of await this._local.store.list(this._storeKey)) {
      if (wanted != null && !wanted.has(track.objectId)) {
        continue;
      }
      if ((this._seedPoints.get(track.objectId)?.size ?? 0) === 0) {
        continue; // no clicks, nothing to show (as the backend does)
      }
      const t = this._tracklet(track.objectId);
      for (const [frame, rle] of track.masks) {
        this._setMask(t, frame, toMask(rle));
      }
    }
    this._render(true);
    await this._thumbnails([...this._tracklets.keys()]);
    this._render(true);
  }

  /**
   * Show another engine's tracks: every object falls back to its seed masks,
   * then the engine's cached tracks stream in.
   */
  async setEngine(engine: string): Promise<void> {
    if (engine === this._engine) {
      return;
    }
    this._engine = engine;
    for (const t of this._tracklets.values()) {
      this._keepSeedMasksOnly(t);
    }
    this._render(true);
    if (this._sessionId != null) {
      await this.repaint();
    }
  }

  /** GET /engines: every engine the backend knows, and whether it can run. */
  async engines(): Promise<EngineInfo[]> {
    if (this._offline != null) {
      return []; // no backend: the browser engine is added by the UI
    }
    const response = await fetch(`${this._endpoint}/engines`);
    if (!response.ok) {
      throw new Error(`engines: HTTP ${response.status}`);
    }
    return ((await response.json()) as {engines?: EngineInfo[]}).engines ?? [];
  }

  /** POST /track_disagreement: frames where two engines' current tracks differ. */
  async disagreement(a: string, b: string, objectIds?: number[]): Promise<Disagreement> {
    const response = await fetch(`${this._endpoint}/track_disagreement`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: this.sessionId, a, b, object_ids: objectIds ?? null}),
    });
    const body = (await response.json().catch(() => null)) as (Disagreement & {error?: string}) | null;
    if (!response.ok || body == null) {
      throw new Error(body?.error ?? `track_disagreement: HTTP ${response.status}`);
    }
    return body;
  }

  setActiveObject(objectId: number | null): void {
    this._overlay.activeObjectId = objectId;
    this._render(true);
  }

  /** Draw these objects' track faded, except on frames their clicks made. */
  setStaleObjects(objectIds: number[]): void {
    const stale = new Set(objectIds);
    this._overlay.faded = (id, frame) => stale.has(id) && !(this._seedMasks.get(id)?.has(frame) ?? false);
    this._render(true);
  }

  // -- tracklets ---------------------------------------------------------------

  private _tracklet(id: number): Tracklet {
    let t = this._tracklets.get(id);
    if (t == null) {
      t = {id, color: colorFor(id), thumbnail: null, points: [], masks: [], isInitialized: true};
      this._tracklets.set(id, t);
    }
    return t;
  }

  private _list(): Tracklet[] {
    return [...this._tracklets.values()].sort((a, b) => a.id - b.id);
  }

  private _setMask(t: Tracklet, frame: number, mask: Mask | undefined): void {
    if (mask == null || absentAt(this._ranges.get(t.id), frame)) {
      delete t.masks[frame];
    } else {
      t.masks[frame] = mask;
    }
  }

  private _setSeedPoints(t: Tracklet, frame: number, points: NormPoint[]): void {
    const w = this._context.width || 1;
    const h = this._context.height || 1;
    t.points[frame] =
      points.length === 0
        ? undefined
        : points.map((p): SegmentationPoint => [p[0] * w, p[1] * h, p[2]]);
    const seeds = this._seedPoints.get(t.id) ?? new Map<number, NormPoint[]>();
    if (points.length === 0) {
      seeds.delete(frame);
    } else {
      seeds.set(frame, points);
    }
    this._seedPoints.set(t.id, seeds);
  }

  /** Drop a track's masks but keep what the clicks themselves produced. */
  private _keepSeedMasksOnly(t: Tracklet): void {
    t.masks = [];
    for (const [frame, mask] of this._seedMasks.get(t.id) ?? []) {
      this._setMask(t, frame, mask);
    }
  }

  private _render(redraw: boolean): void {
    this._context.updateTracklets(this._context.frameIndex, this._list(), redraw);
    this._emitTracklets();
  }

  private _emitTracklets(): void {
    this._emit({
      type: 'tracklets',
      tracklets: this._list().map(t => ({
        id: t.id,
        color: t.color,
        thumbnail: t.thumbnail,
        segments: maskSegments(t.masks),
      })),
    });
  }

  // -- thumbnails (Meta's generateThumbnail, fed from our masks) ---------------

  /**
   * Frame `index` of the open video, decoded on demand (a VideoFrame the
   * caller must close), once the video is open; null past its end.
   */
  private async _frameAt(index: number, timeoutMs = 20_000): Promise<VideoFrame | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Meta's context keeps its video private; bracket access is the
      // TypeScript escape hatch for reading it without copying the class.
      const video = this._context['_decodedVideo'];
      if (video != null) {
        return index >= 0 && index < video.numFrames ? this._context.frameAt(index) : null;
      }
      await sleep(100);
    }
    return null;
  }

  private async _thumbnail(t: Tracklet, frameIndex: number): Promise<void> {
    const mask = t.masks[frameIndex];
    if (mask == null || mask.isEmpty) {
      return;
    }
    if ((t.points[frameIndex]?.length ?? 0) === 0) {
      return;
    }
    const rle = mask.data as RLEObject;
    const [h, w] = rle.size;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    if (ctx == null) {
      return;
    }
    const frame = await this._frameAt(frameIndex);
    if (frame == null) {
      return;
    }
    const image = ctx.createImageData(w, h);
    paintAlpha(new Uint32Array(image.data.buffer), rle);
    ctx.putImageData(image, 0, 0);
    try {
      await generateThumbnail(t, frameIndex, mask, frame, ctx);
    } catch (error) {
      this._emit({type: 'warning', message: `thumbnail failed: ${String(error)}`});
    } finally {
      frame.close();
    }
  }

  /** A thumbnail for each object that has none, from its first seed frame with a mask. */
  private async _thumbnails(ids: number[]): Promise<void> {
    for (const id of ids) {
      const t = this._tracklets.get(id);
      if (t == null || t.thumbnail != null) {
        continue;
      }
      const frames = [...(this._seedPoints.get(id)?.keys() ?? [])].sort((a, b) => a - b);
      for (const f of frames) {
        if (t.masks[f] != null) {
          if (t.points[f] == null || t.points[f]!.length === 0) {
            continue;
          }
          await this._thumbnail(t, f);
          if (t.thumbnail != null) {
            break;
          }
        }
      }
    }
  }
}
