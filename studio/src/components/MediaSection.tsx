// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Media list: the backend's gallery videos plus this browser's uploads
// (or, with no backend, the files opened into this browser and the bundled
// samples), and an upload control. Picking a video starts a new session on it.
import {TrashCan, Upload} from '@carbon/icons-react';
import {useRef, useState} from 'react';
import {videoDisplayName} from '~/lib/uploadNames';
import {isDeletable} from '~/state/media';
import type {VideoItem} from '~/workspace/useStudioSession';

const ACCEPT = 'video/mp4,video/quicktime,.mp4,.mov';
const MAX_UPLOAD_MB = 70; // Meta's demo limit

type Props = {
  videos: VideoItem[];
  current: VideoItem | null;
  locked: boolean;
  /** No backend: the file is opened into this browser, not uploaded. */
  offline: boolean;
  onSelect: (video: VideoItem) => void;
  /** Upload (or, offline, store) a file. */
  onAdd: (file: File) => Promise<VideoItem>;
  onAdded: (video: VideoItem) => void;
  /** Ask to delete an upload (the app confirms it, above this pane). */
  onDelete: (video: VideoItem) => void;
};

export default function MediaSection({videos, current, locked, offline, onSelect, onAdd, onAdded, onDelete}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  function upload(file: File) {
    setError(null);
    if (file.size > MAX_UPLOAD_MB * 1024 ** 2) {
      setError(`File too large. Try a video under ${MAX_UPLOAD_MB} MB.`);
      return;
    }
    setUploading(true);
    onAdd(file)
      .then(onAdded)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
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
            upload(file);
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
              upload(file);
            }
          }}
        />
      </div>
      {error != null && <div className="media-error">{error}</div>}
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
