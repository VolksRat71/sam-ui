// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// One upload at a time, with its error and notice. This lives above the
// Media section (App holds it), so an upload in flight survives the section
// being hidden, collapsed or remounted: a layout switch at the desktop width
// (an iPad rotated) or a video switch never unlocks the dropzone mid-upload.
import {useCallback, useMemo, useRef, useState} from 'react';
import {readDuration as readVideoDuration} from '~/lib/videoDuration';
import {checkUpload, FALLBACK_LIMITS, type UploadLimits} from '~/state/uploadLimits';
import type {VideoItem} from '~/workspace/useStudioSession';

export type UploadState = {
  uploading: boolean;
  error: {text: string; desktop: boolean} | null;
  notice: string | null;
};

export const IDLE: UploadState = {uploading: false, error: null, notice: null};

export type UploadDeps = {
  limits: UploadLimits | null;
  readDuration: (file: File) => Promise<number | null>;
  add: (file: File) => Promise<VideoItem>;
  onAdded: (video: VideoItem) => void;
};

/**
 * Takes uploads one at a time: start() refuses (returns false) while one
 * runs, whoever asks. State changes go to `set`.
 */
export class UploadQueue {
  private busy = false;

  constructor(private readonly set: (update: Partial<UploadState>) => void) {}

  get uploading(): boolean {
    return this.busy;
  }

  async start(file: File, deps: UploadDeps): Promise<boolean> {
    if (this.busy) {
      return false;
    }
    this.busy = true;
    this.set({uploading: true, error: null, notice: null});
    try {
      // the size and length first: a long clip is trimmed (backend) or
      // refused (browser build), and either way the user hears it first
      const check = checkUpload(file.size, await deps.readDuration(file), deps.limits ?? FALLBACK_LIMITS);
      if (check.error != null) {
        this.set({error: {text: check.error, desktop: check.desktop}});
        return true;
      }
      this.set({notice: check.notice});
      deps.onAdded(await deps.add(file));
    } catch (err) {
      this.set({error: {text: err instanceof Error ? err.message : String(err), desktop: false}});
    } finally {
      this.busy = false;
      this.set({uploading: false});
    }
    return true;
  }
}

export type UploadApi = UploadState & {
  upload: (file: File) => void;
  dismissNotice: () => void;
};

export default function useUploads(
  add: (file: File) => Promise<VideoItem>,
  onAdded: (video: VideoItem) => void,
  limits: UploadLimits | null,
): UploadApi {
  const [state, setState] = useState<UploadState>(IDLE);
  const queue = useRef<UploadQueue | null>(null);
  if (queue.current == null) {
    queue.current = new UploadQueue(update => setState(s => ({...s, ...update})));
  }
  const q = queue.current;
  const upload = useCallback(
    (file: File) => void q.start(file, {limits, readDuration: readVideoDuration, add, onAdded}),
    [q, limits, add, onAdded],
  );
  const dismissNotice = useCallback(() => setState(s => ({...s, notice: null})), []);
  return useMemo(() => ({...state, upload, dismissNotice}), [state, upload, dismissNotice]);
}
