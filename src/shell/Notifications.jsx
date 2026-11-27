import { useEffect, useRef } from 'react';
import { Icon } from '../icons/Icon.jsx';
import { useStore } from '../core/store.js';
import { clearAll, dismiss, hideToast, markAllRead, notificationStore } from '../core/notifications.js';
import { executeCommand } from '../core/commands.js';
import { setSetting } from '../core/settings.js';

const SEV_ICON = { info: 'info', warning: 'warning', error: 'error' };

function Actions({ n, onDone }) {
  if (!n.actions.length) return null;
  return (
    <div className="toast__actions">
      {n.actions.map((a, i) => (
        <button
          key={i}
          type="button"
          className={`btn${i === 0 ? ' btn--primary' : ''}`}
          onClick={() => {
            if (a.command) executeCommand(a.command, a.args);
            onDone();
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

function Item({ n, onClose, closeLabel }) {
  return (
    <>
      <span className={`sev-${n.severity}`}>
        <Icon name={SEV_ICON[n.severity]} size={16} title={n.severity} />
      </span>
      <div>
        <div className="toast__title">
          {n.title}
          {n.count > 1 && <span className="badge toast__count">{n.count}</span>}
        </div>
        {n.message && <div className="toast__message">{n.message}</div>}
        <Actions n={n} onDone={() => dismiss(n.id)} />
      </div>
      <button type="button" className="btn btn--ghost btn--icon" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
        <Icon name="close" size={12} />
      </button>
    </>
  );
}

/** Pop-up notifications (bottom right). */
export function Toasts() {
  const toasts = useStore(notificationStore, (s) => s.items).filter((n) => n.toast);
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((n) => (
        <div key={n.id} className={`toast toast--${n.severity}`} role={n.severity === 'error' ? 'alert' : 'status'}>
          <Item n={n} onClose={() => hideToast(n.id)} closeLabel="Hide notification" />
        </div>
      ))}
    </div>
  );
}

/** Notification centre (history), opened from the status bar. */
export function NotificationCenter({ onClose }) {
  const { items, prefs } = useStore(notificationStore);
  const ref = useRef(null);

  useEffect(() => {
    markAllRead();
    ref.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (items.some((n) => !n.read)) markAllRead();
  }, [items]);

  return (
    <div className="notif-center" role="dialog" aria-label="Notification centre" tabIndex={-1} ref={ref}>
      <div className="notif-center__header">
        <span className="section-title">Notifications</span>
        <div className="notif-center__tools">
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-pressed={prefs.doNotDisturb}
            aria-label="Do not disturb"
            title={prefs.doNotDisturb ? 'Do not disturb is on' : 'Do not disturb'}
            onClick={() => setSetting('notifications.doNotDisturb', !prefs.doNotDisturb).catch(() => {})}
          >
            <Icon name={prefs.doNotDisturb ? 'bell-off' : 'bell'} size={14} />
          </button>
          <button type="button" className="btn btn--ghost btn--icon" aria-label="Clear all notifications" title="Clear all" onClick={clearAll} disabled={!items.length}>
            <Icon name="trash" size={14} />
          </button>
          <button type="button" className="btn btn--ghost btn--icon" aria-label="Close" title="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      <div className="notif-center__list">
        {items.length === 0 && <div className="empty-state">No notifications</div>}
        {items.map((n) => (
          <div key={n.id} className="notif-center__item">
            <Item n={n} onClose={() => dismiss(n.id)} closeLabel="Remove notification" />
            <time className="subtle notif-center__time" dateTime={new Date(n.ts).toISOString()}>
              {new Date(n.ts).toLocaleTimeString()} · {n.source}
            </time>
          </div>
        ))}
      </div>
    </div>
  );
}
