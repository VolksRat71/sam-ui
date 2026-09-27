// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Where the Media list comes from and how a video gets in or out: the
// backend (its gallery and uploads) or, with no backend, this browser
// (files the user opens, kept in OPFS, and the bundled samples). App and
// MediaSection only see this.
import type {UploadLimits} from '~/state/uploadLimits';
import type {VideoItem} from '~/workspace/useStudioSession';

export type MediaApi = {
  /** No backend: videos and everything about them stay in this browser. */
  offline: boolean;
  videos: VideoItem[];
  /** How long and large a video may be (null while the backend is asked). */
  limits: UploadLimits | null;
  /** Upload a file (backend) or open it into this browser (no backend). */
  add(file: File): Promise<VideoItem>;
  /** Delete a video, and with purge its objects and tracks. */
  remove(video: VideoItem, purgeTracks: boolean): Promise<void>;
  /** Fetch the list again (after an upload or a delete). */
  refresh(): void;
};
