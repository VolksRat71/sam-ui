// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// MediaApi with no backend: this browser's OPFS and the bundled samples.
import {useCallback, useEffect, useMemo, useState} from 'react';
import {OpfsKv} from '~/local/kv';
import {LocalMedia} from '~/local/localMedia';
import type {VideoItem} from '~/workspace/useStudioSession';
import type {MediaApi} from './mediaApi';

let shared: LocalMedia | null = null;
const media = () => (shared ??= new LocalMedia(new OpfsKv()));

/** Null until the first listing is in (the app shows its loading state). */
export default function useLocalMedia(): MediaApi | null {
  const [videos, setVideos] = useState<VideoItem[] | null>(null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    let stale = false;
    media()
      .list()
      .then(v => !stale && setVideos(v))
      .catch(() => !stale && setVideos([]));
    return () => {
      stale = true;
    };
  }, [key]);
  const add = useCallback((file: File) => media().open(file), []);
  const remove = useCallback((v: VideoItem, purge: boolean) => media().remove(v, purge), []);
  const refresh = useCallback(() => setKey(k => k + 1), []);
  return useMemo(() => (videos == null ? null : {offline: true, videos, add, remove, refresh}), [videos, add, remove, refresh]);
}
