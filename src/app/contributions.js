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
import { activeTerminalId, clearTerminal, createTerminal, killTerminal, newTerminalWithProfile, splitTerminal, terminalStore } from '../features/terminal/model.js';

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
  registerView({ id: 'settings', title: 'Settings', icon: 'settings', location: 'sidebar', component: SettingsView, order: 100, group: 'bottom', command: 'preferences.openSettings' });
  registerView({ id: 'terminal', title: 'Terminal', icon: 'terminal', location: 'panel', component: TerminalView, order: 10, command: 'terminal.toggle' });
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
    { key: 'Ctrl+Shift+`', command: 'terminal.new' },
  ]);
}
