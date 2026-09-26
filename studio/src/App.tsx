// sam-ui (Apache-2.0). New file, not from SAM 2.
import {useCallback, useMemo, useState} from 'react';
import {graphql, useLazyLoadQuery} from 'react-relay';
import MediaSection from '~/components/MediaSection';
import Workspace from '~/components/Workspace';
import {API_ENDPOINT} from '~/config';
import {readJson, writeJson} from '~/lib/storage';
import type {VideoItem} from '~/workspace/useStudioSession';
import type {AppVideosQuery} from './__generated__/AppVideosQuery.graphql';

const LAST_VIDEO_KEY = 'sam-ui-studio:video';
const UPLOADS_KEY = 'sam-ui-studio:uploads';

/**
 * Video URLs are built from the configured endpoint rather than the backend's
 * `url` field, which uses the backend's API_URL setting and may name another
 * port.
 */
function toVideoItem(v: {path: string; width: number; height: number; posterPath?: string | null}): VideoItem {
  return {
    path: v.path,
    url: `${API_ENDPOINT}/${v.path}`,
    width: v.width,
    height: v.height,
    posterUrl: v.posterPath != null && v.posterPath !== '' ? `${API_ENDPOINT}/${v.posterPath}` : null,
  };
}

export default function App() {
  const data = useLazyLoadQuery<AppVideosQuery>(
    graphql`
      query AppVideosQuery {
        videos {
          edges {
            node {
              id
              path
              posterPath
              width
              height
            }
          }
        }
      }
    `,
    {},
  );

  // the backend's videos query lists the gallery only; uploads are remembered here
  const [uploads, setUploads] = useState<VideoItem[]>(() => readJson(UPLOADS_KEY, []));
  const videos = useMemo(() => {
    const gallery = data.videos.edges.map(e => toVideoItem(e.node));
    const known = new Set(gallery.map(v => v.path));
    return [...gallery, ...uploads.filter(u => !known.has(u.path))];
  }, [data, uploads]);

  const [current, setCurrent] = useState<VideoItem | null>(() => {
    const last = readJson<string | null>(LAST_VIDEO_KEY, null);
    return videos.find(v => v.path === last) ?? videos[0] ?? null;
  });

  const select = useCallback((v: VideoItem) => {
    setCurrent(v);
    writeJson(LAST_VIDEO_KEY, v.path);
  }, []);

  const uploaded = useCallback(
    (v: VideoItem) => {
      setUploads(prev => {
        const next = [...prev.filter(u => u.path !== v.path), v];
        writeJson(UPLOADS_KEY, next);
        return next;
      });
      select(v);
    },
    [select],
  );

  const renderMedia = useCallback(
    (locked: boolean) => (
      <MediaSection
        videos={videos}
        current={current}
        locked={locked}
        onSelect={select}
        onUploaded={uploaded}
        toVideoItem={toVideoItem}
      />
    ),
    [videos, current, select, uploaded],
  );

  if (current == null) {
    return (
      <div className="app empty-app">
        <div className="empty-card">
          <h1>sam-ui studio</h1>
          <p>The backend has no gallery videos. Upload one to start.</p>
          {renderMedia(false)}
        </div>
      </div>
    );
  }

  // a new Workspace (new worker, canvas and session) per video
  return <Workspace key={current.path} video={current} renderMedia={renderMedia} />;
}
