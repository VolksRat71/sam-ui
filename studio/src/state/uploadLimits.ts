// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// How long and how large a video studio takes in:
//   - with a backend, what GET /limits says; an older backend has no such
//     route, and keeps Meta's demo limits (70 MB, 10 s). A clip over the
//     duration is not refused: the backend keeps its start, and studio says
//     so before the upload, never silently;
//   - in the browser-only build, a fixed limit (the browser engine has to
//     hold the whole clip), and a longer clip is refused, pointing at the
//     desktop app.

export type UploadLimits = {
  maxSeconds: number;
  maxMb: number;
  /** trim: the backend keeps the clip's start; refuse: the browser build turns it away. */
  over: 'trim' | 'refuse';
};

/** Meta's demo limits: what a backend without GET /limits enforces. */
export const FALLBACK_LIMITS: UploadLimits = {maxSeconds: 10, maxMb: 70, over: 'trim'};

/** What the desktop app (a current backend) takes, as the browser build's refusal names it. */
export const DESKTOP_MAX_SECONDS = 300;

/** GET /limits's body as limits; anything unexpected means the fallback. */
export function parseLimits(body: unknown): UploadLimits {
  const b = (body ?? {}) as {max_upload_seconds?: unknown; max_upload_mb?: unknown};
  const s = Number(b.max_upload_seconds);
  const mb = Number(b.max_upload_mb);
  if (!(s > 0) || !(mb > 0)) {
    return FALLBACK_LIMITS;
  }
  return {maxSeconds: s, maxMb: mb, over: 'trim'};
}

/** The backend's limits, or the fallback when it has no /limits (404) or does not answer. */
export async function fetchLimits(endpoint: string, fetchFn: typeof fetch = fetch): Promise<UploadLimits> {
  try {
    const r = await fetchFn(`${endpoint}/limits`);
    return r.ok ? parseLimits(await r.json()) : FALLBACK_LIMITS;
  } catch {
    return FALLBACK_LIMITS;
  }
}

/** 432 s -> "7:12"; an hour or more -> "1:02:03". */
export function formatDuration(seconds: number): string {
  const t = Math.max(0, Math.round(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export type UploadCheck = {
  /** Refuse the file, with this message. */
  error: string | null;
  /** Take it, and show this while it uploads. */
  notice: string | null;
  /** The error points at the desktop app. */
  desktop: boolean;
};

/**
 * What to do with a file of `bytes` and `seconds` (null when its duration
 * could not be read: the limit is then the backend's to apply).
 */
export function checkUpload(bytes: number, seconds: number | null, limits: UploadLimits): UploadCheck {
  if (bytes > limits.maxMb * 1024 ** 2) {
    return {error: `File too large (limit ${limits.maxMb} MB).`, notice: null, desktop: false};
  }
  if (seconds == null || !(seconds > limits.maxSeconds + 0.05)) {
    return {error: null, notice: null, desktop: false};
  }
  if (limits.over === 'refuse') {
    return {
      error: `The browser demo handles clips up to ${formatDuration(limits.maxSeconds)}. The desktop app handles up to ${DESKTOP_MAX_SECONDS / 60} minutes.`,
      notice: null,
      desktop: true,
    };
  }
  return {
    error: null,
    notice: `This clip is ${formatDuration(seconds)}. Uploads keep the first ${formatDuration(limits.maxSeconds)} (the backend's limit).`,
    desktop: false,
  };
}

/** A 413 from the backend's web server. */
export function tooLargeMessage(limits: UploadLimits): string {
  return `File too large (limit ${limits.maxMb} MB).`;
}
