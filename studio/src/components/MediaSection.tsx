// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Media list: the backend's gallery videos plus this browser's uploads
// (or, with no backend, the files opened into this browser and the bundled
// samples), and an upload control. Picking a video starts a new session on it.
// In the desktop app, Open from After Effects opens footage from the open AE
// project in place (AeOpenModal), frame for frame.
import {Launch, TrashCan, Upload} from '@carbon/icons-react';
import {useRef, useState} from 'react';
import {aeBridge} from '~/lib/desktop';
import {videoDisplayName} from '~/lib/uploadNames';
import {readDuration} from '~/lib/videoDuration';
import {RELEASES_URL} from '~/state/engines';
import {checkUpload, FALLBACK_LIMITS, type UploadLimits} from '~/state/uploadLimits';
import {isDeletable} from '~/state/media';
import type {VideoItem} from '~/workspace/useStudioSession';
import AeOpenModal from './AeOpenModal';

const ACCEPT = 'video/mp4,video/quicktime,.mp4,.mov';

type Props = {
  videos: VideoItem[];
  current: VideoItem | null;
  locked: boolean;
  /** No backend: the file is opened into this browser, not uploaded. */
  offline: boolean;
  /** The backend's (or the browser build's) limits; null while they are fetched. */
  limits: UploadLimits | null;
  onSelect: (video: VideoItem) => void;
  /** Upload (or, offline, store) a file. */
  onAdd: (file: File) => Promise<VideoItem>;
  onAdded: (video: VideoItem) => void;
  /** Ask to delete an upload (the app confirms it, above this pane). */
  onDelete: (video: VideoItem) => void;
};

export default function MediaSection({videos, current, locked, offline, limits, onSelect, onAdd, onAdded, onDelete}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<{text: string; desktop: boolean} | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [fromAe, setFromAe] = useState(false);
  const canAe = !offline && aeBridge() != null;

  async function upload(file: File) {
    setError(null);
    setNotice(null);
    setUploading(true);
    // the size and length first: a long clip is trimmed (backend) or refused
    // (browser build), and either way the user hears it before it happens
    const check = checkUpload(file.size, await readDuration(file), limits ?? FALLBACK_LIMITS);
    if (check.error != null) {
      setError({text: check.error, desktop: check.desktop});
      setUploading(false);
      return;
    }
    setNotice(check.notice);
    onAdd(file)
      .then(onAdded)
      .catch((err: unknown) => setError({text: err instanceof Error ? err.message : String(err), desktop: false}))
      .finally(() => setUploading(false));
  }

  return (
    <div className="media">
      <div
        className={uploading ? 'dropzone busy' : 'dropzone'}
        onClick={() => !uploading && !locked && input.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (file != null && !uploading && !locked) {
            void upload(file);
          }
        }}>
        <Upload size={18} />
        <span>
          {offline
            ? uploading
              ? 'Opening…'
              : 'Open a video (mp4 or mov): it stays in this browser'
            : uploading
              ? 'Uploading…'
              : 'Upload a video (mp4 or mov)'}
        </span>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={e => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file != null) {
              void upload(file);
            }
          }}
        />
      </div>
      {canAe && (
        <button className="button subtle ae-open" disabled={locked} onClick={() => setFromAe(true)} title={locked ? 'Wait for the running track jobs' : undefined}>
          <Launch size={16} /> Open from After Effects…
        </button>
      )}
      {fromAe && (
        <AeOpenModal
          onClose={() => setFromAe(false)}
          onOpened={v => {
            setFromAe(false);
            onAdded(v);
          }}
        />
      )}
      {error != null && (
        <div className="media-error">
          {error.text}
          {error.desktop && (
            <>
              {' '}
              <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                Download the desktop app
              </a>
            </>
          )}
        </div>
      )}
      {notice != null && (
        <div className="media-notice" role="status">
          <span>{notice}</span>
          <button className="link-button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      <ul className="media-list">
        {videos.map(v => {
          const selected = v.path === current?.path;
          return (
            <li key={v.path} className="media-row">
              <button
                className={selected ? 'media-item selected' : 'media-item'}
                disabled={locked && !selected}
                onClick={() => !selected && onSelect(v)}
                title={v.path}>
                {v.posterUrl != null ? (
                  <img className="media-thumb" src={v.posterUrl} alt="" />
                ) : (
                  <video className="media-thumb" src={`${v.url}#t=0.001`} muted preload="metadata" />
                )}
                <span className="media-name" title={v.path}>{videoDisplayName(v.path)}</span>
                <span className="media-dims">
                  {v.width}×{v.height}
                </span>
              </button>
              {isDeletable(v.path) && (
                <button
                  className="icon-button media-remove"
                  disabled={locked && selected}
                  onClick={() => onDelete(v)}
                  title={locked && selected ? 'Wait for the running track jobs' : offline ? 'Delete it from this browser' : 'Delete this upload'}
                  aria-label={`Delete ${videoDisplayName(v.path)}`}>
                  <TrashCan size={16} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
