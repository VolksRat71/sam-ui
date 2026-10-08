// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Confirms deleting an uploaded video, in-app (never window.confirm). It
// names what goes: the video file, and its objects and cached tracks unless
// "also delete its tracks" is unticked. Footage opened from After Effects is
// only removed from sam-ui: the file itself stays. A refusal from the backend
// (the video is open in another tab, say) is shown here, and nothing is lost.
import {useEffect, useRef, useState} from 'react';
import {explainGraphQLError} from '~/lib/errors';
import {isAeVideo} from '~/state/aeBridge';
import type {VideoItem} from '~/workspace/useStudioSession';

type Props = {
  video: VideoItem;
  isOpen: boolean;
  onDelete: (video: VideoItem, purgeTracks: boolean) => Promise<void>;
  onClose: () => void;
};

export default function DeleteVideoModal({video, isOpen, onDelete, onClose}: Props) {
  const [purge, setPurge] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const name = video.path.split('/').pop() ?? video.path;
  const linked = isAeVideo(video.path);
  const verb = linked ? 'Remove' : 'Delete';

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onDelete(video, purge);
      onClose();
    } catch (err) {
      setError(explainGraphQLError(err instanceof Error ? err.message : String(err)));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        onClick={e => e.stopPropagation()}>
        <h2 id="delete-title">{linked ? 'Remove this footage from sam-ui?' : 'Delete this upload?'}</h2>
        <div className="modal-body">
          <p>
            {purge ? (
              <>
                This {verb.toLowerCase()}s the video <code>{name}</code> <strong>and its objects, clicks and cached tracks</strong>.
              </>
            ) : (
              <>
                This {verb.toLowerCase()}s the video <code>{name}</code> only. <strong>Its objects, clicks and cached tracks
                are kept</strong> on the backend.
              </>
            )}{' '}
            It cannot be undone.
          </p>
          {linked && <p className="muted">The footage file itself is not touched (After Effects keeps using it); only sam-ui's link to it goes.</p>}
          {isOpen && <p className="muted">It is open now: its session closes first, and studio moves to another video.</p>}
          <label className="check">
            <input type="checkbox" checked={purge} onChange={e => setPurge(e.target.checked)} disabled={busy} /> Also
            delete its tracks
          </label>
          {error != null && <div className="media-error">Not deleted: {error}</div>}
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} className="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="button danger" onClick={confirm} disabled={busy}>
            {busy ? (
              <>
                <span className="spinner small" /> Deleting…
              </>
            ) : purge ? (
              `${verb} video and tracks`
            ) : (
              `${verb} video, keep tracks`
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
