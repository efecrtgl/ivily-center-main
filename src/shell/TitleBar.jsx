import { useEffect, useState } from 'react';
import { Icon } from '../icons/Icon.jsx';
import { useStore } from '../core/store.js';
import { titleStore, APP_TITLE } from '../core/title.js';
import { executeCommand } from '../core/commands.js';
import { onMaximizeChange } from '../platform/window.js';

/**
 * Custom title bar. The whole bar is a drag region ("deep"); buttons are clickable elements,
 * which Tauri's drag script excludes automatically, so controls never start a window drag.
 * Double-clicking the bar toggles maximize (handled by Tauri for drag regions).
 */
export function TitleBar() {
  const t = useStore(titleStore);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => onMaximizeChange(setMaximized), []);

  const context = t.file ? `${t.dirty ? '● ' : ''}${t.file}${t.workspace ? ` — ${t.workspace}` : ''}` : t.workspace || 'No folder open';

  return (
    <header className="titlebar" data-tauri-drag-region="deep" data-maximized={maximized || undefined}>
      <div className="titlebar__brand">
        <svg className="titlebar__logo" viewBox="0 0 1024 1024" aria-hidden="true">
          <rect x="96" y="96" width="832" height="832" rx="176" fill="none" stroke="currentColor" strokeWidth="72" />
          <rect x="452" y="290" width="120" height="444" rx="40" fill="currentColor" />
        </svg>
        <span>{APP_TITLE}</span>
      </div>
      <div className="titlebar__title" title={context}>
        {context}
      </div>
      <div className="titlebar__controls" role="group" aria-label="Window controls">
        <button type="button" className="wc-btn" aria-label="Minimize" title="Minimize" onClick={() => executeCommand('window.minimize')}>
          <Icon name="minimize" size={14} />
        </button>
        <button
          type="button"
          className="wc-btn"
          aria-label={maximized ? 'Restore' : 'Maximize'}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={() => executeCommand('window.toggleMaximize')}
        >
          <Icon name={maximized ? 'restore' : 'maximize'} size={14} />
        </button>
        <button type="button" className="wc-btn wc-btn--close" aria-label="Close" title="Close" onClick={() => executeCommand('window.close')}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </header>
  );
}
