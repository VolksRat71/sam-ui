// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// MediaApi with no backend: this browser's OPFS and the bundled samples.
import {useCallback, useEffect, useMemo, useState} from 'react';
import {requestPersistentStorage} from '~/lib/persist';
import {BROWSER_LIMITS} from '~/budgets';
import {OpfsKv} from '~/local/kv';
import type {LocalMedia} from '~/local/localMedia';
import type {VideoItem} from '~/workspace/useStudioSession';
import type {MediaApi} from './mediaApi';

// loaded only with no backend (it brings mediabunny into the page)
let shared: Promise<LocalMedia> | null = null;
const media = () => (shared ??= import('~/local/localMedia').then(m => new m.LocalMedia(new OpfsKv())));

/** Null until the first listing is in (the app shows its loading state). */
export default function useLocalMedia(): MediaApi | null {
  const [videos, setVideos] = useState<VideoItem[] | null>(null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    requestPersistentStorage(); // the videos, seeds and tracks live in this browser
    let stale = false;
    media()
      .then(m => m.list())
      .then(v => !stale && setVideos(v))
      .catch(() => !stale && setVideos([]));
    return () => {
      stale = true;
    };
  }, [key]);
  const add = useCallback(async (file: File) => (await media()).open(file), []);
  const remove = useCallback(async (v: VideoItem, purge: boolean) => (await media()).remove(v, purge), []);
  const refresh = useCallback(() => setKey(k => k + 1), []);
  return useMemo(() => (videos == null ? null : {offline: true, videos, limits: BROWSER_LIMITS, add, remove, refresh}), [videos, add, remove, refresh]);
}
