// sam-ui (Apache-2.0). New file, not from SAM 2.
import {useCallback, useMemo, useState} from 'react';
import {graphql, useLazyLoadQuery, useMutation} from 'react-relay';
import MediaSection from '~/components/MediaSection';
import Workspace from '~/components/Workspace';
import {API_ENDPOINT} from '~/config';
import {whenClosed} from '~/lib/sessionClose';
import {readJson, writeJson} from '~/lib/storage';
import {afterDelete} from '~/state/media';
import type {VideoItem} from '~/workspace/useStudioSession';
import type {AppDeleteVideoMutation} from './__generated__/AppDeleteVideoMutation.graphql';
import type {AppVideosQuery} from './__generated__/AppVideosQuery.graphql';

const LAST_VIDEO_KEY = 'sam-ui-studio:video';

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
  // bumped after an upload, so the list is fetched again with the new video
  const [fetchKey, setFetchKey] = useState(0);
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
    {fetchKey, fetchPolicy: fetchKey === 0 ? 'store-or-network' : 'network-only'},
  );

  // the gallery and every upload, as the backend lists them
  const videos = useMemo(() => data.videos.edges.map(e => toVideoItem(e.node)), [data]);

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
      setFetchKey(k => k + 1);
      select(v);
    },
    [select],
  );

  const [commitDelete] = useMutation<AppDeleteVideoMutation>(graphql`
    mutation AppDeleteVideoMutation($input: DeleteVideoInput!) {
      deleteVideo(input: $input) {
        path
        purged
      }
    }
  `);

  /**
   * Delete an upload. If it is the open video, move off it first and wait for
   * its session to close: the backend refuses to delete an open video.
   */
  const deleteVideo = useCallback(
    async (v: VideoItem, purgeTracks: boolean) => {
      if (current?.path === v.path) {
        const next = afterDelete(videos, v.path, current);
        setCurrent(next);
        if (next != null) {
          writeJson(LAST_VIDEO_KEY, next.path);
        }
        await new Promise(r => setTimeout(r, 0)); // let the Workspace unmount
        await whenClosed(v.path);
      }
      await new Promise<void>((resolve, reject) =>
        commitDelete({
          variables: {input: {path: v.path, purgeTracks}},
          onCompleted: (_, errors) =>
            errors != null && errors.length > 0 ? reject(new Error(errors[0].message)) : resolve(),
          onError: reject,
        }),
      );
      setFetchKey(k => k + 1);
    },
    [commitDelete, current, videos],
  );

  const renderMedia = useCallback(
    (locked: boolean) => (
      <MediaSection
        videos={videos}
        current={current}
        locked={locked}
        onSelect={select}
        onUploaded={uploaded}
        onDelete={deleteVideo}
        toVideoItem={toVideoItem}
      />
    ),
    [videos, current, select, uploaded, deleteVideo],
  );

  if (current == null) {
    return (
      <div className="app empty-app">
        <div className="empty-card">
          <h1>sam-ui studio</h1>
          <p>No videos yet. Upload one to start, or put an .mp4 in the backend&apos;s gallery folder.</p>
          {renderMedia(false)}
        </div>
      </div>
    );
  }

  // a new Workspace (new worker, canvas and session) per video
  return <Workspace key={current.path} video={current} renderMedia={renderMedia} />;
}
