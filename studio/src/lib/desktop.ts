// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// What the desktop app's main window exposes (desktop/src/app-preload.js).
// Absent anywhere else (a browser, the dev server), so callers show their
// desktop-only controls only when this returns a bridge.
//
// `ae` reaches After Effects through the desktop app's main process
// (desktop/src/ae-roto.js). The page never talks to After Effects itself: its
// bridge refuses browser origins, so nothing here probes localhost.
import type {VectorJson} from '~/state/contours';

export type AeError = {state: string; message: string; installUrl?: string; problems?: string[]};
export type AeResult<T> = {ok: true; value: T} | {ok: false; error: AeError};
export type AeStatus = {state: 'ready'; aeVersion: string | null} | AeError;

/** A footage item as the bridge's `media` op lists it, marked eligible or not. */
export type AeMediaItem = {
  id: number;
  name: string;
  path: string;
  width: number;
  height: number;
  frameRate: number;
  frames: number;
  duration: number;
  missing: boolean;
  eligible: boolean;
  reason?: string;
};

export type AeMedia = {
  project: {path: string | null; name: string | null; dirty?: boolean} | null;
  items: AeMediaItem[];
  ineligible: Array<{id: number; name: string; reason: string}>;
};

/** Where an After Effects video came from, as the backend keeps it (data/linked.py). */
export type AeSourceRecord = {
  path: string;
  source: {kind: string; aeItemId: number; aeProjectPath: string | null; name: string; path: string; width: number; height: number; frameRate: number; frames: number};
  videoHash: string;
  missing?: boolean;
  changed?: boolean;
};

/** A video opened in place: the backend's listing of it. */
export type AeLinkedVideo = {path: string; posterPath: string | null; width: number; height: number; record: AeSourceRecord};

export type AeExportRequest = {videoPath: string; objects: VectorJson[]; studio: {frames: number; width: number; height: number}};
export type AeExportResult = {compId: number; compName: string; layers: number; masks: number; keys: number};

export type AeBridge = {
  status(): Promise<AeResult<AeStatus>>;
  listMedia(): Promise<AeResult<AeMedia>>;
  open(itemId: number): Promise<AeResult<AeLinkedVideo>>;
  sourceOf(videoPath: string): Promise<AeResult<AeSourceRecord | null>>;
  exportRoto(request: AeExportRequest): Promise<AeResult<AeExportResult>>;
  /** Progress of the running export; returns the unsubscribe. */
  onProgress(cb: (p: {fraction: number; label: string}) => void): () => void;
};

export type DesktopBridge = {setupSam3(): void; ae?: AeBridge};

export function desktopBridge(): DesktopBridge | null {
  const b = (globalThis as {samUiDesktop?: Partial<DesktopBridge>}).samUiDesktop;
  return typeof b?.setupSam3 === 'function' ? (b as DesktopBridge) : null;
}

/** The After Effects half of the desktop bridge, or null (a browser, or an older desktop app). */
export function aeBridge(): AeBridge | null {
  const ae = desktopBridge()?.ae;
  return ae != null && typeof ae.listMedia === 'function' ? ae : null;
}
