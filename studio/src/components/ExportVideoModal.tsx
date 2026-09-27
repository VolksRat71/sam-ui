// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Export the video with every object's own effect, as an MP4 made in the
// browser. Objects nobody gave an effect render as Original by default, so
// nothing the user did not choose ends up in the file; "keep as shown" keeps
// their Overlay instead. No point markers, selection emphasis or watermark.
import {useEffect, useState} from 'react';
import {saveBlob} from '~/lib/download';
import {defaultExportName, exportFileName} from '~/state/fileNames';
import type {UntouchedMode} from '~/state/objectEffects';
import type {StudioSessionApi} from '~/workspace/useStudioSession';
import FileNameField from './FileNameField';

type Props = {session: StudioSessionApi; videoName: string; onClose: () => void};

export default function ExportVideoModal({session, videoName, onClose}: Props) {
  const [untouched, setUntouched] = useState<UntouchedMode>('original');
  const fallback = defaultExportName(videoName, 'video');
  const [file, setFile] = useState(fallback);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{name: string; size: number} | null>(null);
  const busy = session.exportProgress != null;
  const untouchedCount = session.state.objects.filter(o => session.objectEffects[o.id] == null).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function run() {
    setError(null);
    setDone(null);
    try {
      const blob = await session.exportVideo(untouched);
      const name = exportFileName(file, fallback, '.mp4');
      saveBlob(blob, name);
      setDone({name, size: blob.size});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="export-video-title" onClick={e => e.stopPropagation()}>
        <h2 id="export-video-title">Export video</h2>
        <div className="modal-body">
          <p>
            An MP4 of the whole video, each object with its own effect and the background effect. Point markers and
            selection highlights are not included.
          </p>
          <FileNameField value={file} onChange={setFile} disabled={busy} />
          <fieldset className="radio-group" disabled={busy}>
            <legend>
              Objects without a chosen effect{untouchedCount > 0 ? ` (${untouchedCount})` : ''}
            </legend>
            <label>
              <input
                type="radio"
                name="untouched"
                checked={untouched === 'original'}
                onChange={() => setUntouched('original')}
              />{' '}
              Original (unchanged)
            </label>
            <label>
              <input type="radio" name="untouched" checked={untouched === 'shown'} onChange={() => setUntouched('shown')} />{' '}
              Keep as shown (coloured overlay)
            </label>
          </fieldset>
          {busy && (
            <div className="export-progress">
              <span className="job-progress">
                <span style={{width: `${Math.round((session.exportProgress ?? 0) * 100)}%`}} />
              </span>
              Encoding {Math.round((session.exportProgress ?? 0) * 100)}%
            </div>
          )}
          {done != null && (
            <p className="muted">
              Saved {done.name} ({(done.size / 1e6).toFixed(1)} MB).
            </p>
          )}
          {error != null && <div className="media-error">Export failed: {error}</div>}
        </div>
        <div className="modal-actions">
          <button className="button" onClick={onClose} disabled={busy}>
            {done != null ? 'Close' : 'Cancel'}
          </button>
          <button className="button primary" onClick={run} disabled={busy || !session.meta.decoded}>
            {busy ? 'Exporting…' : 'Export MP4'}
          </button>
        </div>
      </div>
    </div>
  );
}
