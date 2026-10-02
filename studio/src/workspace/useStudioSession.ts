// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// One video's editing session: the worker bridge, the Objects reducer, and
// every backend call the UI makes. Calls that change seeds run one at a time,
// in click order, and each ends with a sync from objectTracks, the backend's
// word on every object's track state. Track jobs run beside them: the backend
// serves clicks between a job's frames, so nothing locks while jobs run.
import type {
  DecodeEvent,
  FrameUpdateEvent,
} from '@/common/components/video/VideoWorkerBridge';
import {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import StudioBridge from '~/bridge/StudioBridge';
import {explainGraphQLError} from '~/lib/errors';
import {
  EffectMap,
  UntouchedMode,
  exportEffects,
  parseEffectMap,
  pickEffect,
  pruneEffects,
} from '~/state/objectEffects';
import {isOffline} from '~/lib/mode';
import {webGpuAvailable} from '~/lib/webgpu';
import {requestPersistentStorage} from '~/lib/persist';
import {closeSessionOnUnload, recordClose, recordOpen} from '~/lib/sessionClose';
import {readJson, writeJson} from '~/lib/storage';
import {API_ENDPOINT, OBJECT_LIMIT} from '~/config';
import type {LocalModelStatus, LocalOptions} from '~/local/LocalEngine';
import {browserModelName, parseQuality} from '~/local/sam2/config';
import {BROWSER_ENGINE, engineLabel, pickerEngines} from '~/state/engines';
import {goneSteps, isNeedsPositive, planClicks, refusedAsAbsent, type Hint, type Nudge} from '~/state/corrections';
import {cleanObjectName, objectName, uniqueFileNames} from '~/state/fileNames';
import type {ExportedObject, ExportKind} from '~/state/maskExport';
import {
  DEFAULT_ENGINE,
  NormPoint,
  canAddObject,
  comparableIds,
  dirtyIds,
  preferredEngine,
  initialState,
  nextObjectId,
  reducer,
  seedFrames,
  staleIds,
} from '~/state/objects';
import {clearFlag, parseFlagMap, pruneFlags, toggleFlag as toggled, type FlagMap} from '~/state/flags';
import {ABSENT, absentAt, absentUntilNextSeed, normalizeRanges, paintRange, type RangeState} from '~/state/ranges';
import type {EngineInfo, RunningJob, TrackletSummary} from '~/worker/protocol';

/** Where two engines disagree on one object: frames under the IoU threshold. */
export type ObjectDisagreement = {flagged: number[]; meanIou: number | null};

const ENGINE_KEY = 'sam-ui-studio:engine';
const LOCAL_OPTIONS_KEY = 'sam-ui-studio:browserEngine';

/** The browser engine's settings as remembered (512 px and no hole fill by default). */
function readLocalOptions(): LocalOptions {
  const raw = readJson<Partial<LocalOptions>>(LOCAL_OPTIONS_KEY, {});
  return {quality: parseQuality(raw.quality ?? 512), fillHoleArea: raw.fillHoleArea === 8 ? 8 : 0};
}

/** Meta's selected-object effects (EffectsUtils' highlight and "more" lists). */
const HIGHLIGHT_NAMES = [
  'Cutout',
  'EraseForeground',
  'VibrantMask',
  'PixelateMask',
  'Overlay',
  'Replace',
  'Burst',
  'Scope',
  'NoisyMask',
];

/** The engine studio compares SAM 2 with when both have tracks. */
const COMPARE_ENGINE = 'sam3';

export type VideoItem = {
  path: string;
  url: string;
  width: number;
  height: number;
  posterUrl: string | null;
  /** The file's sha256, for videos kept in this browser (no backend). */
  key?: string;
};

export type SessionStatus = 'starting' | 'ready' | 'failed';

export type Metadata = {numFrames: number; fps: number; width: number; height: number; decoded: boolean};

function message(error: unknown): string {
  return explainGraphQLError(error instanceof Error ? error.message : String(error));
}

/** Why a click on an absent frame is refused, and what to do instead. */
function absentWarning(target: Parameters<typeof objectName>[0] | undefined, frame: number): string {
  return (
    `${target != null ? objectName(target) : 'This object'} is marked absent on frame ${frame + 1}. ` +
    'Select that part of its lane and unmark it to click here.'
  );
}

export default function useStudioSession(video: VideoItem) {
  const [bridge, setBridge] = useState<StudioBridge | null>(null);
  // the engine is remembered per browser: a reload keeps showing the tracks you chose
  const [state, dispatch] = useReducer(reducer, initialState, s => ({
    ...s,
    engine: readJson<string>(ENGINE_KEY, s.engine),
  }));
  const [status, setStatus] = useState<SessionStatus>('starting');
  const [statusError, setStatusError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [meta, setMeta] = useState<Metadata>({
    numFrames: 0,
    fps: 0,
    width: video.width,
    height: video.height,
    decoded: false,
  });
  const [playing, setPlaying] = useState(false);
  const [tracklets, setTracklets] = useState<Map<number, TrackletSummary>>(new Map());
  const [repainting, setRepainting] = useState(false);
  const [pending, setPending] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);
  /** Jobs on this video that this page did not start (another tab's). */
  const [foreignJobs, setForeignJobs] = useState<RunningJob[]>([]);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  /** A backend answered GET /engines (studio without one is the browser-only build). */
  const [backend, setBackend] = useState(false);
  /** WebGPU works here (null until checked). */
  const [webgpu, setWebgpu] = useState<boolean | null>(null);
  const [disagreement, setDisagreement] = useState<Map<number, ObjectDisagreement>>(new Map());
  const [localOptions, setLocalOptionsState] = useState<LocalOptions>(readLocalOptions);
  const [localModel, setLocalModel] = useState<LocalModelStatus | null>(null);
  const localOptionsRef = useRef(localOptions);
  localOptionsRef.current = localOptions;
  // one past the highest object id ever used on this video, so a deleted
  // object's number is never handed out again (remembered per browser)
  const nextIdKey = `sam-ui-studio:next-object:${video.path}`;
  const idFloor = useRef<number>(readJson<number>(nextIdKey, 0));
  const namesWarned = useRef(false);

  const stateRef = useRef(state);
  stateRef.current = state;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const nextJobKey = useRef(1);
  const sessionIdRef = useRef<string | null>(null);

  // A reload or a closed tab never unmounts the Workspace, so its session
  // would linger on the backend (and keep the video from being deleted) until
  // the idle expiry. Close it as the page goes, with a keepalive request that
  // outlives the page.
  useEffect(() => {
    const onHide = () => {
      const id = sessionIdRef.current;
      if (id != null && !isOffline()) {
        closeSessionOnUnload(id);
        sessionIdRef.current = null;
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  // one worker per video; the canvas mounts once the bridge exists
  useEffect(() => {
    const b = StudioBridge.createStudio();
    setBridge(b);
    recordOpen(video.path);
    return () => {
      // recorded, so deleting this video can wait for the session to close
      recordClose(
        video.path,
        b
          .call('closeSession', {})
          .catch(() => {})
          .finally(() => b.terminate()),
      );
    };
    // one worker per Workspace, which is keyed by the video path
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (bridge == null) {
      return;
    }
    const onFrame = (e: FrameUpdateEvent) => setFrame(e.index);
    const onDecode = (e: DecodeEvent) =>
      setMeta({numFrames: e.totalFrames, fps: e.fps, width: e.width, height: e.height, decoded: e.done});
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    bridge.addEventListener('frameUpdate', onFrame);
    bridge.addEventListener('decode', onDecode);
    bridge.addEventListener('play', onPlay);
    bridge.addEventListener('pause', onPause);
    const off = bridge.onStudioEvent(event => {
      switch (event.type) {
        case 'tracklets':
          setTracklets(new Map(event.tracklets.map(t => [t.id, t])));
          break;
        case 'jobStarted':
          dispatch({
            type: 'trackAttached',
            key: event.key,
            jobId: event.jobId,
            selected: event.selected,
            bounded: event.bounded,
          });
          if (event.jobId != null && !event.jobId.startsWith('local-')) {
            // the backend knows the job's full length (frames x passes)
            const {key, jobId} = event;
            bridge
              .call('trackJobs', {})
              .then(jobs => {
                const total = jobs.find(j => j.jobId === jobId)?.nFrames;
                if (total != null) {
                  dispatch({type: 'trackTotal', key, total});
                }
              })
              .catch(() => {});
          }
          break;
        case 'trackFrame':
          dispatch({type: 'trackProgress', key: event.key});
          break;
        case 'repaint':
          setRepainting(event.active);
          break;
        case 'warning':
          setWarning(event.message);
          break;
        case 'exportProgress':
          setExportProgress(event.done);
          break;
        case 'localModel': {
          const m = event.model;
          setLocalModel(m);
          if (m.status === 'loading') {
            requestPersistentStorage(); // keep the downloaded model across visits
          }
          if (m.status === 'failed') {
            setWarning(`The browser engine could not load its ${m.quality} px model: ${m.error}`);
          }
          setEngines(list =>
            list.map(e => (e.name === BROWSER_ENGINE ? {...e, loaded: m.status === 'ready', loading: m.status === 'loading'} : e)),
          );
          break;
        }
      }
    });
    return () => {
      bridge.removeEventListener('frameUpdate', onFrame);
      bridge.removeEventListener('decode', onDecode);
      bridge.removeEventListener('play', onPlay);
      bridge.removeEventListener('pause', onPause);
      off();
    };
  }, [bridge]);

  /** Called by the preview once it has handed its canvas to the worker. */
  const start = useCallback(async () => {
    if (bridge == null) {
      return;
    }
    bridge.setSource(video.url);
    try {
      await bridge.call('init', {endpoint: API_ENDPOINT, offline: isOffline()});
      await bridge.call('setLocalOptions', localOptionsRef.current);
      const server = await bridge.call('engines', {}).catch(() => [] as EngineInfo[]);
      setBackend(server.length > 0);
      // the backend's engines, then the browser engine (WebGPU only)
      const gpu = await webGpuAvailable();
      setWebgpu(gpu);
      const list = pickerEngines(server, {webgpu: gpu, backend: server.length > 0});
      setEngines(list);
      // a remembered engine the backend cannot run (any more) falls back to the default
      const wanted = stateRef.current.engine;
      const usable = list.length === 0 || list.some(e => e.name === wanted && e.available);
      const engine = usable ? wanted : (list.find(e => e.default)?.name ?? DEFAULT_ENGINE);
      if (engine !== wanted) {
        dispatch({type: 'setEngine', engine});
      }
      await bridge.call('setEngine', {engine});
      const info = await bridge.call('startSession', {path: video.path, key: video.key});
      sessionIdRef.current = info.sessionId;
      dispatch({type: 'restore', objects: info.objects});
      setStatus('ready');
      // names are plain metadata: an older backend has none, and that is fine
      bridge
        .call('objectNames', {})
        .then(res => dispatch({type: 'names', names: res.names}))
        .catch(() => {});
      // show an engine that has tracks: a SAM 3-only video opens on SAM 3
      const shown = preferredEngine(
        info.objects,
        engine,
        list.filter(e => e.available).map(e => e.name),
      );
      if (shown !== engine) {
        dispatch({type: 'setEngine', engine: shown});
        await bridge.call('setEngine', {engine: shown}); // repaints that engine's cache
      } else if (info.objects.length > 0) {
        await bridge.call('repaint', {});
      }
    } catch (error) {
      setStatus('failed');
      setStatusError(message(error));
    }
  }, [bridge, video.path, video.url, video.key]);

  const sync = useCallback(async () => {
    if (bridge == null) {
      return;
    }
    const objects = await bridge.call('objectTracks', {});
    dispatch({type: 'sync', objects});
  }, [bridge]);

  // The backend frees sessions idle past SAM_UI_SESSION_TTL_MIN (30 min). An
  // open, visible tab keeps its session by touching it now and then; a hidden
  // or closed one lets it go.
  useEffect(() => {
    if (bridge == null || status !== 'ready') {
      return;
    }
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        sync().catch(error =>
          setWarning(`${message(error)}. Reload the page to start a new session.`),
        );
      }
    }, 5 * 60_000);
    return () => clearInterval(timer);
  }, [bridge, status, sync]);

  /** Run seed-changing calls one after another, in the order they were made. */
  const serial = useCallback(
    (fn: () => Promise<void>) => {
      setPending(n => n + 1);
      const next = queue.current.then(fn).catch(error => setWarning(message(error)));
      queue.current = next.finally(() => setPending(n => n - 1));
      return next;
    },
    [],
  );

  // clicks stay open while jobs run; only a session start or a repaint holds them
  // no engine can run (the browser-only build without WebGPU): nothing to click or track
  const noEngine = engines.length > 0 && engines.every(e => !e.available);
  const busy = repainting || status !== 'ready' || noEngine;

  // review flags (F while scrubbing), saved per video in this browser
  const flagsKey = `sam-ui-studio:flags:${video.path}`;
  const [flags, setFlags] = useState<FlagMap>(() => parseFlagMap(readJson(flagsKey, {})));
  useEffect(() => {
    writeJson(flagsKey, flags);
  }, [flagsKey, flags]);

  // A frame's clicks the engine on screen cannot take (negatives only on SAM
  // 2): nothing is sent, the clicks stay as they were, and the preview nudges
  // for a positive. `hint` (kind 'gone'): SAM 3 took negatives alone and
  // emptied the frame, so the preview asks whether the object is gone for a
  // while. Both carry the object and frame their "Gone for a while?" marks.
  const [nudge, setNudge] = useState<Nudge | null>(null);
  const nudgeRef = useRef(nudge);
  nudgeRef.current = nudge;
  const [hint, setHint] = useState<Hint | null>(null);
  /** The clicks the nudge refused, which Switch to SAM 3 sends. */
  const refused = useRef<NormPoint[]>([]);
  const showNudge = useCallback((objectId: number, frameIndex: number, points: NormPoint[], engine: string) => {
    refused.current = points;
    setHint(null);
    setNudge({objectId, frame: frameIndex, engine});
  }, []);
  useEffect(() => {
    setNudge(null);
    setHint(null);
  }, [frame]);

  const setPoints = useCallback(
    (objectId: number, frameIndex: number, points: NormPoint[], engine: string = stateRef.current.engine) => {
      if (bridge == null) {
        return;
      }
      const before = stateRef.current.objects.find(o => o.id === objectId)?.points[frameIndex] ?? [];
      dispatch({type: 'setPoints', id: objectId, frame: frameIndex, points});
      serial(async () => {
        try {
          await bridge.call('setPoints', {objectId, frameIndex, points, engine});
          if (points.length > 0) {
            setFlags(m => clearFlag(m, objectId, frameIndex)); // corrected
          }
        } catch (error) {
          if (!isNeedsPositive(error)) {
            setHint(null); // a SAM 3 send that failed emptied nothing
            throw error;
          }
          // the backend refused what studio let through (an old cached list,
          // a race) and kept the frame as it was: so does studio, and it nudges
          dispatch({type: 'setPoints', id: objectId, frame: frameIndex, points: before});
          showNudge(objectId, frameIndex, points, engine);
        }
        await sync();
      });
    },
    [bridge, serial, sync, showNudge],
  );

  /** Send a frame's new clicks, or refuse or nudge and keep the old ones (state/corrections.ts). */
  const correct = useCallback(
    (objectId: number, current: NormPoint[], next: NormPoint[]) => {
      const engine = stateRef.current.engine;
      const target = stateRef.current.objects.find(o => o.id === objectId);
      // inside an absent range, clicks with no positive are refused before any
      // nudge: its "add a positive" would end the absence, not trim. A positive
      // goes through and ends the absence at this frame; sync() shows the range.
      if (refusedAsAbsent(next, absentAt(target?.ranges, frame))) {
        setWarning(absentWarning(target, frame));
        return;
      }
      const plan = planClicks(current, next, engine);
      if (plan.kind === 'nudge') {
        showNudge(objectId, frame, next, engine);
        return;
      }
      setNudge(null);
      setHint(plan.gone ? {kind: 'gone', objectId, frame} : null);
      setPoints(objectId, frame, [...plan.points], engine);
    },
    [frame, setPoints, showNudge],
  );

  /** A new object's id: past every id this video has used, and remembered. */
  const claimId = useCallback(
    (objects: ReadonlyArray<{id: number}>) => {
      const id = nextObjectId(objects, idFloor.current);
      idFloor.current = id + 1;
      writeJson(nextIdKey, idFloor.current);
      return id;
    },
    [nextIdKey],
  );

  const addPoint = useCallback(
    (x: number, y: number, label: 0 | 1) => {
      if (bridge == null || busy) {
        return;
      }
      if (playing) {
        bridge.pause();
        return;
      }
      const s = stateRef.current;
      let id = s.activeId;
      if (id == null) {
        if (!canAddObject(s, OBJECT_LIMIT)) {
          setWarning(`An object limit of ${OBJECT_LIMIT} is set. Remove one to add another.`);
          return;
        }
        id = claimId(s.objects);
        dispatch({type: 'add', id});
        bridge.call('setActiveObject', {objectId: id}).catch(() => {});
      }
      const target = s.objects.find(o => o.id === id);
      const current = target?.points[frame] ?? [];
      correct(id, current, [...current, [x, y, label]]);
    },
    [bridge, busy, playing, frame, correct, claimId],
  );

  const removePoint = useCallback(
    (index: number) => {
      const s = stateRef.current;
      const o = s.objects.find(x => x.id === s.activeId);
      if (o == null || busy || playing) {
        return;
      }
      const current = o.points[frame] ?? [];
      // deleting the last positive while negatives remain nudges too
      correct(o.id, current, current.filter((_, i) => i !== index));
    },
    [busy, playing, frame, correct],
  );

  const addObject = useCallback(() => {
    const s = stateRef.current;
    if (!canAddObject(s, OBJECT_LIMIT)) {
      return;
    }
    const id = claimId(s.objects);
    dispatch({type: 'add', id});
    bridge?.call('setActiveObject', {objectId: id}).catch(() => {});
  }, [bridge, claimId]);

  /** Rename an object (an empty name goes back to "Object N"). Metadata only: no track goes stale. */
  const renameObject = useCallback(
    (objectId: number, raw: string) => {
      const name = cleanObjectName(raw);
      dispatch({type: 'rename', id: objectId, name});
      bridge
        ?.call('renameObject', {objectId, name})
        .then(res => {
          if (!res.saved && !namesWarned.current) {
            namesWarned.current = true;
            setWarning("Names won't be saved until the backend is updated");
          }
        })
        .catch(error => setWarning(message(error)));
    },
    [bridge],
  );

  const selectObject = useCallback(
    (id: number | null) => {
      dispatch({type: 'select', id});
      setNudge(null);
      setHint(null);
      bridge?.call('setActiveObject', {objectId: id}).catch(() => {});
    },
    [bridge],
  );

  /** Start a job for the dirty objects. Jobs already running keep theirs. */
  const track = useCallback(async () => {
    if (bridge == null) {
      return;
    }
    await queue.current; // clicks first
    const ids = dirtyIds(stateRef.current);
    if (ids.length === 0) {
      return;
    }
    const key = nextJobKey.current++;
    const engine = stateRef.current.engine;
    dispatch({type: 'trackStarted', key, ids, engine});
    // the first SAM 3 job loads its model (about 30 s): show that it is loading
    setEngines(list => list.map(e => (e.name === engine && !e.loaded ? {...e, loading: true} : e)));
    try {
      const {outcome} = await bridge.call('track', {objectIds: ids, key, engine});
      setEngines(list => list.map(e => (e.name === engine ? {...e, loaded: outcome.ok || e.loaded, loading: false} : e)));
      if (outcome.ok) {
        dispatch({type: 'trackFinished', key, tracked: outcome.tracked, failed: outcome.failed});
      } else {
        dispatch({type: 'trackFailed', key, error: outcome.error});
      }
    } catch (error) {
      dispatch({type: 'trackFailed', key, error: message(error)});
    }
    await sync().catch(error => setWarning(message(error)));
  }, [bridge, sync]);

  /** Cancel one of this page's jobs, or (no key) every job of the session. */
  const cancelTrack = useCallback(
    async (key?: number) => {
      if (bridge == null) {
        return;
      }
      const jobs = stateRef.current.jobs.filter(j => key == null || j.key === key);
      jobs.forEach(j => dispatch({type: 'trackCanceling', key: j.key}));
      try {
        if (key == null) {
          await bridge.call('cancelTrack', {jobId: null});
        } else {
          await Promise.all(
            jobs.filter(j => j.jobId != null).map(j => bridge.call('cancelTrack', {jobId: j.jobId})),
          );
        }
      } catch (error) {
        setWarning(message(error));
      }
    },
    [bridge],
  );

  // Objects another tab is tracking: follow its progress, and repaint them
  // from the cache once the backend says they are done.
  const foreignIds = state.objects
    .filter(o => o.state === 'tracking' && !o.running)
    .map(o => o.id)
    .join(',');
  useEffect(() => {
    if (bridge == null || foreignIds === '') {
      setForeignJobs([]);
      return;
    }
    const watched = foreignIds.split(',').map(Number);
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        setForeignJobs(await bridge.call('trackJobs', {}));
        const objects = await bridge.call('objectTracks', {});
        if (stopped) {
          return;
        }
        dispatch({type: 'sync', objects});
        const done = watched.filter(id => objects.find(o => o.objectId === id)?.state !== 'tracking');
        if (done.length > 0) {
          await bridge.call('repaint', {objectIds: done});
        }
      } catch {
        // the next tick tries again
      }
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [bridge, foreignIds]);

  /** Clear one engine's track (the one on screen by default), or all with null. */
  const clearTrack = useCallback(
    (objectId: number, engine: string | null = stateRef.current.engine) => {
      if (bridge == null) {
        return;
      }
      serial(async () => {
        await bridge.call('clearTrack', {objectId, engine});
        dispatch({type: 'trackCleared', id: objectId, engine});
        await sync();
      });
    },
    [bridge, serial, sync],
  );

  /**
   * Mark frames start-end of an object absent (the object is not in the
   * shot), or clear them (state null). The frames go empty on screen at once;
   * the track goes stale, and a re-track skips them.
   */
  const setRange = useCallback(
    (objectId: number, start: number, end: number, rangeState: RangeState | null) => {
      if (bridge == null) {
        return;
      }
      const o = stateRef.current.objects.find(x => x.id === objectId);
      if (o == null) {
        return;
      }
      const [a, b] = start <= end ? [start, end] : [end, start];
      const before = o.ranges;
      dispatch({type: 'setRanges', id: objectId, ranges: paintRange(before, a, b, rangeState)});
      serial(async () => {
        let res;
        try {
          res = await bridge.call('setRange', {objectId, start: a, end: b, state: rangeState});
        } catch (error) {
          // the backend never took it: put the lane back as it was
          dispatch({type: 'setRanges', id: objectId, ranges: before});
          throw error;
        }
        dispatch({type: 'setRanges', id: objectId, ranges: normalizeRanges(res.ranges)});
        await sync();
      });
    },
    [bridge, serial, sync],
  );

  /**
   * "Gone for a while?": mark the object absent from `frameIndex` until the
   * frame before its next click after it (any click, a cleared seed too), or
   * to the clip's end. Goes through setRange, the one path for ranges, so it
   * syncs (and rolls back on failure) like any; overlapping an existing range
   * merges with it (paintRange / normalizeRanges).
   */
  const markAbsentUntilNextSeed = useCallback(
    (objectId: number, frameIndex: number) => {
      const o = stateRef.current.objects.find(x => x.id === objectId);
      if (o == null || meta.numFrames <= 0) {
        return;
      }
      const [start, end] = absentUntilNextSeed(seedFrames(o), frameIndex, meta.numFrames);
      setRange(objectId, start, end, ABSENT);
    },
    [meta.numFrames, setRange],
  );

  /** Track with, and show, another engine. */
  const setEngine = useCallback(
    (engine: string) => {
      if (bridge == null || engine === stateRef.current.engine) {
        return;
      }
      dispatch({type: 'setEngine', engine});
      writeJson(ENGINE_KEY, engine);
      setNudge(null);
      setHint(null);
      bridge.call('setEngine', {engine}).catch(error => setWarning(message(error)));
    },
    [bridge],
  );

  const sam3Available = engines.some(e => e.name === 'sam3' && e.available);

  /** The nudge's "Add a positive to trim": clicks add positives again (`addMode` sets the toggle). */
  const nudgeTrim = useCallback((addMode: () => void) => {
    addMode();
    setNudge(null);
  }, []);

  /** The nudge's "Switch to SAM 3": show SAM 3, and send it the refused clicks. */
  const nudgeSam3 = useCallback(() => {
    // the object may have been removed since the nudge: sending would re-create it
    const target = nudge == null ? undefined : stateRef.current.objects.find(o => o.id === nudge.objectId);
    if (nudge == null || !sam3Available || target == null) {
      setNudge(null);
      return;
    }
    // the nudge comes before the absent refusal, so it can stand on an absent
    // frame: SAM 3 would be refused there too, so say why and send nothing
    if (absentAt(target.ranges, nudge.frame)) {
      setNudge(null);
      setWarning(absentWarning(target, nudge.frame));
      return;
    }
    const points = refused.current;
    setEngine('sam3');
    setNudge(null);
    const plan = planClicks([], points, 'sam3');
    setHint(plan.kind === 'send' && plan.gone ? {kind: 'gone', objectId: nudge.objectId, frame: nudge.frame} : null);
    setPoints(nudge.objectId, nudge.frame, points, 'sam3');
  }, [nudge, sam3Available, setEngine, setPoints]);

  /**
   * The SAM 2 nudge's and the SAM 3 hint's "Gone for a while?", for the
   * object and frame they are about (state/corrections.ts goneSteps). From the
   * nudge, the frame's kept clicks are cleared first, through setPoints like
   * any cleared frame; both queue on `serial`, so the clear lands first.
   */
  const markGone = useCallback(() => {
    const target = nudge ?? hint;
    setNudge(null);
    setHint(null);
    const o = target == null ? undefined : stateRef.current.objects.find(x => x.id === target.objectId);
    if (target == null || o == null || meta.numFrames <= 0) {
      return;
    }
    for (const step of goneSteps(nudge != null ? 'nudge' : 'hint', seedFrames(o), target.frame, meta.numFrames)) {
      if (step.kind === 'clearFrame') {
        setPoints(o.id, step.frame, [], nudge?.engine);
      } else {
        setRange(o.id, step.start, step.end, ABSENT);
      }
    }
  }, [nudge, hint, meta.numFrames, setPoints, setRange]);

  /** The browser engine's model size and hole fill; its tracks made otherwise go stale. */
  const setLocalOptions = useCallback(
    (next: LocalOptions) => {
      if (bridge == null) {
        return;
      }
      serial(async () => {
        await bridge.call('setLocalOptions', next);
        setLocalOptionsState(next);
        writeJson(LOCAL_OPTIONS_KEY, next);
        await sync();
      });
    },
    [bridge, serial, sync],
  );

  // Per-object effects: each object keeps its own until the user changes it;
  // saved per video in this browser.
  const effectsKey = `sam-ui-studio:effects:${video.path}`;
  const [objectEffects, setObjectEffects] = useState<EffectMap>(() => parseEffectMap(readJson(effectsKey, {})));
  const [variantCounts, setVariantCounts] = useState<Record<string, number>>({});
  const idsKey = state.objects.map(o => o.id).join(',');
  useEffect(() => {
    // forget effects of removed objects, once the objects are known
    if (status === 'ready') {
      setObjectEffects(m => {
        const pruned = pruneEffects(m, idsKey === '' ? [] : idsKey.split(',').map(Number));
        return Object.keys(pruned).length === Object.keys(m).length ? m : pruned;
      });
      setFlags(m => {
        const pruned = pruneFlags(m, idsKey === '' ? [] : idsKey.split(',').map(Number));
        return Object.keys(pruned).length === Object.keys(m).length ? m : pruned;
      });
    }
  }, [idsKey, status]);
  useEffect(() => {
    writeJson(effectsKey, objectEffects);
    bridge?.call('setObjectEffects', {effects: objectEffects}).catch(error => setWarning(message(error)));
  }, [bridge, effectsKey, objectEffects]);
  useEffect(() => {
    if (bridge != null && meta.decoded) {
      // set up effects that waited for the decoded size, and learn their variants
      bridge.call('setObjectEffects', {effects: objectEffects}).catch(() => {});
      bridge
        .call('effectVariants', {names: HIGHLIGHT_NAMES})
        .then(setVariantCounts)
        .catch(() => {});
    }
    // once per decode
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, meta.decoded]);

  /** Give the selected object the effect `name` (again: its next variant). */
  const pickObjectEffect = useCallback(
    (name: string) => {
      const id = stateRef.current.activeId;
      if (id == null) {
        return;
      }
      setObjectEffects(m => pickEffect(m, id, name, variantCounts[name] ?? 1));
    },
    [variantCounts],
  );

  const [exportProgress, setExportProgress] = useState<number | null>(null);

  /** The model an export names: the backend's for its engines, the chosen export for the browser one. */
  const modelOf = useCallback(
    (engine: string) =>
      engine === BROWSER_ENGINE
        ? browserModelName(localOptions.quality, localOptions.fillHoleArea)
        : (engines.find(e => e.name === engine)?.model ?? 'unknown'),
    [engines, localOptions],
  );

  /**
   * A mask export (zip) of `ids` (default: every object with a track on the
   * engine on screen), each file named after its object.
   */
  const exportMasks = useCallback(
    async (kind: ExportKind, rows?: Array<{objectId: number; name?: string; prompt?: string; color?: string}>): Promise<Blob> => {
      if (bridge == null) {
        throw new Error('no session');
      }
      const s = stateRef.current;
      type Row = {objectId: number; name?: string; prompt?: string; color?: string};
      const chosen: Row[] =
        rows ?? s.objects.filter(o => o.state === 'tracked' || o.state === 'stale').map(o => ({objectId: o.id}));
      const objs = chosen
        .map(r => s.objects.find(o => o.id === r.objectId))
        .filter((o): o is (typeof s.objects)[number] => o != null);
      if (objs.length === 0) {
        throw new Error('No object has a track on this engine yet.');
      }
      const files = uniqueFileNames(
        objs.map(o => chosen.find(r => r.objectId === o.id)?.name ?? objectName(o)),
        i => objectName(objs[i]),
      );
      const objects: ExportedObject[] = objs.map((o, i) => {
        const row = chosen.find(r => r.objectId === o.id);
        return {
          objectId: o.id,
          label: objectName(o),
          name: files[i],
          state: o.state,
          prompt: row?.prompt ?? objectName(o),
          color: (row?.color ?? o.color).toLowerCase(),
          ranges: o.ranges,
        };
      });
      setExportProgress(0);
      try {
        const buffer = await bridge.call('exportMasks', {
          kind,
          objects,
          engine: s.engine,
          engineLabel: engineLabel(s.engine),
          model: modelOf(s.engine),
        });
        return new Blob([buffer], {type: 'application/zip'});
      } finally {
        setExportProgress(null);
      }
    },
    [bridge, modelOf],
  );
  /** Render the video with every object's own effect, as an MP4 file. */
  const exportVideo = useCallback(
    async (untouched: UntouchedMode): Promise<Blob> => {
      if (bridge == null) {
        throw new Error('no session');
      }
      setExportProgress(0);
      try {
        const effects = exportEffects(
          objectEffects,
          stateRef.current.objects.map(o => o.id),
          untouched,
        );
        const buffer = await bridge.call('exportVideo', {effects});
        return new Blob([buffer], {type: 'video/mp4'});
      } finally {
        setExportProgress(null);
      }
    },
    [bridge, objectEffects],
  );

  // Where SAM 2 and SAM 3 disagree, for objects both track with current
  // clicks: fetched again whenever that set, or any of its tracks, changes.
  const compare = comparableIds(state, DEFAULT_ENGINE, COMPARE_ENGINE);
  const compareKey = state.objects
    .filter(o => compare.includes(o.id))
    .map(o => `${o.id}:${o.engines[DEFAULT_ENGINE]?.nFrames}:${o.engines[COMPARE_ENGINE]?.nFrames}`)
    .join(',');
  useEffect(() => {
    if (bridge == null || compareKey === '') {
      setDisagreement(new Map());
      return;
    }
    let stale = false;
    const ids = compareKey.split(',').map(k => Number(k.split(':')[0]));
    bridge
      .call('disagreement', {a: DEFAULT_ENGINE, b: COMPARE_ENGINE, objectIds: ids})
      .then(res => {
        if (!stale) {
          setDisagreement(
            new Map(
              Object.entries(res.objects).map(([id, d]) => [Number(id), {flagged: d.flagged, meanIou: d.mean_iou}]),
            ),
          );
        }
      })
      .catch(error => setWarning(`could not compare engines: ${message(error)}`));
    return () => {
      stale = true;
    };
  }, [bridge, compareKey]);

  const removeObject = useCallback(
    (objectId: number) => {
      if (bridge == null) {
        return;
      }
      if (objectId === nudgeRef.current?.objectId) {
        setNudge(null); // its Switch to SAM 3 would send clicks for the removed object
      }
      setHint(null);
      serial(async () => {
        // Always ask the backend, clicked or not: a stored object can have no
        // seeds left (an undo, a cleared frame) and would come back on sync.
        // Removing an id it never stored is a no-op, so a new layer is fine too.
        await bridge.call('removeObject', {objectId});
        dispatch({type: 'removed', id: objectId});
        await sync();
      });
    },
    [bridge, serial, sync],
  );

  const startOver = useCallback(() => {
    if (bridge == null) {
      return;
    }
    setNudge(null);
    setHint(null);
    serial(async () => {
      await bridge.call('startOver', {});
      dispatch({type: 'reset'});
      await sync();
    });
  }, [bridge, serial, sync]);

  const seek = useCallback(
    (index: number) => {
      if (bridge == null || meta.numFrames === 0) {
        return;
      }
      bridge.goToFrame(Math.max(0, Math.min(meta.numFrames - 1, Math.round(index))));
    },
    [bridge, meta.numFrames],
  );

  const togglePlay = useCallback(() => {
    if (bridge == null) {
      return;
    }
    if (playing) {
      bridge.pause();
    } else {
      bridge.play();
    }
  }, [bridge, playing]);

  const dirty = useMemo(() => dirtyIds(state), [state]);

  /** Flag the current frame of the selected object for a correction, or unflag it. */
  const toggleFlag = useCallback(() => {
    const id = stateRef.current.activeId;
    if (id != null && meta.numFrames > 0) {
      setFlags(m => toggled(m, id, frame));
    }
  }, [frame, meta.numFrames]);

  // a stale track stays on screen, faded, until the re-track (corrected frames show at full strength)
  const staleKey = staleIds(state).join(',');
  useEffect(() => {
    bridge
      ?.call('setStaleObjects', {objectIds: staleKey === '' ? [] : staleKey.split(',').map(Number)})
      .catch(() => {});
  }, [bridge, staleKey]);

  return {
    bridge,
    state,
    status,
    statusError,
    frame,
    meta,
    playing,
    tracklets,
    repainting,
    pending,
    warning,
    foreignJobs,
    dirty,
    busy,
    canAdd: canAddObject(state, OBJECT_LIMIT) && !noEngine,
    engines,
    setEngine,
    sam3Available,
    nudge,
    hint,
    nudgeTrim,
    nudgeSam3,
    markGone,
    localOptions,
    setLocalOptions,
    localModel,
    disagreement,
    flags,
    toggleFlag,
    objectEffects,
    pickObjectEffect,
    variantCounts,
    exportVideo,
    exportMasks,
    modelOf,
    exportProgress,
    backend,
    webgpu,
    noEngine,
    dismissWarning: () => setWarning(null),
    start,
    addPoint,
    removePoint,
    addObject,
    renameObject,
    selectObject,
    track,
    cancelTrack,
    clearTrack,
    setRange,
    markAbsentUntilNextSeed,
    removeObject,
    startOver,
    seek,
    togglePlay,
  };
}

export type StudioSessionApi = ReturnType<typeof useStudioSession>;
