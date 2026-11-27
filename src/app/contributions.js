// Built-in workbench contributions: views, commands and default keybindings.
// Features contribute through the same registries that extensions will use later.
import { registerCommand } from '../core/commands.js';
import { registerDefaultKeybindings } from '../core/keybindings.js';
import { registerView } from '../core/views.js';
import { layoutStore, showPanelView, toggleSidebarView, updateLayout } from '../core/layout.js';
import { clearAll } from '../core/notifications.js';
import { notificationStore } from '../core/notifications.js';
import { clearChannel } from '../core/output.js';
import { getSetting, setSetting } from '../core/settings.js';
import { listThemes } from '../theme/engine.js';
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from '../platform/window.js';
import { setStatusPopover, statusUi } from '../shell/statusUi.js';
import { selectTheme } from '../shell/ThemePicker.jsx';
import {
  closeWorkspace, openFolder, openWorkspaceFile, reloadWorkspaceFile, saveWorkspaceAs, showPage, toggleCurrentFavorite, workspaceStore,
} from '../workspace/store.js';
import { ExplorerView } from '../features/explorer/ExplorerView.jsx';
import { baseName, collapseAll, explorerStore, keyOf, parentKeyOf, parseKey, refreshAll, startCreate } from '../features/explorer/model.js';
import { SettingsView } from '../features/settings/SettingsView.jsx';
import {
  activeEditor, activateTab, closeAllEditors, closeTab, editorStore, focusGroup, newUntitled, openFileDialog, reopenClosed, revertDocument,
  saveAll, saveDocument, splitEditor,
} from '../features/editor/model.js';
import { pickEncoding, pickEol, pickLanguage } from '../features/editor/EditorStatus.jsx';
import { findReferences, formatDocument, jumpToDefinition, jumpToImplementation, jumpToTypeDefinition, renameSymbol } from '@codemirror/lsp-client';
import { restartServers } from '../features/lsp/manager.js';
import { TerminalView } from '../features/terminal/TerminalView.jsx';
import { ScmView } from '../features/git/ScmView.jsx';
import { SearchView } from '../features/search/SearchView.jsx';
import { checkForUpdates } from '../features/update/model.js';
import { ExtensionsView } from '../features/extensions/ExtensionsView.jsx';
import { installExtension } from '../features/extensions/model.js';
import { DebugConsoleView, DebugView } from '../features/debug/DebugView.jsx';
import {
  configureLaunch, continueExecution, pauseExecution, removeAllBreakpoints, restartDebugging, revokeDebugApprovals, startDebugging, stepInto, stepOut, stepOver, stopDebugging,
  toggleBreakpoint,
} from '../features/debug/model.js';
import { NotesView } from '../features/notes/NotesView.jsx';
import { openPreview } from '../features/preview/PreviewView.jsx';
import { clearBookmarks, goToBookmark, listBookmarks, toggleBookmark } from '../features/bookmarks/model.js';
import { ProblemsView, goToProblem } from '../features/problems/ProblemsView.jsx';
import { exportOutputChannel } from '../features/output/OutputView.jsx';
import { exportCurrentTheme, exportSettings, importIconPack, importSettings, importTheme, removeUserItem } from '../features/customize/model.js';
import { configureTasks, pickAndRun, pickAndTerminate, rerunLast, revokeApprovals as revokeTaskApprovals, showHistory as showTaskHistory } from '../features/tasks/model.js';
import { searchStore } from '../features/search/model.js';
import { openCommandPalette, openQuickOpen } from '../features/palette/quickOpen.js';
import { activeRepo, checkout as gitCheckout, cloneRepository, createBranch as gitCreateBranch, loadRepos, stashPush, sync as gitSync } from '../features/git/model.js';
import { outputUi as outputPanelUi } from '../features/output/OutputView.jsx';
import { activeTerminalId, clearTerminal, createTerminal, killTerminal, newTerminalWithProfile, splitTerminal, terminalStore } from '../features/terminal/model.js';

