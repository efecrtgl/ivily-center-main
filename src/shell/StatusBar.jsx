import { useCallback } from 'react';
import { Icon } from '../icons/Icon.jsx';
import { useStore } from '../core/store.js';
import { notificationStore, unreadCount } from '../core/notifications.js';
import { themeStore } from '../theme/engine.js';
import { appStore } from '../app/appStore.js';
import { NotificationCenter } from './Notifications.jsx';
import { ThemePicker } from './ThemePicker.jsx';
import { statusUi, setStatusPopover } from './statusUi.js';

export function StatusBar() {
  const unread = useStore(notificationStore, unreadCount);
  const dnd = useStore(notificationStore, (s) => s.prefs.doNotDisturb);
  const themeName = useStore(themeStore, (s) => s.current?.name ?? '');
  const storage = useStore(appStore, (s) => s.info?.database.mode);
  const popover = useStore(statusUi, (s) => s.popover);
  const close = useCallback(() => setStatusPopover(null), []);

  return (
    <footer className="statusbar" aria-label="Status bar">
      <div className="statusbar__group">
        {storage === 'memory' && (
          <span className="statusbar__item statusbar__item--warning" title="Settings and state are not being saved this session. See notifications for details.">
            <Icon name="warning" size={13} /> Not saving
          </span>
        )}
      </div>
      <div className="statusbar__group">
        <button
          type="button"
          className="statusbar__item"
          aria-haspopup="menu"
          aria-expanded={popover === 'theme'}
          title="Change theme"
          onClick={() => setStatusPopover(popover === 'theme' ? null : 'theme')}
        >
          <Icon name="palette" size={13} /> {themeName}
        </button>
        <button
          type="button"
          className="statusbar__item"
          aria-haspopup="dialog"
          aria-expanded={popover === 'notifications'}
          aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
          title={dnd ? 'Notifications (do not disturb)' : 'Notifications'}
          onClick={() => setStatusPopover(popover === 'notifications' ? null : 'notifications')}
        >
          <Icon name={dnd ? 'bell-off' : 'bell'} size={13} />
          {unread > 0 && <span className="badge">{unread}</span>}
        </button>
      </div>
      {popover === 'theme' && <ThemePicker onClose={close} />}
      {popover === 'notifications' && <NotificationCenter onClose={close} />}
    </footer>
  );
}
