// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Build-time settings, read from Vite env vars (see studio/README.md):
//   VITE_API_ENDPOINT  backend base URL (GraphQL at /graphql, streams at /track_*)
//   VITE_OBJECT_LIMIT  most objects one video may hold
export const DEFAULT_API_ENDPOINT = 'http://localhost:7263';
export const DEFAULT_OBJECT_LIMIT = 16;

export function parseObjectLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OBJECT_LIMIT;
}

export const API_ENDPOINT: string = (
  import.meta.env.VITE_API_ENDPOINT || DEFAULT_API_ENDPOINT
).replace(/\/+$/, '');

export const OBJECT_LIMIT: number = parseObjectLimit(
  import.meta.env.VITE_OBJECT_LIMIT,
);
