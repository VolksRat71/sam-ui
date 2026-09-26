// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Media list: the backend's gallery videos plus this browser's uploads,
// and an upload control (the backend's uploadVideo mutation, as Meta's
// useUploadVideo sends it). Picking a video starts a new session on it.
import {Upload} from '@carbon/icons-react';
import {useRef, useState} from 'react';
import {graphql, useMutation} from 'react-relay';
import type {VideoItem} from '~/workspace/useStudioSession';
import type {MediaSectionUploadMutation} from './__generated__/MediaSectionUploadMutation.graphql';

const ACCEPT = 'video/mp4,video/quicktime,.mp4,.mov';
const MAX_UPLOAD_MB = 70; // Meta's demo limit

type Props = {
  videos: VideoItem[];
  current: VideoItem | null;
  locked: boolean;
  onSelect: (video: VideoItem) => void;
  onUploaded: (video: VideoItem) => void;
  toVideoItem: (v: {path: string; width: number; height: number; posterPath?: string | null}) => VideoItem;
};

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

export default function MediaSection({videos, current, locked, onSelect, onUploaded, toVideoItem}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [commit, uploading] = useMutation<MediaSectionUploadMutation>(graphql`
    mutation MediaSectionUploadMutation($file: Upload!) {
      uploadVideo(file: $file) {
        id
        path
        posterPath
        width
        height
      }
    }
  `);

  function upload(file: File) {
    setError(null);
    if (file.size > MAX_UPLOAD_MB * 1024 ** 2) {
      setError(`File too large. Try a video under ${MAX_UPLOAD_MB} MB.`);
      return;
    }
    commit({
      variables: {file},
      uploadables: {file},
      onCompleted: (response, errors) => {
        if (errors != null && errors.length > 0) {
          setError(errors[0].message);
          return;
        }
        onUploaded(toVideoItem(response.uploadVideo));
      },
      onError: err => setError(err.message || 'Upload failed.'),
    });
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
        <span>{uploading ? 'Uploading…' : 'Upload a video (mp4 or mov)'}</span>
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
            <li key={v.path}>
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
                <span className="media-name">{fileName(v.path)}</span>
                <span className="media-dims">
                  {v.width}×{v.height}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
