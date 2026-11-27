import { useStore } from '../core/store.js';
import { viewStore, viewsAt } from '../core/views.js';
import { LIMITS, layoutStore, updateLayout } from '../core/layout.js';
import { TitleBar } from './TitleBar.jsx';
import { ActivityBar } from './ActivityBar.jsx';
import { Panel } from './Panel.jsx';
import { StatusBar } from './StatusBar.jsx';
import { Splitter } from './Splitter.jsx';
import { Toasts } from './Notifications.jsx';
import { WelcomeView } from '../features/welcome/WelcomeView.jsx';

/**
 * Workbench layout:
 *   title bar
 *   activity bar | sidebar | splitter | editor area
 *                |         |          | splitter / panel
 *   status bar
 */
export function Workbench() {
  const layout = useStore(layoutStore);
  const views = useStore(viewStore);
  const sidebarViews = viewsAt(views, 'sidebar');
  const sidebar = sidebarViews.find((v) => v.id === layout.sidebarView) || sidebarViews[0];
  const SidebarView = sidebar?.component;

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="workbench">
        <ActivityBar />
        {layout.sidebarVisible && sidebar && (
          <>
            <aside className="sidebar" style={{ width: layout.sidebarWidth }} aria-label={sidebar.title}>
              <div className="sidebar__header section-title">{sidebar.title}</div>
              <div className="sidebar__body">
                <SidebarView />
              </div>
            </aside>
            <Splitter
              orientation="vertical"
              label="Resize side bar"
              value={layout.sidebarWidth}
              min={LIMITS.sidebarWidth[0]}
              max={LIMITS.sidebarWidth[1]}
              onChange={(v) => updateLayout({ sidebarWidth: v })}
            />
          </>
        )}
        <div className="main-column">
          <main className="editor-area" aria-label="Editor area">
            <WelcomeView />
          </main>
          {layout.panelVisible && (
            <>
              <Splitter
                orientation="horizontal"
                label="Resize panel"
                invert
                value={layout.panelHeight}
                min={LIMITS.panelHeight[0]}
                max={LIMITS.panelHeight[1]}
                onChange={(v) => updateLayout({ panelHeight: v })}
              />
              <div className="panel-slot" style={{ height: layout.panelHeight }}>
                <Panel />
              </div>
            </>
          )}
        </div>
      </div>
      <StatusBar />
      <Toasts />
    </div>
  );
}
