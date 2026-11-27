import { Suspense, lazy } from 'react';
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
import { LauncherView } from '../features/launcher/LauncherView.jsx';
import { TrustDialog } from '../features/trust/TrustDialog.jsx';
import { RestrictedBanner } from '../features/trust/RestrictedBanner.jsx';
import { ConfirmDialog } from './ConfirmDialog.jsx';
import { ContextMenu } from './ContextMenu.jsx';
import { QuickPick } from './QuickPick.jsx';
import { EditorArea } from '../features/editor/EditorArea.jsx';
import { editorStore } from '../features/editor/model.js';
import { showPage } from '../workspace/store.js';
import { workspaceStore } from '../workspace/store.js';

// Pages that are not needed at startup load on first use.
const TrustManagerView = lazy(() => import('../features/trust/TrustManagerView.jsx').then((m) => ({ default: m.TrustManagerView })));
const ToolsView = lazy(() => import('../features/tools/ToolsView.jsx').then((m) => ({ default: m.ToolsView })));
const DiffView = lazy(() => import('../features/git/DiffView.jsx').then((m) => ({ default: m.DiffView })));
const KeybindingsView = lazy(() => import('../features/keybindings/KeybindingsView.jsx').then((m) => ({ default: m.KeybindingsView })));
const PreviewView = lazy(() => import('../features/preview/PreviewView.jsx').then((m) => ({ default: m.PreviewView })));
const ModulesView = lazy(() => import('../features/modules/ModulesView.jsx').then((m) => ({ default: m.ModulesView })));
const UpdatesView = lazy(() => import('../features/update/UpdatesView.jsx').then((m) => ({ default: m.UpdatesView })));
const BackupsView = lazy(() => import('../features/backup/BackupsView.jsx').then((m) => ({ default: m.BackupsView })));


const PAGES = { launcher: LauncherView, trust: TrustManagerView, welcome: WelcomeView, tools: ToolsView, diff: DiffView, keybindings: KeybindingsView, preview: PreviewView, modules: ModulesView, updates: UpdatesView, backups: BackupsView };

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
  const page = useStore(workspaceStore, (s) => s.page);
  const Page = PAGES[page] ?? WelcomeView;
  const hasEditors = useStore(editorStore, (s) => s.groups.some((g) => g.tabs.length > 0));
  const showEditors = page === 'editor' && hasEditors;

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
                <Suspense fallback={null}>
                  <SidebarView />
                </Suspense>
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
            <RestrictedBanner />
            {showEditors ? (
              <EditorArea />
            ) : (
              <div className="editor-area__page">
                {hasEditors && (
                  <button type="button" className="btn btn--ghost editor-area__back" onClick={() => showPage('editor')}>
                    ← Back to editors
                  </button>
                )}
                <Suspense fallback={<div className="subtle page-loading">Loading…</div>}>
                  <Page />
                </Suspense>
              </div>
            )}
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
      <TrustDialog />
      <ConfirmDialog />
      <ContextMenu />
      <QuickPick />
    </div>
  );
}
