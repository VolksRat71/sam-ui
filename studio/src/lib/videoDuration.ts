// sam-ui (Apache-2.0). New file, not from SAM 2.

/** A video file's duration in seconds, from its metadata (a detached <video>), or null. */
export function readDuration(file: Blob, timeoutMs = 10_000): Promise<number | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let done = false;
    const finish = (d: number | null) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(d != null && Number.isFinite(d) && d > 0 ? d : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => finish(video.duration);
    video.onerror = () => finish(null);
    video.src = url;
  });
}
