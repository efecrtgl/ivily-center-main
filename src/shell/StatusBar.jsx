import { useCallback } from 'react';
import { Icon } from '../icons/Icon.jsx';
import { useStore } from '../core/store.js';
import { notificationStore, unreadCount } from '../core/notifications.js';
import { themeStore } from '../theme/engine.js';
import { appStore } from '../app/appStore.js';
import { NotificationCenter } from './Notifications.jsx';
import { ThemePicker } from './ThemePicker.jsx';
import { statusUi, setStatusPopover } from './statusUi.js';
import { showPage, workspaceStore } from '../workspace/store.js';
import { LEVEL_LABEL } from '../workspace/trust.js';
import { EditorStatus } from '../features/editor/EditorStatus.jsx';
import { activeRepo, checkout as gitCheckout, gitStore } from '../features/git/model.js';

export function StatusBar() {
  const unread = useStore(notificationStore, unreadCount);
  const dnd = useStore(notificationStore, (s) => s.prefs.doNotDisturb);
  const themeName = useStore(themeStore, (s) => s.current?.name ?? '');
  const storage = useStore(appStore, (s) => s.info?.database.mode);
  const popover = useStore(statusUi, (s) => s.popover);
  const close = useCallback(() => setStatusPopover(null), []);
  const ws = useStore(workspaceStore, (s) => s.current);
  const gitStatus = useStore(gitStore, (s) => { const r = s.repos.find((x) => x.top); return r ? s.status[r.root] : null; });

  return (
    <footer className="statusbar" aria-label="Status bar">
      <div className="statusbar__group">
        {ws && (
          <button type="button" className="statusbar__item" title={`${ws.record.path}
Click to show the launcher`} onClick={() => showPage('launcher')}>
            <Icon name={ws.record.kind === 'file' ? 'workspace' : 'folder'} size={13} /> {ws.record.name}
          </button>
        )}
        {ws && (
          <button
            type="button"
            className={`statusbar__item statusbar__item--trust-${ws.trust.level}`}
            title="Workspace Trust — click to manage"
            onClick={() => showPage('trust')}
          >
            <Icon name={ws.trust.level === 'trusted' ? 'shield-check' : 'shield'} size={13} /> {LEVEL_LABEL[ws.trust.level]}
          </button>
        )}
        {gitStatus && (
          <button type="button" className="statusbar__item" title="Switch branch" onClick={() => { const r = activeRepo(); if (r) gitCheckout(r.root); }}>
            <Icon name="git" size={13} /> {gitStatus.branch ?? gitStatus.head?.slice(0, 8) ?? '…'}
            {gitStatus.files.length > 0 ? '*' : ''}
            {(gitStatus.ahead > 0 || gitStatus.behind > 0) && <span className="subtle"> ↓{gitStatus.behind} ↑{gitStatus.ahead}</span>}
          </button>
        )}
        {storage === 'memory' && (
          <span className="statusbar__item statusbar__item--warning" title="Settings and state are not being saved this session. See notifications for details.">
            <Icon name="warning" size={13} /> Not saving
          </span>
        )}
      </div>
      <div className="statusbar__group">
        <EditorStatus />
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
