// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Export masks as a zip, in the browser: grayscale mask videos, or Vector
// JSON outlines (the rotoscoping skill's contours.py format). Every object
// with a track on the engine on screen goes in, each file named after its
// object; README.txt (and each JSON) records the engine and model.
import {useEffect, useState} from 'react';
import {saveBlob} from '~/lib/download';
import {engineLabel} from '~/state/engines';
import {defaultExportName, exportFileName, objectName, uniqueFileNames} from '~/state/fileNames';
import type {StudioSessionApi} from '~/workspace/useStudioSession';
import FileNameField from './FileNameField';

type Props = {session: StudioSessionApi; kind: 'videos' | 'vectors'; videoPath: string; onClose: () => void};

const TEXT = {
  videos: {
    title: 'Export mask videos',
    body: 'One grayscale MP4 per object (white is the object, black the background), at the video’s size and frame rate.',
    file: 'masks' as const,
    ext: '.mp4',
  },
  vectors: {
    title: 'Export vector JSON',
    body: 'One JSON per object with its outlines on every frame (pieces and holes, in pixels), in the format the rotoscoping skill hands to After Effects.',
    file: 'vectors' as const,
    ext: '.json',
  },
};

export default function MaskExportModal({session, kind, videoPath, onClose}: Props) {
  const t = TEXT[kind];
  const fallback = defaultExportName(videoPath, t.file);
  const [file, setFile] = useState(fallback);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{name: string; size: number} | null>(null);
  const busy = session.exportProgress != null;
  const {state} = session;
  const objects = state.objects.filter(o => o.state === 'tracked' || o.state === 'stale');
  const names = uniqueFileNames(
    objects.map(o => objectName(o)),
    i => objectName(objects[i]),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function run() {
    setError(null);
    setDone(null);
    try {
      const blob = await session.exportMasks(kind);
      const name = exportFileName(file, fallback, '.zip');
      saveBlob(blob, name);
      setDone({name, size: blob.size});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="mask-export-title" onClick={e => e.stopPropagation()}>
        <h2 id="mask-export-title">{t.title}</h2>
        <div className="modal-body">
          <p>{t.body}</p>
          <FileNameField value={file} onChange={setFile} disabled={busy} />
          {objects.length === 0 ? (
            <p className="empty">No object has a track on {engineLabel(state.engine)} yet. Track some objects first.</p>
          ) : (
            <ul className="export-files">
              {objects.map((o, i) => (
                <li key={o.id}>
                  <span className="swatch" style={{background: o.color}} />
                  <code>
                    {names[i]}
                    {t.ext}
                  </code>
                  {o.state === 'stale' && <span className="badge stale">stale</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">
            From {engineLabel(state.engine)}: {session.modelOf(state.engine)}. The zip’s README.txt records it.
          </p>
          {busy && (
            <div className="export-progress">
              <span className="job-progress">
                <span style={{width: `${Math.round((session.exportProgress ?? 0) * 100)}%`}} />
              </span>
              {Math.round((session.exportProgress ?? 0) * 100)}%
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
          <button className="button primary" onClick={run} disabled={busy || objects.length === 0 || !session.meta.decoded}>
            {busy ? 'Exporting…' : 'Export zip'}
          </button>
        </div>
      </div>
    </div>
  );
}
