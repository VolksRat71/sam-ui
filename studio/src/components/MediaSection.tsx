// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Media list: the backend's gallery videos plus this browser's uploads
// (or, with no backend, the files opened into this browser and the bundled
// samples), and an upload control. Picking a video starts a new session on it.
// The upload itself is held above this section (media/uploads.ts), so it
// survives the section being hidden or remounted.
import {TrashCan, Upload} from '@carbon/icons-react';
import {useRef} from 'react';
import {videoDisplayName} from '~/lib/uploadNames';
import type {UploadApi} from '~/media/uploads';
import {RELEASES_URL} from '~/state/engines';
import {isDeletable} from '~/state/media';
import type {VideoItem} from '~/workspace/useStudioSession';

const ACCEPT = 'video/mp4,video/quicktime,.mp4,.mov';

type Props = {
  videos: VideoItem[];
  current: VideoItem | null;
  locked: boolean;
  /** No backend: the file is opened into this browser, not uploaded. */
  offline: boolean;
  onSelect: (video: VideoItem) => void;
  /** The upload in flight, if any, and how to start one (App holds it). */
  uploads: UploadApi;
  /** Ask to delete an upload (the app confirms it, above this pane). */
  onDelete: (video: VideoItem) => void;
};

export default function MediaSection({videos, current, locked, offline, onSelect, uploads, onDelete}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const {uploading, error, notice, upload} = uploads;

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
          <button className="link-button" onClick={uploads.dismissNotice}>
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
