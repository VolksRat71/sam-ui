// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Export tracked objects as a rotoscoping working folder: an in-app panel
// with one row per tracked object (product id, prompt, colour) and the
// include-stale option. With a backend and a server engine the backend
// writes the folder (POST /export: a folder under its export root, with the
// extract-frames and overwrite options) and shows its manifest. For browser
// tracks, or with no backend, studio builds the same layout here and saves
// it as a zip. Either way the products follow the Objects list's order, and
// each group gets a folder, with a union matte if asked (issue #21).
import {Close} from '@carbon/icons-react';
import {useEffect, useMemo, useState} from 'react';
import {readJson, writeJson} from '~/lib/storage';
import {
  defaultRows,
  exportProblems,
  selectedRows,
  toExportObjects,
  type ExportRow,
} from '~/state/exportForm';
import type {ExportManifest} from '~/worker/protocol';
import {saveBlob} from '~/lib/download';
import {defaultExportName, exportFileName} from '~/state/fileNames';
import type {StudioSessionApi} from '~/workspace/useStudioSession';
import FileNameField from './FileNameField';

const FOLDER_KEY = 'sam-ui-studio:export-folder';

/** server: the backend writes a folder; zip: studio builds it and downloads a zip. */
export type RotoExportMode = 'server' | 'zip';

type Props = {session: StudioSessionApi; videoName: string; mode: RotoExportMode; onClose: () => void};

