import { useEffect, useRef } from 'react';
import { useStore } from '../core/store.js';
import { answerDialog, dialogStore } from '../core/dialogs.js';

/** Host for confirmation/choice dialogs. Escape and the backdrop dismiss; the first choice has focus. */
export function ConfirmDialog() {
  const req = useStore(dialogStore, (s) => s.queue[0]);
  const firstRef = useRef(null);

  useEffect(() => {
    if (!req) return;
    firstRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        answerDialog(req.id, null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [req]);

  if (!req) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && answerDialog(req.id, null)}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <h2 id="confirm-title">{req.title}</h2>
        {req.message && <p id="confirm-message" className="muted">{req.message}</p>}
        {req.detail && <p className="mono modal__detail">{req.detail}</p>}
        <div className="modal__actions">
          {req.choices.map((c, i) => (
            <button
              key={c.id}
              type="button"
              ref={i === 0 ? firstRef : undefined}
              className={`btn${c.danger ? ' btn--danger' : c.primary ? ' btn--primary' : ''}`}
              onClick={() => answerDialog(req.id, c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
