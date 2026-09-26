// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Build-time settings, read from Vite env vars (see studio/README.md):
//   VITE_API_ENDPOINT  backend base URL (GraphQL at /graphql, streams at /track_*),
//                      or "same-origin" when the backend serves studio itself
//   VITE_OBJECT_LIMIT  most objects one video may hold
export const DEFAULT_API_ENDPOINT = 'http://localhost:7263';
export const DEFAULT_OBJECT_LIMIT = 16;

export function parseObjectLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OBJECT_LIMIT;
}

/** The backend's base URL. "same-origin" means the page's own origin: studio
 * served by the backend itself (the desktop app, or `SAM_UI_STUDIO_DIST`). */
export function resolveApiEndpoint(raw: string | undefined, origin: string): string {
  const value = raw === 'same-origin' ? origin : raw || DEFAULT_API_ENDPOINT;
  return value.replace(/\/+$/, '');
}

export const API_ENDPOINT: string = resolveApiEndpoint(
  import.meta.env.VITE_API_ENDPOINT,
  globalThis.location?.origin ?? '',
);

export const OBJECT_LIMIT: number = parseObjectLimit(
  import.meta.env.VITE_OBJECT_LIMIT,
);
