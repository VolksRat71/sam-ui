// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {checkUpload, FALLBACK_LIMITS, fetchLimits, formatDuration, parseLimits, tooLargeMessage, type UploadLimits} from './uploadLimits';

const backend: UploadLimits = {maxSeconds: 300, maxMb: 2048, over: 'trim'};
const browser: UploadLimits = {maxSeconds: 90, maxMb: 500, over: 'refuse'};
const MB = 1024 ** 2;

describe('/limits', () => {
  it('reads the backend limits', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({max_upload_seconds: 300, max_upload_mb: 2048}))) as typeof fetch;
    expect(await fetchLimits('http://x', fetchFn)).toEqual(backend);
  });

  it('falls back to 70 MB / 10 s on an older backend, an error or a bad answer', async () => {
    const r404 = (async () => new Response('not found', {status: 404})) as typeof fetch;
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const html = (async () => new Response('<html>')) as typeof fetch;
    for (const f of [r404, down, html]) {
      expect(await fetchLimits('http://x', f)).toEqual(FALLBACK_LIMITS);
    }
    expect(FALLBACK_LIMITS).toMatchObject({maxSeconds: 10, maxMb: 70});
    expect(parseLimits({max_upload_seconds: 0, max_upload_mb: 5})).toEqual(FALLBACK_LIMITS);
    expect(parseLimits(null)).toEqual(FALLBACK_LIMITS);
  });
});

describe('the duration notice', () => {
  it('formats durations', () => {
    expect(formatDuration(432)).toBe('7:12');
    expect(formatDuration(300)).toBe('5:00');
    expect(formatDuration(59.6)).toBe('1:00');
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('says a long clip is trimmed to the backend limit, and takes it', () => {
    expect(checkUpload(10 * MB, 432, backend)).toEqual({
      error: null,
      notice: "This clip is 7:12. Uploads keep the first 5:00 (the backend's limit).",
      desktop: false,
    });
    expect(checkUpload(10 * MB, 300, backend).notice).toBeNull(); // exactly at the limit
    expect(checkUpload(10 * MB, null, backend)).toEqual({error: null, notice: null, desktop: false}); // unknown duration
    expect(checkUpload(1 * MB, 12, FALLBACK_LIMITS).notice).toBe("This clip is 0:12. Uploads keep the first 0:10 (the backend's limit).");
  });

  it('refuses a file over the size limit, and names it', () => {
    expect(checkUpload(3000 * MB, 10, backend).error).toBe('File too large (limit 2048 MB).');
    expect(checkUpload(71 * MB, 5, FALLBACK_LIMITS).error).toBe('File too large (limit 70 MB).');
    expect(tooLargeMessage(backend)).toBe('File too large (limit 2048 MB).');
  });

  it('in the browser build, refuses a long clip and points at the desktop app', () => {
    expect(checkUpload(10 * MB, 120, browser)).toEqual({
      error: 'The browser demo handles clips up to 1:30. The desktop app handles up to 5 minutes.',
      notice: null,
      desktop: true,
    });
    expect(checkUpload(10 * MB, 60, browser).error).toBeNull();
  });
});
