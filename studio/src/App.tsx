// sam-ui (Apache-2.0). New file, not from SAM 2.
import {useCallback, useState} from 'react';
import DeleteVideoModal from '~/components/DeleteVideoModal';
import MediaSection from '~/components/MediaSection';
import Workspace from '~/components/Workspace';
import {whenClosed} from '~/lib/sessionClose';
import {readJson, writeJson} from '~/lib/storage';
import type {MediaApi} from '~/media/mediaApi';
import useLocalMedia from '~/media/useLocalMedia';
import useServerMedia from '~/media/useServerMedia';
import {afterDelete} from '~/state/media';
import type {VideoItem} from '~/workspace/useStudioSession';

const LAST_VIDEO_KEY = 'sam-ui-studio:video';

/** Studio on a backend: its gallery and uploads. */
export function ServerApp() {
  return <App media={useServerMedia()} />;
}

/** Studio with no backend: videos opened into this browser, and the bundled samples. */
export function LocalApp() {
  const media = useLocalMedia();
  if (media == null) {
    return (
      <div className="app empty-app">
        <span className="loading">
          <span className="spinner" /> Loading…
        </span>
      </div>
    );
  }
  return <App media={media} />;
}

function App({media}: {media: MediaApi}) {
  const {videos} = media;
  const [current, setCurrent] = useState<VideoItem | null>(() => {
    const last = readJson<string | null>(LAST_VIDEO_KEY, null);
    return videos.find(v => v.path === last) ?? videos[0] ?? null;
  });

  const select = useCallback((v: VideoItem) => {
    setCurrent(v);
    writeJson(LAST_VIDEO_KEY, v.path);
  }, []);

  const added = useCallback(
    (v: VideoItem) => {
      media.refresh();
      select(v);
    },
    [media, select],
  );

  /**
   * Delete a video. If it is the open one, move off it first and wait for
   * its session to close: the backend refuses to delete an open video.
   */
  // the dialog lives here, above the Workspace, so it outlives the switch away
  // from the video being deleted
  const [deleting, setDeleting] = useState<VideoItem | null>(null);

  const deleteVideo = useCallback(
    async (v: VideoItem, purgeTracks: boolean) => {
      if (current?.path === v.path) {
        const next = afterDelete(videos, v.path, current);
        setCurrent(next);
        if (next != null) {
          writeJson(LAST_VIDEO_KEY, next.path);
        }
        await whenClosed(v.path); // the Workspace unmounts and closes its session
      }
      await media.remove(v, purgeTracks);
      media.refresh();
    },
    [media, current, videos],
  );

  const renderMedia = useCallback(
    (locked: boolean) => (
      <MediaSection
        videos={videos}
        current={current}
        locked={locked}
        offline={media.offline}
        onSelect={select}
        onAdd={media.add}
        onAdded={added}
        onDelete={setDeleting}
      />
    ),
    [videos, current, media, select, added],
  );

  const dialog =
    deleting != null ? (
      <DeleteVideoModal
        video={deleting}
        isOpen={deleting.path === current?.path}
        onDelete={deleteVideo}
        onClose={() => setDeleting(null)}
      />
    ) : null;

  if (current == null) {
    return (
      <div className="app empty-app">
        <div className="empty-card">
          <h1>sam-ui studio</h1>
          <p>
            {media.offline
              ? 'Open a video to start. It stays in this browser: nothing is uploaded.'
              : "No videos yet. Upload one to start, or put an .mp4 in the backend's gallery folder."}
          </p>
          {renderMedia(false)}
        </div>
        {dialog}
      </div>
    );
  }

  // a new Workspace (new worker, canvas and session) per video
  return (
    <>
      <Workspace key={current.path} video={current} renderMedia={renderMedia} />
      {dialog}
    </>
  );
}