/** Show the Search view, seeded with the editor selection (single line) when there is one. */
function showSearch(replace) {
  const ed = activeEditor();
  const sel = ed?.view?.state.selection.main;
  const text = sel && !sel.empty ? ed.view.state.sliceDoc(sel.from, sel.to) : '';
  searchStore.set((s) => ({ ...s, showReplace: replace || s.showReplace, query: text && !text.includes('\n') && text.length < 200 ? text : s.query }));
  updateLayout({ sidebarVisible: true, sidebarView: 'search' });
  requestAnimationFrame(() => window.dispatchEvent(new Event('ivily:focus-search')));
}

function cycleTab(delta) {
  const s = editorStore.get();
  const g = s.groups.find((x) => x.id === s.activeGroup);
  if (!g || g.tabs.length < 2) return;
  const i = g.tabs.findIndex((t) => t.key === g.active);
  activateTab(g.id, g.tabs[(i + delta + g.tabs.length) % g.tabs.length].key);
}

function withEditor(fn) {
  return () => {
    const ed = activeEditor();
    return ed ? fn(ed) : undefined;
  };
}
import { OutputView, outputUi } from '../features/output/OutputView.jsx';

const ZOOM = { min: 10, max: 20, default: 13 };

function zoomBy(delta) {
  const current = Number(getSetting('appearance.uiFontSize') ?? ZOOM.default);
  const next = delta === 0 ? ZOOM.default : Math.min(ZOOM.max, Math.max(ZOOM.min, current + delta));
  if (next !== current) return setSetting('appearance.uiFontSize', next);
}

/** Folder for "new file/folder" commands: the focused folder, or the parent of the focused file. */
function explorerTargetDir() {
  const s = explorerStore.get();
  if (!s.focus) return keyOf(0, '');
  const { rel } = parseKey(s.focus);
  if (!rel) return s.focus;
  const entry = s.dirs[parentKeyOf(s.focus)]?.entries?.find((e) => e.name === baseName(rel));
  return entry?.kind === 'dir' ? s.focus : parentKeyOf(s.focus);
}

let registered = false;