export default function ExportPanel({session, videoName, mode, onClose}: Props) {
  const {bridge, state} = session;
  const base = videoName.replace(/\.[^.]+$/, '');
  const [outDir, setOutDir] = useState(() => readJson(FOLDER_KEY, `~/Movies/sam-ui/${base}`));
  const [rows, setRows] = useState<ExportRow[]>(() => defaultRows(session.ordered));
  const [includeStale, setIncludeStale] = useState(false);
  const [union, setUnion] = useState(false);
  const hasGroups = state.layout.groups.some(g => g.members.length > 0);
  const [frames, setFrames] = useState(false);
  const [force, setForce] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ExportManifest | null>(null);
  const zipFallback = defaultExportName(videoName, 'roto');
  const [file, setFile] = useState(zipFallback);
  const [saved, setSaved] = useState<{name: string; size: number} | null>(null);
  const zipping = mode === 'zip';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !sending && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, sending]);

  const stateOf = (id: number) => state.objects.find(o => o.id === id)?.state;
  const chosen = selectedRows(rows, stateOf, includeStale);
  const problems = useMemo(
    () => exportProblems(chosen, {outDir: zipping ? file : outDir, includeStale, frames, force}),
    [chosen, outDir, file, zipping, includeStale, frames, force],
  );

  const setRow = (objectId: number, patch: Partial<ExportRow>) =>
    setRows(rs => rs.map(r => (r.objectId === objectId ? {...r, ...patch} : r)));

  async function submit() {
    if (bridge == null || problems.length > 0) {
      return;
    }
    setSending(true);
    setError(null);
    if (zipping) {
      try {
        const blob = await session.exportMasks(
          'folder',
          chosen.map(r => ({objectId: r.objectId, name: r.id, prompt: r.prompt.trim() || r.id.replace(/_/g, ' '), color: r.color})),
          union && hasGroups,
        );
        const name = exportFileName(file, zipFallback, '.zip');
        saveBlob(blob, name);
        setSaved({name, size: blob.size});
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
      }
      return;
    }
    writeJson(FOLDER_KEY, outDir);
    try {
      setManifest(
        await bridge.call('export', {
          engine: state.engine,
          out_dir: outDir.trim(),
          objects: toExportObjects(chosen),
          include_stale: includeStale,
          frames,
          force,
          union: union && hasGroups,
          // the review flags join the audit queue in data/review.json
          flags: Object.fromEntries(Object.entries(session.flags)),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !sending && onClose()}>
      <div
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="export-title">Export for rotoscoping</h2>
          <button className="icon-button" onClick={onClose} disabled={sending} title="Close">
            <Close size={18} />
          </button>
        </div>

        {manifest == null ? (
          <>
            {zipping ? (
              <FileNameField value={file} onChange={setFile} disabled={sending} hint="a zip of the working folder" />
            ) : (
              <label className="field">
                <span>Folder (under the backend&apos;s export root, ~/Movies/sam-ui by default)</span>
                <input value={outDir} onChange={e => setOutDir(e.target.value)} spellCheck={false} />
              </label>
            )}

            {rows.length === 0 ? (
              <p className="empty">No object has a track yet. Track some objects first.</p>
            ) : (
              <table className="export-table">
                <thead>
                  <tr>
                    <th />
                    <th>Object</th>
                    <th>Product id</th>
                    <th>Prompt</th>
                    <th>Colour</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const st = stateOf(r.objectId);
                    const off = st === 'stale' && !includeStale;
                    return (
                      <tr key={r.objectId} className={off ? 'off' : undefined}>
                        <td>
                          <input
                            type="checkbox"
                            checked={r.include && !off}
                            disabled={off}
                            onChange={e => setRow(r.objectId, {include: e.target.checked})}
                            aria-label={`Export object ${r.objectId + 1}`}
                          />
                        </td>
                        <td>
                          Object {r.objectId + 1} <span className={`badge ${st}`}>{st}</span>
                        </td>
                        <td>
                          <input value={r.id} onChange={e => setRow(r.objectId, {id: e.target.value})} spellCheck={false} />
                        </td>
                        <td>
                          <input value={r.prompt} onChange={e => setRow(r.objectId, {prompt: e.target.value})} />
                        </td>
                        <td>
                          <input type="color" value={r.color} onChange={e => setRow(r.objectId, {color: e.target.value})} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <div className="export-options">
              <label>
                <input type="checkbox" checked={includeStale} onChange={e => setIncludeStale(e.target.checked)} />{' '}
                Include stale tracks
              </label>
              {hasGroups && (
                <label>
                  <input type="checkbox" checked={union} onChange={e => setUnion(e.target.checked)} /> One union matte per
                  group too (data/groups/&lt;group&gt;/union)
                </label>
              )}
              {!zipping && (
                <>
                  <label>
                    <input type="checkbox" checked={frames} onChange={e => setFrames(e.target.checked)} /> Extract frames
                    (clip.mp4 and one JPEG per frame)
                  </label>
                  <label>
                    <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} /> Replace existing
                    products.json, anchors.json, shots.json and mattes
                  </label>
                </>
              )}
            </div>

            {problems.length > 0 && rows.length > 0 && (
              <ul className="export-problems">
                {problems.map(p => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            {saved != null && (
              <p className="muted">
                Saved {saved.name} ({(saved.size / 1e6).toFixed(1)} MB).
              </p>
            )}
            {zipping && session.exportProgress != null && (
              <div className="export-progress">
                <span className="job-progress">
                  <span style={{width: `${Math.round(session.exportProgress * 100)}%`}} />
                </span>
                {Math.round(session.exportProgress * 100)}%
              </div>
            )}
            {error != null && <div className="media-error">Export refused: {error}</div>}

            <div className="modal-actions">
              <button className="button" onClick={onClose} disabled={sending}>
                Cancel
              </button>
              <button className="button primary" onClick={submit} disabled={sending || problems.length > 0}>
                {sending ? (
                  <>
                    <span className="spinner small" /> Exporting…
                  </>
                ) : (
                  `Export ${chosen.length} ${chosen.length === 1 ? 'object' : 'objects'}`
                )}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="modal-body">
              Wrote <code>{manifest.out_dir}</code>, {manifest.n_frames} frames per matte
              {manifest.frames_extracted ? `, ${manifest.frames_on_disk ?? '?'} frames extracted` : ''}.
            </p>
            <ul className="manifest-list">
              {Object.entries(manifest.products).map(([pid, p]) => (
                <li key={pid}>
                  <strong>{pid}</strong> from Object {p.object_id + 1} ({p.state}, {p.n_frames} frames)
                </li>
              ))}
              {Object.entries(manifest.skipped).map(([id, why]) => (
                <li key={`skip-${id}`} className="muted">
                  Object {Number(id) + 1} skipped: {why}
                </li>
              ))}
            </ul>
            {manifest.warning != null && <div className="object-hint">{manifest.warning}</div>}
            <div className="modal-actions">
              <button className="button" onClick={() => setManifest(null)}>
                Export again
              </button>
              <button className="button primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
