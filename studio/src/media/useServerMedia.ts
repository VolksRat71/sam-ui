// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// MediaApi on the backend: the videos query, and Meta's uploadVideo and
// studio's deleteVideo mutations.
import {useCallback, useMemo, useState} from 'react';
import {graphql, useLazyLoadQuery, useMutation} from 'react-relay';
import {API_ENDPOINT} from '~/config';
import {explainGraphQLError} from '~/lib/errors';
import {rememberUploadName} from '~/lib/uploadNames';
import type {VideoItem} from '~/workspace/useStudioSession';
import type {MediaApi} from './mediaApi';
import type {useServerMediaDeleteMutation} from './__generated__/useServerMediaDeleteMutation.graphql';
import type {useServerMediaUploadMutation} from './__generated__/useServerMediaUploadMutation.graphql';
import type {useServerMediaVideosQuery} from './__generated__/useServerMediaVideosQuery.graphql';

/**
 * Video URLs are built from the configured endpoint rather than the backend's
 * `url` field, which uses the backend's API_URL setting and may name another
 * port.
 */
export function toVideoItem(v: {path: string; width: number; height: number; posterPath?: string | null}): VideoItem {
  return {
    path: v.path,
    url: `${API_ENDPOINT}/${v.path}`,
    width: v.width,
    height: v.height,
    posterUrl: v.posterPath != null && v.posterPath !== '' ? `${API_ENDPOINT}/${v.posterPath}` : null,
  };
}

export default function useServerMedia(): MediaApi {
  // bumped after an upload or a delete, so the list is fetched again
  const [fetchKey, setFetchKey] = useState(0);
  const data = useLazyLoadQuery<useServerMediaVideosQuery>(
    graphql`
      query useServerMediaVideosQuery {
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
  const videos = useMemo(() => data.videos.edges.map(e => toVideoItem(e.node)), [data]);

  const [commitUpload] = useMutation<useServerMediaUploadMutation>(graphql`
    mutation useServerMediaUploadMutation($file: Upload!) {
      uploadVideo(file: $file) {
        id
        path
        posterPath
        width
        height
      }
    }
  `);
  const [commitDelete] = useMutation<useServerMediaDeleteMutation>(graphql`
    mutation useServerMediaDeleteMutation($input: DeleteVideoInput!) {
      deleteVideo(input: $input) {
        path
        purged
        sessionsClosed
      }
    }
  `);

  const add = useCallback(
    (file: File) =>
      new Promise<VideoItem>((resolve, reject) =>
        commitUpload({
          variables: {file},
          uploadables: {file},
          onCompleted: (response, errors) => {
            if (errors != null && errors.length > 0) {
              reject(new Error(explainGraphQLError(errors[0].message)));
              return;
            }
            rememberUploadName(response.uploadVideo.path, file.name);
            resolve(toVideoItem(response.uploadVideo));
          },
          onError: err => reject(new Error(explainGraphQLError(err.message || 'Upload failed.'))),
        }),
      ),
    [commitUpload],
  );

  const remove = useCallback(
    (v: VideoItem, purgeTracks: boolean) =>
      new Promise<void>((resolve, reject) =>
        commitDelete({
          // the user is deleting it: sessions abandoned on it (vanished tabs) must not block that
          variables: {input: {path: v.path, purgeTracks, closeIdleSessions: true}},
          onCompleted: (_, errors) =>
            errors != null && errors.length > 0 ? reject(new Error(errors[0].message)) : resolve(),
          onError: reject,
        }),
      ),
    [commitDelete],
  );

  const refresh = useCallback(() => setFetchKey(k => k + 1), []);
  return useMemo(() => ({offline: false, videos, add, remove, refresh}), [videos, add, remove, refresh]);
}