export function registerWorkbenchContributions() {
  if (registered) return;
  registered = true;

  // ── Views ──────────────────────────────────────────────────────────────────
  registerView({ id: 'explorer', title: 'Explorer', icon: 'files', location: 'sidebar', component: ExplorerView, order: 10, command: 'workbench.showExplorer' });
  registerView({ id: 'search', title: 'Search', icon: 'search', location: 'sidebar', component: SearchView, order: 15, command: 'search.show' });
  registerView({ id: 'notes', title: 'Notes', icon: 'pencil', location: 'sidebar', component: NotesView, order: 40, command: 'notes.show' });
  registerView({ id: 'debug', title: 'Run and Debug', icon: 'debug', location: 'sidebar', component: DebugView, order: 30, command: 'debug.showView' });
  registerView({ id: 'extensions', title: 'Extensions', icon: 'extensions', location: 'sidebar', component: ExtensionsView, order: 50, command: 'extensions.show' });
  registerView({ id: 'scm', title: 'Source Control', icon: 'git', location: 'sidebar', component: ScmView, order: 20, command: 'git.showView' });
  registerView({ id: 'settings', title: 'Settings', icon: 'settings', location: 'sidebar', component: SettingsView, order: 100, group: 'bottom', command: 'preferences.openSettings' });
  registerView({ id: 'terminal', title: 'Terminal', icon: 'terminal', location: 'panel', component: TerminalView, order: 10, command: 'terminal.toggle' });
  registerView({ id: 'problems', title: 'Problems', icon: 'warning', location: 'panel', component: ProblemsView, order: 5, command: 'workbench.showProblems' });
  registerView({ id: 'debugConsole', title: 'Debug Console', icon: 'debug', location: 'panel', component: DebugConsoleView, order: 15, command: 'debug.showConsole' });
  registerView({ id: 'output', title: 'Output', icon: 'output', location: 'panel', component: OutputView, order: 20, command: 'workbench.showOutput' });

  // ── Commands ───────────────────────────────────────────────────────────────
  const commands = [
    { id: 'workbench.toggleSidebar', title: 'Toggle Side Bar', category: 'View', icon: 'sidebar', run: () => updateLayout({ sidebarVisible: !layoutStore.get().sidebarVisible }) },
    { id: 'workbench.togglePanel', title: 'Toggle Panel', category: 'View', icon: 'panel', run: () => updateLayout({ panelVisible: !layoutStore.get().panelVisible }) },
    { id: 'workbench.showExplorer', title: 'Show Explorer', category: 'View', icon: 'files', run: () => toggleSidebarView('explorer') },
    { id: 'workbench.showOutput', title: 'Show Output', category: 'View', icon: 'output', run: () => showPanelView('output') },
    { id: 'view.zoomIn', title: 'Increase Interface Size', category: 'View', run: () => zoomBy(1) },
    { id: 'view.zoomOut', title: 'Decrease Interface Size', category: 'View', run: () => zoomBy(-1) },
    { id: 'view.zoomReset', title: 'Reset Interface Size', category: 'View', run: () => zoomBy(0) },
    { id: 'preferences.openSettings', title: 'Open Settings', category: 'Preferences', icon: 'settings', run: () => updateLayout({ sidebarVisible: true, sidebarView: 'settings' }) },
    { id: 'preferences.selectTheme', title: 'Select Theme…', category: 'Preferences', icon: 'palette', run: () => setStatusPopover('theme') },
    { id: 'output.clear', title: 'Clear Output Channel', category: 'Output', icon: 'trash', when: "activePanel == 'output'", run: () => clearChannel(outputUi.get().channel) },
    { id: 'notifications.toggleCenter', title: 'Show Notifications', category: 'Notifications', icon: 'bell', run: () => setStatusPopover(statusUi.get().popover === 'notifications' ? null : 'notifications') },
    { id: 'notifications.clearAll', title: 'Clear All Notifications', category: 'Notifications', run: () => clearAll() },
    { id: 'notifications.toggleDoNotDisturb', title: 'Toggle Do Not Disturb', category: 'Notifications', icon: 'bell-off', run: () => setSetting('notifications.doNotDisturb', !notificationStore.get().prefs.doNotDisturb) },
    { id: 'workspace.openFolder', title: 'Open Folder…', category: 'Workspace', icon: 'folder-open', run: () => openFolder() },
    { id: 'workspace.openWorkspaceFile', title: 'Open Workspace File…', category: 'Workspace', icon: 'workspace', run: () => openWorkspaceFile() },
    { id: 'workspace.showLauncher', title: 'Show Launcher / Recent Workspaces', category: 'Workspace', icon: 'folder', run: () => showPage('launcher') },
    { id: 'workspace.saveAs', title: 'Save Workspace As…', category: 'Workspace', when: 'workspaceOpen', run: () => saveWorkspaceAs() },
    { id: 'workspace.reloadFile', title: 'Reload Workspace File', category: 'Workspace', when: "workspaceKind == 'file'", run: () => reloadWorkspaceFile() },
    { id: 'workspace.toggleFavorite', title: 'Add / Remove Workspace from Favorites', category: 'Workspace', icon: 'star', when: 'workspaceOpen', run: () => toggleCurrentFavorite() },
    { id: 'workspace.close', title: 'Close Workspace', category: 'Workspace', when: 'workspaceOpen', run: () => closeWorkspace() },
    { id: 'explorer.newFile', title: 'New File…', category: 'File', icon: 'file-plus', when: 'workspaceOpen', run: () => { updateLayout({ sidebarVisible: true, sidebarView: 'explorer' }); startCreate('newFile', explorerTargetDir()); } },
    { id: 'explorer.newFolder', title: 'New Folder…', category: 'File', icon: 'folder-plus', when: 'workspaceOpen', run: () => { updateLayout({ sidebarVisible: true, sidebarView: 'explorer' }); startCreate('newFolder', explorerTargetDir()); } },
    { id: 'explorer.refresh', title: 'Refresh Explorer', category: 'File', icon: 'refresh', when: 'workspaceOpen', run: () => refreshAll() },
    { id: 'explorer.collapseAll', title: 'Collapse Folders in Explorer', category: 'File', icon: 'collapse', when: 'workspaceOpen', run: () => collapseAll() },
    { id: 'tools.show', title: 'Show Languages & Tools', category: 'View', icon: 'wrench', run: () => showPage('tools') },
    { id: 'trust.manage', title: 'Manage Workspace Trust', category: 'Workspace Trust', icon: 'shield', run: () => showPage('trust') },
    {
      id: 'trust.prompt',
      title: 'Change Trust for This Workspace…',
      category: 'Workspace Trust',
      icon: 'shield',
      when: 'workspaceOpen',
      run: () => workspaceStore.set((s) => ({ ...s, trustPrompt: true })),
    },
    { id: 'file.newUntitled', title: 'New Text File', category: 'File', icon: 'file-plus', run: () => newUntitled() },
    { id: 'file.open', title: 'Open File…', category: 'File', icon: 'files', run: () => openFileDialog() },
    { id: 'file.save', title: 'Save', category: 'File', when: 'editorFocus', run: withEditor((ed) => saveDocument(ed.key)) },
    { id: 'file.saveAs', title: 'Save As…', category: 'File', when: 'editorFocus', run: withEditor((ed) => saveDocument(ed.key, { saveAs: true })) },
    { id: 'file.saveAll', title: 'Save All', category: 'File', run: () => saveAll() },
    { id: 'file.revert', title: 'Revert File', category: 'File', when: 'editorFocus && activeEditorDirty', run: withEditor((ed) => revertDocument(ed.key)) },
    { id: 'editor.close', title: 'Close Editor', category: 'View', when: 'editorFocus', run: withEditor((ed) => closeTab(ed.groupId, ed.key)) },
    { id: 'editor.closeAll', title: 'Close All Editors', category: 'View', run: () => closeAllEditors() },
    { id: 'editor.reopenClosed', title: 'Reopen Closed Editor', category: 'View', run: () => reopenClosed() },
    { id: 'editor.nextTab', title: 'Next Editor', category: 'View', run: () => cycleTab(1) },
    { id: 'editor.previousTab', title: 'Previous Editor', category: 'View', run: () => cycleTab(-1) },
    { id: 'editor.splitRight', title: 'Split Editor Right', category: 'View', icon: 'split', run: () => splitEditor('horizontal') },
    { id: 'editor.splitDown', title: 'Split Editor Down', category: 'View', run: () => splitEditor('vertical') },
    { id: 'editor.focusGroup1', title: 'Focus First Editor Group', category: 'View', run: () => focusGroup(editorStore.get().groups[0]?.id) },
    { id: 'editor.focusGroup2', title: 'Focus Second Editor Group', category: 'View', run: () => focusGroup(editorStore.get().groups[1]?.id) },
    { id: 'editor.focusGroup3', title: 'Focus Third Editor Group', category: 'View', run: () => focusGroup(editorStore.get().groups[2]?.id) },
    { id: 'editor.toggleWordWrap', title: 'Toggle Word Wrap', category: 'View', run: () => setSetting('editor.wordWrap', getSetting('editor.wordWrap') === 'on' ? 'off' : 'on') },
    { id: 'editor.changeEncoding', title: 'Change File Encoding', category: 'File', when: 'editorFocus', run: () => pickEncoding() },
    { id: 'editor.changeEol', title: 'Change End of Line Sequence', category: 'File', when: 'editorFocus', run: () => pickEol() },
    { id: 'editor.changeLanguage', title: 'Change Language Mode', category: 'File', when: 'editorFocus', run: () => pickLanguage() },
    { id: 'editor.goToDefinition', title: 'Go to Definition', category: 'Language', when: 'editorFocus', run: withEditor((ed) => ed.view && jumpToDefinition(ed.view)) },
    { id: 'editor.goToTypeDefinition', title: 'Go to Type Definition', category: 'Language', when: 'editorFocus', run: withEditor((ed) => ed.view && jumpToTypeDefinition(ed.view)) },
    { id: 'editor.goToImplementation', title: 'Go to Implementation', category: 'Language', when: 'editorFocus', run: withEditor((ed) => ed.view && jumpToImplementation(ed.view)) },
    { id: 'editor.findReferences', title: 'Find All References', category: 'Language', when: 'editorFocus', run: withEditor((ed) => ed.view && findReferences(ed.view)) },
    { id: 'editor.renameSymbol', title: 'Rename Symbol', category: 'Language', when: 'editorFocus', run: withEditor((ed) => ed.view && renameSymbol(ed.view)) },
    { id: 'editor.formatDocument', title: 'Format Document', category: 'Language', when: 'editorFocus', run: withEditor((ed) => ed.view && formatDocument(ed.view)) },
    { id: 'lsp.restart', title: 'Restart Language Servers', category: 'Language', icon: 'refresh', when: 'workspaceOpen', run: () => restartServers() },
    {
      id: 'terminal.toggle',
      title: 'Toggle Terminal',
      category: 'Terminal',
      icon: 'terminal',
      run: () => {
        const l = layoutStore.get();
        if (l.panelVisible && l.panelView === 'terminal') updateLayout({ panelVisible: false });
        else {
          showPanelView('terminal');
          if (!terminalStore.get().groups.length) createTerminal();
        }
      },
    },
    { id: 'terminal.new', title: 'New Terminal', category: 'Terminal', icon: 'terminal', run: () => createTerminal() },
    { id: 'terminal.newWithProfile', title: 'New Terminal with Profile…', category: 'Terminal', run: () => newTerminalWithProfile() },
    { id: 'terminal.split', title: 'Split Terminal', category: 'Terminal', run: () => splitTerminal() },
    { id: 'terminal.kill', title: 'Kill Active Terminal', category: 'Terminal', run: () => { const id = activeTerminalId(); if (id != null) killTerminal(id); } },
    { id: 'terminal.clear', title: 'Clear Terminal', category: 'Terminal', run: () => clearTerminal() },
    { id: 'workbench.quickOpen', title: 'Go to File…', category: 'Go', icon: 'search', run: () => openQuickOpen('') },
    { id: 'workbench.commandPalette', title: 'Show All Commands', category: 'View', run: () => openCommandPalette() },
    { id: 'workbench.gotoLine', title: 'Go to Line…', category: 'Go', when: 'editorFocus', run: () => openQuickOpen(':') },
    { id: 'workbench.gotoSymbol', title: 'Go to Symbol in Editor…', category: 'Go', when: 'editorFocus', run: () => openQuickOpen('@') },
    { id: 'workbench.gotoWorkspaceSymbol', title: 'Go to Symbol in Workspace…', category: 'Go', when: 'workspaceOpen', run: () => openQuickOpen('#') },
    { id: 'search.show', title: 'Search in Files', category: 'Search', icon: 'search', run: () => showSearch(false) },
    { id: 'search.replace', title: 'Replace in Files', category: 'Search', run: () => showSearch(true) },
    { id: 'preferences.openKeybindings', title: 'Open Keyboard Shortcuts', category: 'Preferences', icon: 'keyboard', run: () => showPage('keybindings') },
    { id: 'tasks.run', title: 'Run Task…', category: 'Tasks', when: 'workspaceOpen', run: () => pickAndRun() },
    { id: 'tasks.build', title: 'Run Build Task', category: 'Tasks', when: 'workspaceOpen', run: () => pickAndRun('build') },
    { id: 'tasks.test', title: 'Run Test Task', category: 'Tasks', when: 'workspaceOpen', run: () => pickAndRun('test') },
    { id: 'tasks.rerun', title: 'Rerun Last Task', category: 'Tasks', when: 'workspaceOpen', run: () => rerunLast() },
    { id: 'tasks.terminate', title: 'Terminate Task…', category: 'Tasks', when: 'workspaceOpen', run: () => pickAndTerminate() },
    { id: 'tasks.history', title: 'Show Task History', category: 'Tasks', when: 'workspaceOpen', run: () => showTaskHistory() },
    { id: 'tasks.configure', title: 'Configure Tasks (.ivily/tasks.json)', category: 'Tasks', when: 'workspaceOpen', run: () => configureTasks() },
    { id: 'tasks.revokeApprovals', title: 'Revoke Task Approvals', category: 'Tasks', when: 'workspaceOpen', run: () => revokeTaskApprovals() },
    { id: 'workbench.showProblems', title: 'Show Problems', category: 'View', icon: 'warning', run: () => showPanelView('problems') },
    { id: 'problems.next', title: 'Go to Next Problem', category: 'Go', run: () => goToProblem(1) },
    { id: 'problems.previous', title: 'Go to Previous Problem', category: 'Go', run: () => goToProblem(-1) },
    { id: 'output.export', title: 'Save Output As…', category: 'Output', run: () => exportOutputChannel() },
    { id: 'preferences.exportSettings', title: 'Export Settings…', category: 'Preferences', run: () => exportSettings() },
    { id: 'preferences.importSettings', title: 'Import Settings…', category: 'Preferences', run: () => importSettings() },
    { id: 'preferences.importTheme', title: 'Import Theme…', category: 'Preferences', icon: 'palette', run: () => importTheme() },
    { id: 'preferences.exportTheme', title: 'Export Current Theme…', category: 'Preferences', run: () => exportCurrentTheme() },
    { id: 'preferences.importIconPack', title: 'Import Icon Pack…', category: 'Preferences', run: () => importIconPack() },
    { id: 'preferences.removeCustomization', title: 'Remove User Theme or Icon Pack…', category: 'Preferences', run: () => removeUserItem() },
    { id: 'notes.show', title: 'Show Workspace Notes', category: 'View', icon: 'pencil', when: 'workspaceOpen', run: () => toggleSidebarView('notes') },
    { id: 'preview.open', title: 'Open Preview (Markdown / HTML)', category: 'View', when: 'editorFocus', run: () => openPreview() },
    { id: 'bookmarks.toggle', title: 'Toggle Bookmark', category: 'Bookmarks', when: 'editorFocus', run: () => toggleBookmark() },
    { id: 'bookmarks.next', title: 'Go to Next Bookmark', category: 'Bookmarks', run: () => goToBookmark(1) },
    { id: 'bookmarks.previous', title: 'Go to Previous Bookmark', category: 'Bookmarks', run: () => goToBookmark(-1) },
    { id: 'bookmarks.list', title: 'List Bookmarks', category: 'Bookmarks', run: () => listBookmarks() },
    { id: 'bookmarks.clear', title: 'Remove All Bookmarks', category: 'Bookmarks', run: () => clearBookmarks() },
    { id: 'debug.showView', title: 'Show Run and Debug', category: 'Debug', icon: 'debug', run: () => updateLayout({ sidebarVisible: true, sidebarView: 'debug' }) },
    { id: 'debug.showConsole', title: 'Show Debug Console', category: 'Debug', run: () => showPanelView('debugConsole') },
    { id: 'debug.start', title: 'Start Debugging', category: 'Debug', when: 'workspaceOpen && !inDebugMode', run: () => startDebugging() },
    { id: 'debug.continue', title: 'Continue', category: 'Debug', when: "debugState == 'stopped'", run: () => continueExecution() },
    { id: 'debug.pause', title: 'Pause', category: 'Debug', when: "debugState == 'running'", run: () => pauseExecution() },
    { id: 'debug.stepOver', title: 'Step Over', category: 'Debug', when: "debugState == 'stopped'", run: () => stepOver() },
    { id: 'debug.stepInto', title: 'Step Into', category: 'Debug', when: "debugState == 'stopped'", run: () => stepInto() },
    { id: 'debug.stepOut', title: 'Step Out', category: 'Debug', when: "debugState == 'stopped'", run: () => stepOut() },
    { id: 'debug.stop', title: 'Stop Debugging', category: 'Debug', when: 'inDebugMode', run: () => stopDebugging() },
    { id: 'debug.restart', title: 'Restart Debugging', category: 'Debug', when: 'inDebugMode', run: () => restartDebugging() },
    { id: 'debug.toggleBreakpoint', title: 'Toggle Breakpoint', category: 'Debug', when: 'editorFocus', run: () => toggleBreakpoint() },
    { id: 'debug.removeAllBreakpoints', title: 'Remove All Breakpoints', category: 'Debug', run: () => removeAllBreakpoints() },
    { id: 'debug.configure', title: 'Add Configuration (.ivily/launch.json)', category: 'Debug', when: 'workspaceOpen', run: () => configureLaunch() },
    { id: 'debug.revokeApprovals', title: 'Revoke Launch Approvals', category: 'Debug', when: 'workspaceOpen', run: () => revokeDebugApprovals() },
    { id: 'extensions.show', title: 'Show Extensions', category: 'Extensions', icon: 'extensions', run: () => toggleSidebarView('extensions') },
    { id: 'extensions.install', title: 'Install Extension from Folder…', category: 'Extensions', run: () => installExtension() },
    { id: 'ecosystem.showDashboard', title: 'Show Ivily Ecosystem', category: 'Ecosystem', icon: 'ecosystem', run: () => showPage('modules') },
    { id: 'app.checkForUpdates', title: 'Check for Updates…', category: 'Help', run: () => { showPage('updates'); return checkForUpdates(); } },
    { id: 'app.showUpdates', title: 'About Ivily Center', category: 'Help', icon: 'info', run: () => showPage('updates') },
    { id: 'git.showView', title: 'Show Source Control', category: 'Git', icon: 'git', run: () => updateLayout({ sidebarVisible: true, sidebarView: 'scm' }) },
    { id: 'git.refresh', title: 'Refresh', category: 'Git', icon: 'refresh', when: 'workspaceOpen', run: () => loadRepos() },
    { id: 'git.checkout', title: 'Checkout to…', category: 'Git', when: 'gitRepository', run: () => { const r = activeRepo(); return r && gitCheckout(r.root); } },
    { id: 'git.createBranch', title: 'Create Branch…', category: 'Git', when: 'gitRepository', run: () => { const r = activeRepo(); return r && gitCreateBranch(r.root); } },
    { id: 'git.fetch', title: 'Fetch', category: 'Git', when: 'gitRepository', run: () => { const r = activeRepo(); return r && gitSync(r.root, 'fetch'); } },
    { id: 'git.pull', title: 'Pull', category: 'Git', when: 'gitRepository', run: () => { const r = activeRepo(); return r && gitSync(r.root, 'pull'); } },
    { id: 'git.pullRebase', title: 'Pull (Rebase)', category: 'Git', when: 'gitRepository', run: () => { const r = activeRepo(); return r && gitSync(r.root, 'pullRebase'); } },
    { id: 'git.push', title: 'Push', category: 'Git', when: 'gitRepository', run: () => { const r = activeRepo(); return r && gitSync(r.root, 'push'); } },
    { id: 'git.stash', title: 'Stash Changes…', category: 'Git', when: 'gitRepository', run: () => { const r = activeRepo(); return r && stashPush(r.root); } },
    { id: 'git.clone', title: 'Clone Repository…', category: 'Git', run: () => cloneRepository() },
    { id: 'git.showOutput', title: 'Show Git Output', category: 'Git', run: () => { outputPanelUi.set({ channel: 'git' }); showPanelView('output'); } },
    { id: 'window.minimize', title: 'Minimize Window', category: 'Window', icon: 'minimize', run: () => minimizeWindow() },
    { id: 'window.toggleMaximize', title: 'Maximize / Restore Window', category: 'Window', icon: 'maximize', run: () => toggleMaximizeWindow() },
    { id: 'window.close', title: 'Close Window', category: 'Window', icon: 'close', run: () => closeWindow() },
  ];
  for (const c of commands) registerCommand(c, 'workbench');

  // One command per registered theme, so the Command Palette (Phase 10) can switch themes directly.
  for (const t of listThemes()) {
    registerCommand({ id: `preferences.theme.${t.id}`, title: `Theme: ${t.name}`, category: 'Preferences', icon: 'palette', run: () => selectTheme(t.id) }, 'theme');
  }

  // ── Default keybindings ────────────────────────────────────────────────────
  registerDefaultKeybindings([
    { key: 'Ctrl+B', command: 'workbench.toggleSidebar' },
    { key: 'Ctrl+J', command: 'workbench.togglePanel' },
    { key: 'Ctrl+Shift+E', command: 'workbench.showExplorer' },
    { key: 'Ctrl+Shift+U', command: 'workbench.showOutput' },
    { key: 'Ctrl+,', command: 'preferences.openSettings' },
    { key: 'Ctrl+=', command: 'view.zoomIn' },
    { key: 'Ctrl+NumpadAdd', command: 'view.zoomIn' },
    { key: 'Ctrl+-', command: 'view.zoomOut' },
    { key: 'Ctrl+NumpadSubtract', command: 'view.zoomOut' },
    { key: 'Ctrl+0', command: 'view.zoomReset' },
    { key: 'Ctrl+Alt+O', command: 'workspace.openFolder' },
    { key: 'Ctrl+R', command: 'workspace.showLauncher' },
    { key: 'Ctrl+N', command: 'file.newUntitled' },
    { key: 'Ctrl+O', command: 'file.open' },
    { key: 'Ctrl+S', command: 'file.save' },
    { key: 'Ctrl+Shift+S', command: 'file.saveAs' },
    { key: 'Ctrl+Alt+S', command: 'file.saveAll' },
    { key: 'Ctrl+W', command: 'editor.close' },
    { key: 'Ctrl+F4', command: 'editor.close' },
    { key: 'Ctrl+Shift+T', command: 'editor.reopenClosed' },
    { key: 'Ctrl+Tab', command: 'editor.nextTab' },
    { key: 'Ctrl+PageDown', command: 'editor.nextTab' },
    { key: 'Ctrl+Shift+Tab', command: 'editor.previousTab' },
    { key: 'Ctrl+PageUp', command: 'editor.previousTab' },
    { key: 'Ctrl+\\', command: 'editor.splitRight' },
    { key: 'Ctrl+1', command: 'editor.focusGroup1' },
    { key: 'Ctrl+2', command: 'editor.focusGroup2' },
    { key: 'Ctrl+3', command: 'editor.focusGroup3' },
    { key: 'Alt+Z', command: 'editor.toggleWordWrap' },
    { key: 'Ctrl+`', command: 'terminal.toggle' },
    { key: 'Ctrl+Shift+G', command: 'git.showView' },
    { key: 'Ctrl+P', command: 'workbench.quickOpen' },
    { key: 'Ctrl+Shift+X', command: 'extensions.show' },
    { key: 'F5', command: 'debug.start' },
    { key: 'F5', command: 'debug.continue', when: "debugState == 'stopped'" },
    { key: 'F6', command: 'debug.pause' },
    { key: 'F10', command: 'debug.stepOver' },
    { key: 'F11', command: 'debug.stepInto' },
    { key: 'Shift+F11', command: 'debug.stepOut' },
    { key: 'Shift+F5', command: 'debug.stop' },
    { key: 'Ctrl+Shift+F5', command: 'debug.restart' },
    { key: 'F9', command: 'debug.toggleBreakpoint' },
    { key: 'Ctrl+Shift+D', command: 'debug.showView' },
    { key: 'Ctrl+Shift+V', command: 'preview.open' },
    { key: 'Ctrl+Alt+K', command: 'bookmarks.toggle' },
    { key: 'Ctrl+Alt+L', command: 'bookmarks.next' },
    { key: 'Ctrl+Alt+J', command: 'bookmarks.previous' },
    { key: 'Ctrl+Shift+M', command: 'workbench.showProblems' },
    { key: 'F8', command: 'problems.next' },
    { key: 'Shift+F8', command: 'problems.previous' },
    { key: 'Ctrl+Shift+B', command: 'tasks.build' },
    { key: 'Ctrl+E', command: 'workbench.quickOpen' },
    { key: 'Ctrl+Shift+P', command: 'workbench.commandPalette' },
    { key: 'F1', command: 'workbench.commandPalette' },
    { key: 'Ctrl+G', command: 'workbench.gotoLine' },
    { key: 'Ctrl+Shift+O', command: 'workbench.gotoSymbol' },
    { key: 'Ctrl+T', command: 'workbench.gotoWorkspaceSymbol' },
    { key: 'Ctrl+Shift+F', command: 'search.show' },
    { key: 'Ctrl+Shift+H', command: 'search.replace' },
    { key: 'Ctrl+Shift+`', command: 'terminal.new' },
  ]);
}
