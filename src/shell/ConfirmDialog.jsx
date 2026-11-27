import { useEffect, useRef } from 'react';
import { useStore } from '../core/store.js';
import { answerDialog, dialogStore } from '../core/dialogs.js';

/** Host for confirmation dialogs. Escape and the backdrop cancel; the safe option has focus. */
export function ConfirmDialog() {
  const req = useStore(dialogStore, (s) => s.queue[0]);
  const cancelRef = useRef(null);

  useEffect(() => {
    if (!req) return;
    cancelRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        answerDialog(req.id, false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [req]);

  if (!req) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && answerDialog(req.id, false)}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <h2 id="confirm-title">{req.title}</h2>
        {req.message && <p id="confirm-message" className="muted">{req.message}</p>}
        {req.detail && <p className="mono modal__detail">{req.detail}</p>}
        <div className="modal__actions">
          <button type="button" ref={cancelRef} className="btn" onClick={() => answerDialog(req.id, false)}>
            {req.cancelLabel ?? 'Cancel'}
          </button>
          <button type="button" className={`btn ${req.danger ? 'btn--danger' : 'btn--primary'}`} onClick={() => answerDialog(req.id, true)}>
            {req.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
