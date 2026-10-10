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
import {type AgentChange, type AgentTrackReply, agentBridge, asAgentChange, asAgentGoto, asAgentTrack, asJobOpen, jobsBridge} from '~/lib/desktop';
import {type AgentEntry, appendActivity, viewReport} from '~/state/agentActivity';
import {explainGraphQLError} from '~/lib/errors';
import {
  EffectMap,
  UntouchedMode,
  exportEffects,
  parseEffectMap,
  pickEffect,
  pruneEffects,
} from '~/state/objectEffects';
import {parseObjectColors} from '~/state/objectColors';
import {isOffline} from '~/lib/mode';
import {webGpuAvailable} from '~/lib/webgpu';
import {requestPersistentStorage} from '~/lib/persist';
import {closeSessionOnUnload, recordClose, recordOpen} from '~/lib/sessionClose';
import {readJson, writeJson} from '~/lib/storage';
import {API_ENDPOINT, OBJECT_LIMIT} from '~/config';
import type {LocalModelStatus, LocalOptions} from '~/local/LocalEngine';
import {browserModelName, parseQuality} from '~/local/sam2/config';
import {BROWSER_ENGINE, engineLabel, pickerEngines, textPrompts} from '~/state/engines';
import {goneSteps, isNeedsPositive, planClicks, planRemoval, refusedAsAbsent, type Hint, type Nudge} from '~/state/corrections';
import {cleanObjectName, objectName, uniqueFileNames} from '~/state/fileNames';
import {type ExportedObject, type ExportKind, groupExport} from '~/state/maskExport';
import {
  type LayoutAction,
  type GroupPatch,
  hiddenIds,
  newGroupId,
  nextGroupColor,
} from '~/state/layout';
import {CLOSED_GATE, type SaveGate, saveStep} from '~/state/layoutSync';
import {
  DEFAULT_ENGINE,
  NormPoint,
  canAddObject,
  clearTarget,
  comparableIds,
  dirtyIds,
  groupDirtyIds,
  orderedObjects,
  preferredEngine,
  initialState,
  isTracking,
  nextObjectId,
  reducer,
  seedFrames,
  releasedOn,
  staleIds,
} from '~/state/objects';
import {moveTargets, undoBlock} from '~/state/history';
import {type QueueEntry, type ReviewQueue, jobLanding, stepQueue} from '~/state/audit';
import {clearFlag, parseFlagMap, pruneFlags, toggleFlag as toggled, type FlagMap} from '~/state/flags';
import {
  ABSENT,
  CANDIDATE,
  type Layers,
  type Mark,
  type PaintOptions,
  PRESENT,
  type RangeState,
  absentAt,
  absentUntilNextSeed,
  normalizeMarks,
  normalizeRanges,
  paintTimeline,
} from '~/state/ranges';
import type {JobOutcome} from '~/api/trackStream';
import type {DiscoverTextResult, EngineInfo, RunningJob, TextPromptResult, TrackletSummary} from '~/worker/protocol';

// how long after this page's own job ends the follow path keeps quiet about its objects
const TOLD_QUIET_MS = 10_000;

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

/** Where a stop (by object and frame) sits in the ranked queue; null when it is not in it. */
function queueIndex(q: ReadonlyArray<QueueEntry>, at: {objectId: number; frame: number} | null): number | null {
  const i = at == null ? -1 : q.findIndex(e => e.objectId === at.objectId && e.frame === at.frame);
  return i < 0 ? null : i;
}

export type SessionStatus = 'starting' | 'ready' | 'failed';

/**
 * A track run for someone else (an agent, issue #73): exactly these ids (not
 * only the dirty ones), on this engine, and who hears the job id once the
 * backend gave it.
 */
