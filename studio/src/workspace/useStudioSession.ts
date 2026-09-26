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
import {closeSessionOnUnload, recordClose, recordOpen} from '~/lib/sessionClose';
import {readJson, writeJson} from '~/lib/storage';
import {API_ENDPOINT, OBJECT_LIMIT} from '~/config';
import {
  DEFAULT_ENGINE,
  NormPoint,
  canAddObject,
  comparableIds,
  dirtyIds,
  preferredEngine,
  hasSeeds,
  initialState,
  nextObjectId,
  reducer,
} from '~/state/objects';
import type {EngineInfo, RunningJob, TrackletSummary} from '~/worker/protocol';

/** Where two engines disagree on one object: frames under the IoU threshold. */
export type ObjectDisagreement = {flagged: number[]; meanIou: number | null};

const ENGINE_KEY = 'sam-ui-studio:engine';

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
};

export type SessionStatus = 'starting' | 'ready' | 'failed';

export type Metadata = {numFrames: number; fps: number; width: number; height: number; decoded: boolean};

function message(error: unknown): string {
  return explainGraphQLError(error instanceof Error ? error.message : String(error));
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
  const [disagreement, setDisagreement] = useState<Map<number, ObjectDisagreement>>(new Map());

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
      if (id != null) {
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
          dispatch({type: 'trackAttached', key: event.key, jobId: event.jobId, selected: event.selected});
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
      await bridge.call('init', {endpoint: API_ENDPOINT});
      const list = await bridge.call('engines', {}).catch(() => [] as EngineInfo[]);
      setEngines(list);
      // a remembered engine the backend cannot run (any more) falls back to the default
      const wanted = stateRef.current.engine;
      const usable = list.length === 0 || list.some(e => e.name === wanted && e.available);
      const engine = usable ? wanted : (list.find(e => e.default)?.name ?? DEFAULT_ENGINE);
      if (engine !== wanted) {
        dispatch({type: 'setEngine', engine});
      }
      await bridge.call('setEngine', {engine});
      const info = await bridge.call('startSession', {path: video.path});
      sessionIdRef.current = info.sessionId;
      dispatch({type: 'restore', objects: info.objects});
      setStatus('ready');
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
  }, [bridge, video.path, video.url]);

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
  const busy = repainting || status !== 'ready';

  const setPoints = useCallback(
    (objectId: number, frameIndex: number, points: NormPoint[]) => {
      if (bridge == null) {
        return;
      }
      dispatch({type: 'setPoints', id: objectId, frame: frameIndex, points});
      serial(async () => {
        await bridge.call('setPoints', {objectId, frameIndex, points});
        await sync();
      });
    },
    [bridge, serial, sync],
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
        id = nextObjectId(s.objects);
        dispatch({type: 'add', id});
        bridge.call('setActiveObject', {objectId: id}).catch(() => {});
      }
      const current = s.objects.find(o => o.id === id)?.points[frame] ?? [];
      setPoints(id, frame, [...current, [x, y, label]]);
    },
    [bridge, busy, playing, frame, setPoints],
  );

  const removePoint = useCallback(
    (index: number) => {
      const s = stateRef.current;
      const o = s.objects.find(x => x.id === s.activeId);
      if (o == null || busy || playing) {
        return;
      }
      const current = o.points[frame] ?? [];
      setPoints(o.id, frame, current.filter((_, i) => i !== index));
    },
    [busy, playing, frame, setPoints],
  );

  const addObject = useCallback(() => {
    const s = stateRef.current;
    if (!canAddObject(s, OBJECT_LIMIT)) {
      return;
    }
    const id = nextObjectId(s.objects);
    dispatch({type: 'add', id});
    bridge?.call('setActiveObject', {objectId: id}).catch(() => {});
  }, [bridge]);

  const selectObject = useCallback(
    (id: number | null) => {
      dispatch({type: 'select', id});
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

  /** Track with, and show, another engine. */
  const setEngine = useCallback(
    (engine: string) => {
      if (bridge == null || engine === stateRef.current.engine) {
        return;
      }
      dispatch({type: 'setEngine', engine});
      writeJson(ENGINE_KEY, engine);
      bridge.call('setEngine', {engine}).catch(error => setWarning(message(error)));
    },
    [bridge],
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
      const o = stateRef.current.objects.find(x => x.id === objectId);
      serial(async () => {
        // an object never clicked exists only here
        if (o != null && hasSeeds(o)) {
          await bridge.call('removeObject', {objectId});
        }
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
    canAdd: canAddObject(state, OBJECT_LIMIT),
    engines,
    setEngine,
    disagreement,
    objectEffects,
    pickObjectEffect,
    variantCounts,
    exportVideo,
    exportProgress,
    dismissWarning: () => setWarning(null),
    start,
    addPoint,
    removePoint,
    addObject,
    selectObject,
    track,
    cancelTrack,
    clearTrack,
    removeObject,
    startOver,
    seek,
    togglePlay,
  };
}

export type StudioSessionApi = ReturnType<typeof useStudioSession>;
