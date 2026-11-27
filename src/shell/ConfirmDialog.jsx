import { useEffect, useRef, useState } from 'react';
import { useStore } from '../core/store.js';
import { answerDialog, dialogStore } from '../core/dialogs.js';

/** Host for confirmation, choice and input dialogs. Escape and the backdrop dismiss. */
export function ConfirmDialog() {
  const req = useStore(dialogStore, (s) => s.queue[0]);
  const firstRef = useRef(null);
  const inputRef = useRef(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!req) return;
    setValue(req.input?.value ?? '');
    setError(null);
    (req.input ? inputRef.current : firstRef.current)?.focus();
    inputRef.current?.select?.();
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

  const choose = (id) => {
    if (!req.input) return answerDialog(req.id, id);
    if (id !== 'ok') return answerDialog(req.id, null);
    const v = value.trim();
    const err = !v ? 'Enter a value' : (req.input.validate?.(v) ?? null);
    if (err) return setError(err);
    // Input dialogs resolve to the value; answerDialog passes it through.
    answerDialog(req.id, v);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && answerDialog(req.id, null)}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <h2 id="confirm-title">{req.title}</h2>
        {req.message && <p id="confirm-message" className="muted">{req.message}</p>}
        {req.detail && <p className="mono modal__detail">{req.detail}</p>}
        {req.input && (
          <div className="modal__input">
            <input
              ref={inputRef}
              className="input"
              aria-label={req.title}
              aria-invalid={Boolean(error)}
              placeholder={req.input.placeholder}
              value={value}
              spellCheck={false}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && choose('ok')}
            />
            {error && <div className="sev-error modal__error" role="alert">{error}</div>}
          </div>
        )}
        <div className="modal__actions">
          {req.choices.map((c, i) => (
            <button
              key={c.id}
              type="button"
              ref={i === 0 ? firstRef : undefined}
              className={`btn${c.danger ? ' btn--danger' : c.primary ? ' btn--primary' : ''}`}
              onClick={() => choose(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
