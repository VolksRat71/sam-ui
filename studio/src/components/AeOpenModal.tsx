// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Media > Open from After Effects (desktop app only): the footage in the open
// After Effects project, and the chosen item opened in place. Nothing is
// uploaded or re-encoded, so frame N here is frame N in After Effects. Items
// that would not line up (a proxy, Interpret Footage overrides, a missing
// file) are listed with the reason. The desktop app's main process does the
// talking; this page never reaches After Effects itself.
import {Renew} from '@carbon/icons-react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {type AeError, type AeMedia, type AeMediaItem, aeBridge} from '~/lib/desktop';
import {rememberUploadName} from '~/lib/uploadNames';
import {toVideoItem} from '~/media/useServerMedia';
import {bridgeNotice, describeItem} from '~/state/aeBridge';
import type {VideoItem} from '~/workspace/useStudioSession';

type Props = {onClose: () => void; onOpened: (video: VideoItem) => void};

/** A bridge failure, with the install (or update) link when that is the fix. */
export function AeNotice({error}: {error: AeError}) {
  const n = bridgeNotice(error);
  return (
    <div className="media-error" role="alert">
      {n.text}
      {n.link != null && (
        <>
          {' '}
          <a href={n.link.href} target="_blank" rel="noreferrer">
            {n.link.label}
          </a>
        </>
      )}
      {error.problems != null && error.problems.length > 1 && (
        <ul className="ae-problems">
          {error.problems.map(p => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function AeOpenModal({onClose, onOpened}: Props) {
  const ae = aeBridge();
  const [media, setMedia] = useState<AeMedia | null>(null);
  const [error, setError] = useState<AeError | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<number | null>(null);

  const list = useCallback(async () => {
    if (ae == null) {
      return;
    }
    setLoading(true);
    setError(null);
    const r = await ae.listMedia();
    setLoading(false);
    if (r.ok) {
      setMedia(r.value);
    } else {
      setMedia(null);
      setError(r.error);
    }
  }, [ae]);

  useEffect(() => {
    void list();
  }, [list]);

  // focus starts on Cancel, as in the other dialogs (ConfirmModal)
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && opening == null && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opening, onClose]);

  async function open(item: AeMediaItem) {
    if (ae == null) {
      return;
    }
    setOpening(item.id);
    setError(null);
    const r = await ae.open(item.id);
    setOpening(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const video = toVideoItem(r.value);
    rememberUploadName(video.path, item.name);
    onOpened(video);
  }

  const eligible = media?.items.filter(i => i.eligible).length ?? 0;
  const project = media?.project;

  return createPortal(
    <div className="modal-backdrop" onClick={() => opening == null && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="ae-open-title" onClick={e => e.stopPropagation()}>
        <h2 id="ae-open-title">Open from After Effects</h2>
        <div className="modal-body">
          <p>
            Footage from the open After Effects project, opened where it is: no upload and no re-encode, so every frame
            here is the same frame in After Effects.
          </p>
          {project != null && (
            <p className="muted small">
              Project: {project.name ?? 'untitled'}
              {project.dirty === true ? ' (unsaved changes)' : ''}
            </p>
          )}
          {loading && (
            <p className="muted">
              <span className="spinner" /> Asking After Effects…
            </p>
          )}
          {error != null && <AeNotice error={error} />}
          {media != null && media.items.length === 0 && (
            <p className="empty">This project has no video footage. Import some in After Effects, then list again.</p>
          )}
          {media != null && media.items.length > 0 && (
            <ul className="ae-items">
              {media.items.map(item => (
                <li key={item.id}>
                  <button
                    className="media-item ae-item"
                    disabled={!item.eligible || opening != null}
                    onClick={() => void open(item)}
                    title={item.eligible ? item.path : item.reason}>
                    <span className="media-name">{item.name}</span>
                    <span className="muted small">{describeItem(item)}</span>
                    {!item.eligible && <span className="ae-reason small">{item.reason}</span>}
                    {opening === item.id && (
                      <span className="muted small">
                        <span className="spinner" /> Opening…
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {media != null && media.items.length > 0 && eligible === 0 && (
            <p className="muted small">None of this footage can be opened as it is; each item says why.</p>
          )}
        </div>
        <div className="modal-actions">
          <button className="button subtle" onClick={() => void list()} disabled={loading || opening != null}>
            <Renew size={16} /> List again
          </button>
          <button ref={cancelRef} className="button" onClick={onClose} disabled={opening != null}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
