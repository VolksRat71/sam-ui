// sam-ui (Apache-2.0). New file, not from SAM 2.
import {useEffect, useRef, type ReactNode} from 'react';

type Props = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** An in-app confirmation (never window.confirm). Esc or the backdrop cancels. */
export default function ConfirmModal({title, children, confirmLabel, danger, onConfirm, onCancel}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onClick={e => e.stopPropagation()}>
        <h2 id="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">
          <button ref={cancelRef} className="button" onClick={onCancel}>
            Cancel
          </button>
          <button className={danger ? 'button danger' : 'button primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
