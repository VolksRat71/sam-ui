// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Export > Export to After Effects (desktop app only, for a video opened from
// After Effects). Studio traces every tracked object's outlines (the Vector
// JSON export), and the desktop app's main process builds a new comp from
// them: the footage at its own size and rate, one layer per object named
// after it, its outlines as mask keys. Before writing anything it lists the
// footage again, and stops if the item, its file, size, rate or frame count
// moved since the video was opened here.
import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {type AeError, type AeExportResult, type AeSourceRecord, aeBridge} from '~/lib/desktop';
import {describeItem, vectorsFromZip} from '~/state/aeBridge';
import {engineLabel} from '~/state/engines';
import {objectName} from '~/state/fileNames';
import type {VideoItem} from '~/workspace/useStudioSession';
import type {StudioSessionApi} from '~/workspace/useStudioSession';
import {AeNotice} from './AeOpenModal';

type Props = {session: StudioSessionApi; video: VideoItem; onClose: () => void};
type Phase = 'idle' | 'tracing' | 'writing';

export default function AeExportModal({session, video, onClose}: Props) {
  const ae = aeBridge();
  // undefined while it is read; null for a video that was not opened from After Effects
  const [record, setRecord] = useState<AeSourceRecord | null | undefined>(undefined);
  const [error, setError] = useState<AeError | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<{fraction: number; label: string} | null>(null);
  const [done, setDone] = useState<AeExportResult | null>(null);
  const {state, meta} = session;
  const objects = state.objects.filter(o => o.state === 'tracked' || o.state === 'stale');
  const busy = phase !== 'idle';

  useEffect(() => {
    if (ae == null) {
      return;
    }
    let live = true;
    void ae.sourceOf(video.path).then(r => {
      if (!live) {
        return;
      }
      if (r.ok) {
        setRecord(r.value);
        if (r.value == null) {
          setError({state: 'not-from-ae', message: 'This video was not opened from After Effects. Use Media > Open from After Effects.'});
        }
      } else {
        setRecord(null);
        setError(r.error);
      }
    });
    return () => {
      live = false;
    };
  }, [ae, video.path]);

  // focus starts on Cancel, as in the other dialogs (ConfirmModal)
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function run() {
    if (ae == null) {
      return;
    }
    setError(null);
    setDone(null);
    setPhase('tracing');
    let unsubscribe: (() => void) | null = null;
    try {
      const blob = await session.exportMasks('vectors');
      const vectors = vectorsFromZip(new Uint8Array(await blob.arrayBuffer()));
      setPhase('writing');
      setProgress(null);
      unsubscribe = ae.onProgress(setProgress);
      const r = await ae.exportRoto({
        videoPath: video.path,
        objects: vectors,
        studio: {frames: meta.numFrames, width: meta.width, height: meta.height},
      });
      if (r.ok) {
        setDone(r.value);
      } else {
        setError(r.error);
      }
    } catch (err) {
      setError({state: 'studio', message: err instanceof Error ? err.message : String(err)});
    } finally {
      unsubscribe?.();
      setPhase('idle');
    }
  }

  const source = record?.source;
  const pct = phase === 'tracing' ? (session.exportProgress ?? 0) : (progress?.fraction ?? 0);

  return createPortal(
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="ae-export-title" onClick={e => e.stopPropagation()}>
        <h2 id="ae-export-title">Export to After Effects</h2>
        <div className="modal-body">
          <p>
            A new comp in the open project, at the footage’s own size and frame rate: the footage once at the bottom as a
            guide layer, and once per object above it, masked by its outlines on every frame. Nothing already in the
            project is changed.
          </p>
          {source != null && (
            <p className="muted small">
              From <strong>{source.name}</strong> in {source.aeProjectPath ?? 'an untitled project'}: {describeItem(source)}.
            </p>
          )}
          {record === undefined && ae != null && <p className="muted small">Reading where this video came from…</p>}
          <ul className="export-files">
            {objects.map(o => (
              <li key={o.id}>
                <span className="swatch" style={{background: o.color}} />
                <span>{objectName(o)}</span>
                {o.state === 'stale' && <span className="badge stale">stale</span>}
              </li>
            ))}
          </ul>
          <p className="muted small">
            Outlines from {engineLabel(state.engine)}: {session.modelOf(state.engine)}.
          </p>
          {busy && (
            <div className="export-progress">
              <span className="job-progress">
                <span style={{width: `${Math.round(pct * 100)}%`}} />
              </span>
              {phase === 'tracing' ? 'Tracing outlines' : (progress?.label ?? 'Checking the footage in After Effects')}
            </div>
          )}
          {done != null && (
            <p className="muted">
              Built “{done.compName}”: {done.layers} {done.layers === 1 ? 'layer' : 'layers'}, {done.masks}{' '}
              {done.masks === 1 ? 'mask' : 'masks'}. Save the project in After Effects to keep it.
            </p>
          )}
          {error != null && <AeNotice error={error} />}
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} className="button" onClick={onClose} disabled={busy}>
            {done != null ? 'Close' : 'Cancel'}
          </button>
          <button
            className="button primary"
            onClick={() => void run()}
            disabled={busy || ae == null || record == null || objects.length === 0 || !meta.decoded}>
            {busy ? 'Exporting…' : 'Build the comp'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