type TrackOptions = {
  ids?: number[];
  engine?: string;
  onStarted?: (job: {jobId: string | null; selected: number[]; bounded: number[]}) => void;
};

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
  const [rawState, dispatch] = useReducer(reducer, initialState, s => ({
    ...s,
    engine: readJson<string>(ENGINE_KEY, s.engine),
  }));
  const colorsKey = `sam-ui-studio:mask-colors:${video.path}`;
  const [objectColors, setObjectColors] = useState(() => parseObjectColors(readJson(colorsKey, {})));
  const state = useMemo(() => ({...rawState, objects: rawState.objects.map(o => objectColors[o.id] ? {...o, color: objectColors[o.id]} : o)}), [rawState, objectColors]);
  const setObjectColor = useCallback((id: number, color: string | null) => {
    const valid = color == null ? null : parseObjectColors({[id]: color})[id];
    if (color != null && valid == null) return;
    setObjectColors(current => {
      const next = {...current};
      if (valid == null) delete next[id]; else next[id] = valid;
      return next;
    });
  }, []);
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
  useEffect(() => {
    writeJson(colorsKey, objectColors);
    bridge?.call('setObjectColors', {colors: objectColors}).catch(error => setWarning(message(error)));
  }, [bridge, colorsKey, objectColors]);
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
  /** The stored layout has been read: from then on, every change of it is saved. */
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const localOptionsRef = useRef(localOptions);
  localOptionsRef.current = localOptions;
  // one past the highest object id ever used on this video, so a deleted
  // object's number is never handed out again (remembered per browser)
  const nextIdKey = `sam-ui-studio:next-object:${video.path}`;
  const idFloor = useRef<number>(readJson<number>(nextIdKey, 0));
  const namesWarned = useRef(false);
  const layoutWarned = useRef(false);
  /**
   * Whether layout changes are saved: only after a load that read the stored
   * layout. A failed load must never let a save replace the stored groups.
   */
  const layoutGate = useRef<SaveGate>(CLOSED_GATE);
  /** Why saves are closed, for the one warning a change gets. */
  const layoutClosed = useRef("The object order and groups won't be saved until the backend is updated");
  const layoutQueue = useRef<Promise<unknown>>(Promise.resolve());

  const stateRef = useRef(state);
  stateRef.current = state;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const nextJobKey = useRef(1);
  /** A job's key -> who waits for its job id (an agent's track, which studio runs). */
  const startedWaits = useRef(new Map<number, NonNullable<TrackOptions['onStarted']>>());
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
          startedWaits.current.get(event.key)?.({jobId: event.jobId, selected: event.selected, bounded: event.bounded ?? []});
          startedWaits.current.delete(event.key);
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
      // the order and groups: metadata too, and an older backend has none (creation order)
      bridge
        .call('objectLayout', {})
        .then(res => {
          dispatch({type: 'setLayout', layout: res.layout});
          // the layout as loaded is the baseline; saving opens only if the stored one was read
          layoutGate.current = {savable: res.supported, baseline: null};
        })
        .catch(error => {
          layoutGate.current = CLOSED_GATE;
          layoutClosed.current = `could not load the object order and groups, so changes to them won't be saved: ${message(error)}`;
          setWarning(layoutClosed.current);
          layoutWarned.current = true;
        })
        .finally(() => setLayoutLoaded(true));
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
  const textSupport = useMemo(() => textPrompts(engines, state.engine), [engines, state.engine]);

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

  /**
   * Seed the current frame of an object from a phrase, on the engine on
   * screen (only SAM 3 reads text: textSupport says so), or on `engine`;
   * null asks the backend for the first engine that reads text. Its best
   * match replaces the frame's clicks. Resolves with what was found, or null
   * when the call failed (the warning says why).
   */
  const textPrompt = useCallback(
    (objectId: number, text: string, engine: string | null = stateRef.current.engine): Promise<TextPromptResult | null> => {
      if (bridge == null) {
        return Promise.resolve(null);
      }
      const at = frame;
      let result: TextPromptResult | null = null;
      return serial(async () => {
        result = await bridge.call('textPrompt', {objectId, frameIndex: at, text, engine});
        if (result.matched) {
          dispatch({type: 'setText', id: objectId, frame: at, text: result.text});
          setFlags(m => clearFlag(m, objectId, at));
        }
        await sync();
      }).then(() => result);
    },
    [bridge, serial, sync, frame],
  );

  /**
   * EXPERIMENTAL: look for a phrase across the whole clip (SAM 3) and mark
   * each appearance as a candidate range of the object, then go to the first
   * if the object is still selected and the playhead has not moved since.
   * An object deleted during the scan stays deleted. Not queued behind
   * clicks: the scan takes the model lock per frame it checks, so clicks
   * keep working. Resolves with what was found, or null when the call failed
   * (the warning says why).
   */
  const discoverText = useCallback(
    async (objectId: number, text: string): Promise<DiscoverTextResult | null> => {
      if (bridge == null) {
        return null;
      }
      const engine = stateRef.current.engine;
      const startFrame = frameRef.current;
      try {
        const result = await bridge.call('discoverText', {objectId, text, engine});
        const s = stateRef.current;
        if (result.object == null || !s.objects.some(o => o.id === objectId)) {
          return result;
        }
        dispatch({type: 'objectChanged', object: result.object});
        const first = result.intervals[0];
        if (first != null && s.activeId === objectId && frameRef.current === startFrame) {
          bridge.goToFrame(first.start);
        }
        return result;
      } catch (error) {
        setWarning(message(error));
        return null;
      }
    },
    [bridge],
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
      const rest = current.filter((_, i) => i !== index);
      const plan = planRemoval(rest, o.texts[frame]);
      if (plan.kind === 'restoreText') {
        // the last refinement of a text frame goes: back to the text's mask,
        // on the first engine that reads text, whatever is on screen
        void textPrompt(o.id, plan.text, plan.engine);
        return;
      }
      // deleting the last positive while negatives remain nudges too
      correct(o.id, current, rest);
    },
    [busy, playing, frame, correct, textPrompt],
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

  // the desktop app's job notifications: studio says a job ended, main decides (desktop/src/job-notify.js)
  const jobs = useMemo(jobsBridge, []);
  const tellJobDone = useCallback(
    (objectIds: number[], ok: boolean, engine: string) => {
      const first = stateRef.current.objects.find(o => o.id === objectIds[0]);
      jobs?.done({kind: 'track', ok, engine, objectIds, name: first != null ? objectName(first) : ''});
    },
    [jobs],
  );
  // Ids of this page's ended jobs, already told (or kept quiet, for a cancel).
  // The backend can hold them a moment after the job ends, so the follow path
  // below may still see them tracking: it repaints them but says nothing.
  // ponytail: by time, not by job: a job someone else (an agent) starts on the
  // same object within TOLD_QUIET_MS of ours ending goes untold
  const toldHere = useRef(new Map<number, number>()); // id -> when this page told it

  /**
   * Start a job for the dirty objects (`pick`: of them, the ones it keeps).
   * Jobs already running keep theirs.
   */
  const runTrack = useCallback(async (pick: (ids: number[]) => number[] = ids => ids, opts: TrackOptions = {}): Promise<JobOutcome | null> => {
    if (bridge == null) {
      return null;
    }
    await queue.current; // clicks first
    const ids = opts.ids ?? pick(dirtyIds(stateRef.current));
    if (ids.length === 0) {
      return null;
    }
    const key = nextJobKey.current++;
    const engine = opts.engine ?? stateRef.current.engine;
    if (opts.onStarted != null) {
      startedWaits.current.set(key, opts.onStarted);
    }
    ids.forEach(id => toldHere.current.delete(id));
    dispatch({type: 'trackStarted', key, ids, engine});
    // the first SAM 3 job loads its model (about 30 s): show that it is loading
    setEngines(list => list.map(e => (e.name === engine && !e.loaded ? {...e, loading: true} : e)));
    // read before trackFinished/trackFailed drops the job: the ids the backend
    // claimed (trackAttached), and whether it was canceled here (no news)
    const tell = (ok: boolean) => {
      const job = stateRef.current.jobs.find(j => j.key === key);
      const held = job?.ids ?? ids;
      held.forEach(id => toldHere.current.set(id, Date.now()));
      if (!job?.canceling && held.length > 0) {
        tellJobDone(held, ok, engine);
      }
    };
    let result: JobOutcome;
    try {
      const {outcome} = await bridge.call('track', {objectIds: ids, key, engine});
      result = outcome;
      setEngines(list => list.map(e => (e.name === engine ? {...e, loaded: outcome.ok || e.loaded, loading: false} : e)));
      tell(outcome.ok && Object.keys(outcome.failed).length === 0); // one object failing is a failed job
      if (outcome.ok) {
        dispatch({type: 'trackFinished', key, tracked: outcome.tracked, failed: outcome.failed});
      } else {
        dispatch({type: 'trackFailed', key, error: outcome.error});
      }
    } catch (error) {
      result = {ok: false, error: message(error), objects: ids};
      tell(false);
      dispatch({type: 'trackFailed', key, error: message(error)});
    }
    startedWaits.current.delete(key);
    await sync().catch(error => setWarning(message(error)));
    return result;
  }, [bridge, sync, tellJobDone]);

  /** Start a job for the dirty objects. Jobs already running keep theirs. */
  const track = useCallback(() => runTrack(), [runTrack]);

  /** A group's Track: only its stale or untracked members, through the same job path as Track. */
  const trackGroup = useCallback(
    (groupId: string) => runTrack(() => groupDirtyIds(stateRef.current, groupId)),
    [runTrack],
  );

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
    const told = new Set<number>();
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        setForeignJobs(await bridge.call('trackJobs', {}));
        const objects = await bridge.call('objectTracks', {});
        if (stopped) {
          return;
        }
        dispatch({type: 'sync', objects});
        const engine = stateRef.current.engine;
        const done = releasedOn(objects, watched, engine).ids;
        // each id once, and never one this page's own job already told
        const news = releasedOn(objects, watched.filter(id => !told.has(id) && !(Date.now() - (toldHere.current.get(id) ?? -Infinity) < TOLD_QUIET_MS)), engine);
        done.forEach(id => {
          told.add(id);
          toldHere.current.delete(id);
        });
        if (news.ids.length > 0) {
          // ponytail: the other job's outcome is not kept, so "tracked" stands for ok (a canceled one reads as failed)
          tellJobDone(news.ids, news.ok, engine);
        }
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
  }, [bridge, foreignIds, tellJobDone]);

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

  /** Clear the tracks of a group's members, each as its own Clear track button would. */
  const clearGroupTracks = useCallback(
    (groupId: string) => {
      const s = stateRef.current;
      const members = s.layout.groups.find(g => g.id === groupId)?.members ?? [];
      for (const id of members) {
        const o = s.objects.find(x => x.id === id);
        const target = o != null ? clearTarget(o, s.engine) : null;
        if (target != null) {
          clearTrack(id, target.engine);
        }
      }
    },
    [clearTrack],
  );

  // -- the object layout (issue #21): order and groups, metadata only --------------

  /** A reorder or regroup; saved, never a seed change. */
  const layoutAction = useCallback((action: LayoutAction) => dispatch({type: 'layout', action}), []);

  /** A new group: holding the selected object, where it is, or empty at the end. */
  const addGroup = useCallback(() => {
    const s = stateRef.current;
    const id = newGroupId(s.layout);
    const n = s.layout.groups.length + 1;
    dispatch({
      type: 'layout',
      action: {
        type: 'addGroup',
        id,
        name: `Group ${n}`,
        color: nextGroupColor(s.layout),
        members: s.activeId != null ? [s.activeId] : [],
      },
    });
    return id;
  }, []);

  const updateGroup = useCallback(
    (groupId: string, patch: GroupPatch) => dispatch({type: 'layout', action: {type: 'updateGroup', groupId, patch}}),
    [],
  );

  // every change of the layout is saved, one write at a time, the latest last
  useEffect(() => {
    if (bridge == null || !layoutLoaded || status !== 'ready') {
      return;
    }
    const step = saveStep(layoutGate.current, JSON.stringify(state.layout));
    layoutGate.current = step.gate;
    if (step.blocked && !layoutWarned.current) {
      layoutWarned.current = true;
      setWarning(layoutClosed.current);
    }
    if (!step.save) {
      return;
    }
    const layout = state.layout;
    layoutQueue.current = layoutQueue.current
      .then(() => bridge.call('setObjectLayout', {layout}))
      .then(res => {
        if (!res.saved && !layoutWarned.current) {
          layoutWarned.current = true;
          setWarning("The object order and groups won't be saved until the backend is updated");
        }
      })
      .catch(error => setWarning(`could not save the object order and groups: ${message(error)}`));
  }, [bridge, layoutLoaded, status, state.layout]);

  // a hidden group's members stay off the preview
  const hiddenKey = hiddenIds(state.layout).join(',');
  useEffect(() => {
    bridge
      ?.call('setHiddenObjects', {objectIds: hiddenKey === '' ? [] : hiddenKey.split(',').map(Number)})
      .catch(() => {});
  }, [bridge, hiddenKey]);

  /**
   * Set frames start-end of an object to a range state (state/ranges.ts), or
   * clear them (state null: every state, or those in opts.clear). Absent
   * frames go empty on screen at once, the track goes stale, and a re-track
   * skips them. Present and candidate ranges are annotations: no mask
   * changes and no track goes stale.
   */
  const setRange = useCallback(
    (objectId: number, start: number, end: number, rangeState: RangeState | null, opts: PaintOptions = {}) => {
      if (bridge == null) {
        return;
      }
      const o = stateRef.current.objects.find(x => x.id === objectId);
      if (o == null) {
        return;
      }
      const [a, b] = start <= end ? [start, end] : [end, start];
      const before = {ranges: o.ranges, marks: o.marks};
      let next: Layers;
      try {
        next = paintTimeline(before, a, b, rangeState, opts);
      } catch (error) {
        setWarning(message(error));
        return;
      }
      dispatch({type: 'setRanges', id: objectId, ...next});
      serial(async () => {
        let res;
        try {
          res = await bridge.call('setRange', {objectId, start: a, end: b, state: rangeState, ...opts, clear: opts.clear ? [...opts.clear] : undefined});
        } catch (error) {
          // the backend never took it: put the lane back as it was
          dispatch({type: 'setRanges', id: objectId, ...before});
          throw error;
        }
        dispatch({type: 'setRanges', id: objectId, ranges: normalizeRanges(res.ranges), marks: normalizeMarks(res.ranges)});
        await sync();
      });
    },
    [bridge, serial, sync],
  );

  /** A candidate confirmed: the object is there (present) or not in the shot (absent, a seed change). */
  const confirmCandidate = useCallback(
    (objectId: number, c: Mark, as: typeof PRESENT | typeof ABSENT) => setRange(objectId, c.start, c.end, as),
    [setRange],
  );

  /** A candidate rejected: its frames go back to unknown (only the candidate layer is cleared). */
  const rejectCandidate = useCallback(
    (objectId: number, c: Mark) => setRange(objectId, c.start, c.end, null, {clear: [CANDIDATE]}),
    [setRange],
  );

  /** Write candidate ranges in bulk (for a discovery job); `replace` drops the old ones. */
  const writeObjectCandidates = useCallback(
    (objectId: number, candidates: Array<{start: number; end: number; source: string; score?: number | null}>, replace = false) =>
      serial(async () => {
        if (bridge == null) {
          return;
        }
        const res = await bridge.call('writeCandidates', {objectId, candidates, replace});
        dispatch({type: 'objectChanged', object: res});
      }),
    [bridge, serial],
  );

  /**
   * Undo (or redo) the selected object's last seed change. A kept track of the
   * clicks it goes back to shows at once, tracked, with no job; without one the
   * object is stale, as after any click. Refused while a job holds the object.
   */
  const stepSeeds = useCallback(
    (which: 'undo' | 'redo', objectId: number | null = stateRef.current.activeId) => {
      if (bridge == null || busy) {
        return;
      }
      const o = stateRef.current.objects.find(x => x.id === objectId);
      const why = undoBlock(o, which);
      // a click still on its way has not reached the history yet: let the backend say
      if (why != null && (o == null || isTracking(o) || pending === 0)) {
        setWarning(why);
        return;
      }
      serial(async () => {
        const res = await bridge.call(which, {objectId: o!.id});
        dispatch({type: 'objectChanged', object: res});
        await sync();
      });
    },
    [bridge, busy, pending, serial, sync],
  );

  /** Go back to one of an object's kept versions (an undoable seed change). */
  const restoreVersion = useCallback(
    (objectId: number, key: string, engine: string) => {
      if (bridge == null || busy) {
        return;
      }
      serial(async () => {
        const res = await bridge.call('restoreVersion', {objectId, key, engine});
        dispatch({type: 'objectChanged', object: res});
        await sync();
      });
    },
    [bridge, busy, serial, sync],
  );

  /** Move the selected object's clicks on this frame to another object: one undo step each. */
  const moveClicks = useCallback(
    (toId: number) => {
      const s = stateRef.current;
      const fromId = s.activeId;
      if (bridge == null || busy || fromId == null) {
        return;
      }
      const target = moveTargets(s, fromId, frame).find(t => t.id === toId);
      if (target == null || target.blocked != null) {
        setWarning(target?.blocked != null ? `Cannot move the clicks there: that object is ${target.blocked}` : 'No clicks to move on this frame');
        return;
      }
      serial(async () => {
        // the engine on screen, as setPoints sends: SAM 3 takes a frame of negatives alone
        const res = await bridge.call('moveClicks', {frameIndex: frame, fromId, toId, engine: stateRef.current.engine});
        for (const o of res) {
          dispatch({type: 'objectChanged', object: o});
        }
        await sync();
      });
    },
    [bridge, busy, frame, serial, sync],
  );

  /**
   * "Gone for a while?": mark the object absent from `frameIndex` until the
   * frame before its next click after it (any click, a cleared seed too), or
   * to the clip's end. Goes through setRange, the one path for ranges, so it
   * syncs (and rolls back on failure) like any; overlapping an existing range
   * merges with it, and a candidate under it stays, hidden (paintTimeline).
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

  /** Give every member of a group the effect `name` (again: the next variant, for all of them). */
  const setGroupEffect = useCallback(
    (groupId: string, name: string) => {
      const members = stateRef.current.layout.groups.find(g => g.id === groupId)?.members ?? [];
      if (members.length === 0) {
        return;
      }
      setObjectEffects(m => {
        const effect = pickEffect(m, members[0], name, variantCounts[name] ?? 1)[members[0]];
        return {...m, ...Object.fromEntries(members.map(id => [id, effect]))};
      });
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
    async (
      kind: ExportKind,
      rows?: Array<{objectId: number; name?: string; prompt?: string; color?: string}>,
      union = false,
    ): Promise<Blob> => {
      if (bridge == null) {
        throw new Error('no session');
      }
      const s = stateRef.current;
      type Row = {objectId: number; name?: string; prompt?: string; color?: string};
      const chosen: Row[] =
        rows ?? s.objects.filter(o => o.state === 'tracked' || o.state === 'stale').map(o => ({objectId: o.id}));
      // in list order: names made unique in that order, and the files follow it
      const wanted = new Set(chosen.map(r => r.objectId));
      const objs = orderedObjects(s).filter(o => wanted.has(o.id));
      if (objs.length === 0) {
        throw new Error('No object has a track on this engine yet.');
      }
      const files = uniqueFileNames(
        objs.map(o => chosen.find(r => r.objectId === o.id)?.name ?? objectName(o)),
        i => objectName(objs[i]),
      );
      const exported: ExportedObject[] = objs.map((o, i) => {
        const row = chosen.find(r => r.objectId === o.id);
        return {
          objectId: o.id,
          label: objectName(o),
          name: files[i],
          state: o.state,
          prompt: row?.prompt ?? objectName(o),
          color: (row?.color ?? o.color).toLowerCase(),
          ranges: o.ranges,
          marks: o.marks,
        };
      });
      const {objects, groups} = groupExport(kind, exported, s.layout);
      setExportProgress(0);
      try {
        const buffer = await bridge.call('exportMasks', {
          kind,
          objects,
          engine: s.engine,
          engineLabel: engineLabel(s.engine),
          model: modelOf(s.engine),
          groups,
          union,
          review: kind === 'folder' && reviewRef.current?.engine === s.engine ? reviewRef.current.queue : undefined,
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

  // -- the audit queue (draft 7): a few frames worth a look, instead of every frame --------

  const [review, setReview] = useState<ReviewQueue | null>(null);
  /** The stop last stepped to or picked, by object and frame. */
  const [reviewAt, setReviewAt] = useState<{objectId: number; frame: number} | null>(null);
  const [reviewTick, setReviewTick] = useState(0);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const reviewWarned = useRef(false);
  // built again whenever a track, a click, a range, a flag or the engine changes
  const reviewKey = JSON.stringify([
    state.engine,
    state.jobs.map(j => j.key),
    state.objects.map(o => [
      o.id,
      o.state,
      o.engines,
      Object.entries(o.points).map(([f, p]) => `${f}:${p.length}`),
      o.ranges,
      o.marks,
    ]),
    flags,
    reviewTick,
  ]);
  useEffect(() => {
    if (bridge == null || status !== 'ready') {
      return;
    }
    let stale = false;
    const s = stateRef.current;
    const timer = setTimeout(() => {
      bridge
        .call('reviewQueue', {
          engine: s.engine,
          flags,
          candidates: Object.fromEntries(s.objects.map(o => [o.id, o.marks.filter(m => m.state === CANDIDATE)])),
        })
        .then(q => {
          if (!stale) {
            setReview(q);
          }
        })
        .catch(error => {
          if (!stale && !reviewWarned.current) {
            reviewWarned.current = true;
            setWarning(`could not build the review queue: ${message(error)}`);
          }
        });
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // reviewKey stands for every input the queue reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, status, reviewKey]);

  /** Show one stop: its object selected, its frame on screen. */
  const goToStop = useCallback(
    (e: Pick<QueueEntry, 'objectId' | 'frame'>) => {
      setReviewAt({objectId: e.objectId, frame: e.frame});
      dispatch({type: 'select', id: e.objectId});
      bridge?.call('setActiveObject', {objectId: e.objectId}).catch(() => {});
      if (bridge != null && meta.numFrames > 0) {
        bridge.goToFrame(Math.max(0, Math.min(meta.numFrames - 1, e.frame)));
      }
    },
    [bridge, meta.numFrames],
  );

  // a clicked job notification: that job's first unreviewed stop, else where its track starts
  // ponytail: ids only, so a click after switching videos lands on the same ids in this one; send the video along if that bites
  useEffect(
    () =>
      jobs?.onOpen(job => {
        const open = asJobOpen(job);
        // ponytail: the queue on screen is for the engine on screen; a job on another lands on its track start
        const queue = open?.engine === stateRef.current.engine ? (reviewRef.current?.queue ?? []) : [];
        const at =
          open &&
          jobLanding(queue, open.objectIds, id => {
            const o = stateRef.current.objects.find(x => x.id === id);
            return o == null ? undefined : (seedFrames(o)[0] ?? 0);
          });
        if (at != null) {
          goToStop(at);
        }
      }),
    [jobs, goToStop],
  );

  /** The next (or previous) stop in rank order, from the one last shown. */
  const stepReview = useCallback(
    (dir: 1 | -1) => {
      const q = reviewRef.current?.queue ?? [];
      const i = stepQueue(q, queueIndex(q, reviewAt), dir);
      if (i != null) {
        goToStop(q[i]);
      }
    },
    [reviewAt, goToStop],
  );

  /** The stop on screen: the one last shown while its frame is within it, else one peaking here on the selected object. */
  const stops = review?.queue ?? [];
  const shownStop = stops[queueIndex(stops, reviewAt) ?? -1];
  const currentStop =
    shownStop != null && shownStop.objectId === state.activeId && shownStop.start <= frame && frame <= shownStop.end
      ? shownStop
      : (stops.find(e => e.objectId === state.activeId && e.frame === frame) ?? null);

  /**
   * "Looks right" on a stop (reviewed false: open it again). With `advance`
   * (the stop on screen: Y, the transport's button) it moves on to the next
   * stop not yet reviewed, as a candidate's decision does; marking another
   * from the list leaves the playhead alone.
   */
  const markReviewed = useCallback(
    (e: QueueEntry, reviewed = true, advance = false) => {
      if (bridge == null) {
        return;
      }
      const q = reviewRef.current?.queue ?? [];
      setReview(r => (r == null ? r : {...r, queue: r.queue.map(x => (x === e || (x.objectId === e.objectId && x.frame === e.frame) ? {...x, reviewed} : x))}));
      if (reviewed && advance) {
        const i = queueIndex(q, {objectId: e.objectId, frame: e.frame});
        const marked = q.map(x => (x.objectId === e.objectId && x.frame === e.frame ? {...x, reviewed: true} : x));
        const next = stepQueue(marked, i, 1, true);
        if (next != null) {
          goToStop(marked[next]);
        }
      }
      bridge
        .call('setReviewed', {
          objectId: e.objectId,
          frame: e.frame,
          engine: stateRef.current.engine,
          reviewed,
          span: [e.start, e.end],
          reasons: e.reasons.map(r => r.kind),
        })
        .catch(error => setWarning(`could not save the review: ${message(error)}`))
        .finally(() => setReviewTick(t => t + 1));
    },
    [bridge, goToStop],
  );

  // -- agents (the desktop app's MCP, issue #73) ------------------------------------------
  // Each change an agent makes on this video shows here as it lands: changed
  // objects are re-read through `serial`, after any clicks of the person's
  // still on their way, and a list keeps what was done. The person's view goes
  // the other way, for sam_studio state. A browser has no bridge: none of it runs.

  const agent = useMemo(agentBridge, []);
  const [agentActivity, setAgentActivity] = useState<AgentEntry[]>([]);
  /** Track jobs an agent started on this video: their chips say "Agent". */
  const [agentJobIds, setAgentJobIds] = useState<ReadonlySet<string>>(() => new Set());
  /** The objects of the refresh waiting in `serial`, which later changes join. */
  const refreshing = useRef<Set<number> | null>(null);

  const refreshAgentObjects = useCallback(
    (ids: number[]) => {
      if (bridge == null) {
        return;
      }
      if (refreshing.current != null) {
        ids.forEach(id => refreshing.current!.add(id));
        return;
      }
      const wanted = new Set(ids);
      refreshing.current = wanted;
      serial(async () => {
        refreshing.current = null; // a change from here on waits for the next refresh
        const objects = await bridge.call('refreshObjects', {objectIds: [...wanted]});
        dispatch({type: 'sync', objects});
      });
    },
    [bridge, serial],
  );

  useEffect(
    () =>
      agent?.onChanged(raw => {
        const c = asAgentChange(raw);
        if (c == null || c.videoId !== video.path || status !== 'ready') {
          return;
        }
        setAgentActivity(list => appendActivity(list, c, stateRef.current.activeId));
        switch (c.kind) {
          case 'track_start':
            if (c.jobId != null) {
              const jobId = c.jobId;
              setAgentJobIds(s => new Set(s).add(jobId));
            }
            void serial(sync); // the objects read as tracking: the follow path takes it from here
            break;
          case 'track_cancel':
            void serial(sync);
            break;
          case 'review':
            setReviewTick(t => t + 1);
            break;
          case 'track_done':
          case 'export':
            break; // the follow path repaints a finished track; an export changes nothing here
          default:
            refreshAgentObjects(c.objectIds);
        }
      }),
    [agent, video.path, status, serial, sync, refreshAgentObjects],
  );

  /** Go to what an agent changed: its layer selected and its frame on screen. */
  const goToAgentChange = useCallback(
    (e: AgentEntry) => {
      const id = e.change.objectIds.find(x => stateRef.current.objects.some(o => o.id === x));
      if (id != null) {
        selectObject(id);
      }
      if (bridge != null && e.change.frame != null && meta.numFrames > 0) {
        bridge.goToFrame(Math.max(0, Math.min(meta.numFrames - 1, e.change.frame)));
      }
    },
    [bridge, meta.numFrames, selectObject],
  );

  // sam_studio goto: an agent points at a frame or layer. Studio moves only
  // when the person is not playing and has not scrubbed or picked a layer in
  // the last 2 s (moves the agent made itself don't count), and says so.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const lastTouch = useRef(0);
  const agentMovedAt = useRef(-Infinity);
  useEffect(() => {
    if (Date.now() - agentMovedAt.current > 1000) {
      lastTouch.current = Date.now();
    }
  }, [frame, state.activeId]);
  useEffect(
    () =>
      agent?.onGoto?.(raw => {
        const g = asAgentGoto(raw);
        if (g == null || g.videoId !== video.path || status !== 'ready') {
          return {moved: false, reason: 'studio is not on that video'};
        }
        if (playingRef.current) {
          return {moved: false, reason: 'the person is playing the clip'};
        }
        if (Date.now() - lastTouch.current < 2000) {
          return {moved: false, reason: 'the person is working on the timeline'};
        }
        if (g.objectId != null && !stateRef.current.objects.some(o => o.id === g.objectId)) {
          return {moved: false, reason: `there is no layer ${g.objectId} on this video`};
        }
        agentMovedAt.current = Date.now();
        const c: AgentChange = {
          videoId: g.videoId, kind: 'goto', objectIds: g.objectId != null ? [g.objectId] : [], frame: g.frame,
          end: null, state: null, jobId: null, name: null, at: Date.now(),
        };
        setAgentActivity(list => appendActivity(list, c, stateRef.current.activeId));
        goToAgentChange({id: 0, change: c, onSelected: false});
        return {moved: true};
      }),
    [agent, video.path, status, goToAgentChange],
  );

  // sam_track start on this video: studio runs the job through runTrack, its
  // own path, so the lanes fill and the states move as for the person's own
  // tracks. Main hears the job id once the backend gives it, then the outcome.
  const agentTracks = useRef(new Set<(msg: AgentTrackReply) => void>()); // replies still owed a 'done'
  useEffect(
    () =>
      agent?.onTrack?.((raw, reply) => {
        const r = asAgentTrack(raw);
        if (r == null || r.videoId !== video.path || status !== 'ready') {
          reply({stage: 'refused', error: 'studio is not on that video'});
          return;
        }
        if (r.engine === BROWSER_ENGINE) {
          reply({stage: 'refused', error: `${engineLabel(BROWSER_ENGINE)} runs in the person's browser only`});
          return;
        }
        let started = false;
        agentTracks.current.add(reply);
        void runTrack(undefined, {
          ids: r.objectIds ?? undefined,
          engine: r.engine ?? DEFAULT_ENGINE, // as the backend's default, whatever the person shows
          onStarted: job => {
            started = true;
            reply({stage: 'started', job_id: job.jobId, objects: job.selected, bounded: job.bounded});
          },
        }).then(outcome => {
          if (!agentTracks.current.delete(reply)) {
            return; // the video closed first, and said so
          }
          if (!started) {
            reply(outcome == null ? {stage: 'started', job_id: null, objects: [], bounded: []} : {stage: 'refused', error: outcome.ok ? 'tracking did not start' : outcome.error});
            return;
          }
          reply({
            stage: 'done',
            result: outcome?.ok
              ? {done: true, tracked: outcome.tracked, failed: Object.fromEntries(Object.entries(outcome.failed))}
              : {done: false, tracked: [], failed: {}, error: outcome?.error ?? 'the track did not finish'},
          });
        });
      }),
    [agent, video.path, status, runTrack],
  );
  useEffect(
    () => () => {
      // the video closes, and its worker with the jobs it ran
      agentTracks.current.forEach(reply => reply({stage: 'done', result: {done: false, tracked: [], failed: {}, error: 'the person closed this video in studio'}}));
      agentTracks.current.clear();
    },
    [],
  );

  // the person's view, for sam_studio state: at once on any change but the
  // frame, which is sent at most every 200 ms and always after scrubbing stops
  const view = viewReport({
    videoId: video.path,
    sessionId: status === 'ready' ? sessionIdRef.current : null,
    frame,
    numFrames: meta.numFrames,
    playing,
    activeId: state.activeId,
    engine: state.engine,
    hiddenIds: hiddenIds(state.layout),
    colors: objectColors,
    nextObjectId: nextObjectId(state.objects, idFloor.current),
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  const viewKey = JSON.stringify({...view, frame: undefined});
  useEffect(() => {
    agent?.report(viewRef.current);
  }, [agent, viewKey]);
  const frameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (agent == null || frameTimer.current != null) {
      return;
    }
    frameTimer.current = setTimeout(() => {
      frameTimer.current = null;
      agent.report(viewRef.current);
    }, 200);
  }, [agent, frame]);
  useEffect(
    () => () => {
      if (frameTimer.current != null) {
        clearTimeout(frameTimer.current);
        frameTimer.current = null;
      }
      agent?.report({open: false});
    },
    [agent],
  );

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
  const ordered = useMemo(() => orderedObjects(state), [state]);

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

  const detailRequest = async (operation: import('~/state/detail').DetailOperation, args?: Record<string, unknown>) => {
    if (bridge == null || busy) throw new Error('Wait for the session to be ready');
    const result = await bridge.call('detailRequest', {operation, args});
    if (operation === 'apply_detail_crop' || operation === 'remove_detail_crop') await sync();
    return result;
  };
  return {
    detailRequest,
    bridge,
    state,
    /** The objects in list order (the layout's): the list's, the lanes' and the exports' order. */
    ordered,
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
    review,
    currentStop,
    goToStop,
    stepReview,
    markReviewed,
    flags,
    toggleFlag,
    objectEffects,
    objectColors,
    setObjectColor,
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
    textPrompt,
    discoverText,
    textSupport,
    addObject,
    renameObject,
    selectObject,
    track,
    trackGroup,
    cancelTrack,
    clearTrack,
    clearGroupTracks,
    layoutAction,
    addGroup,
    updateGroup,
    setGroupEffect,
    setRange,
    confirmCandidate,
    rejectCandidate,
    writeObjectCandidates,
    undo: () => stepSeeds('undo'),
    redo: () => stepSeeds('redo'),
    stepSeeds,
    restoreVersion,
    moveClicks,
    markAbsentUntilNextSeed,
    removeObject,
    startOver,
    seek,
    togglePlay,
    /** What agents did on this video, newest first (state/agentActivity.ts). */
    agentActivity,
    /** Job ids an agent started here: foreignJobs among them are the agent's. */
    agentJobIds,
    goToAgentChange,
  };
}

export type StudioSessionApi = ReturnType<typeof useStudioSession>;
