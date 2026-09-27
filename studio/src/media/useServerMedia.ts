// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// MediaApi on the backend: the videos query, Meta's uploadVideo mutation
// (sent with fetch, so a 413 from the web server can be told apart), the
// deleteVideo mutation, and GET /limits.
import {useCallback, useEffect, useMemo, useState} from 'react';
import {graphql, useLazyLoadQuery, useMutation} from 'react-relay';
import {API_ENDPOINT} from '~/config';
import {explainGraphQLError} from '~/lib/errors';
import {rememberUploadName} from '~/lib/uploadNames';
import {fetchLimits, FALLBACK_LIMITS, tooLargeMessage, type UploadLimits} from '~/state/uploadLimits';
import type {VideoItem} from '~/workspace/useStudioSession';
import type {MediaApi} from './mediaApi';
import type {useServerMediaDeleteMutation} from './__generated__/useServerMediaDeleteMutation.graphql';
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

/** Meta's uploadVideo mutation, as the demo sends it (a GraphQL multipart request). */
const UPLOAD = `mutation UploadVideo($file: Upload!) {
  uploadVideo(file: $file) { id path posterPath width height }
}`;

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

  const [commitDelete] = useMutation<useServerMediaDeleteMutation>(graphql`
    mutation useServerMediaDeleteMutation($input: DeleteVideoInput!) {
      deleteVideo(input: $input) {
        path
        purged
        sessionsClosed
      }
    }
  `);

  const [limits, setLimits] = useState<UploadLimits | null>(null);
  useEffect(() => {
    void fetchLimits(API_ENDPOINT).then(setLimits);
  }, []);

  const add = useCallback(
    async (file: File) => {
      const form = new FormData();
      form.append('operations', JSON.stringify({query: UPLOAD, variables: {file: null}}));
      form.append('map', JSON.stringify({file: ['variables.file']}));
      form.append('file', file);
      const response = await fetch(`${API_ENDPOINT}/graphql`, {method: 'POST', body: form, credentials: 'include'});
      if (response.status === 413) {
        throw new Error(tooLargeMessage(limits ?? FALLBACK_LIMITS));
      }
      const body = (await response.json().catch(() => null)) as {
        data?: {uploadVideo?: {path: string; posterPath?: string | null; width: number; height: number}};
        errors?: Array<{message: string}>;
      } | null;
      if (body?.errors != null && body.errors.length > 0) {
        throw new Error(explainGraphQLError(body.errors[0].message));
      }
      const v = body?.data?.uploadVideo;
      if (!response.ok || v == null) {
        throw new Error(`Upload failed (HTTP ${response.status}).`);
      }
      rememberUploadName(v.path, file.name);
      return toVideoItem(v);
    },
    [limits],
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
  return useMemo(() => ({offline: false, videos, limits, add, remove, refresh}), [videos, limits, add, remove, refresh]);
}
