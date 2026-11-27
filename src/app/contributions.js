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
import { ExplorerView } from '../features/explorer/ExplorerView.jsx';
import { SettingsView } from '../features/settings/SettingsView.jsx';
import { OutputView, outputUi } from '../features/output/OutputView.jsx';

const ZOOM = { min: 10, max: 20, default: 13 };

function zoomBy(delta) {
  const current = Number(getSetting('appearance.uiFontSize') ?? ZOOM.default);
  const next = delta === 0 ? ZOOM.default : Math.min(ZOOM.max, Math.max(ZOOM.min, current + delta));
  if (next !== current) return setSetting('appearance.uiFontSize', next);
}

let registered = false;

export function registerWorkbenchContributions() {
  if (registered) return;
  registered = true;

  // ── Views ──────────────────────────────────────────────────────────────────
  registerView({ id: 'explorer', title: 'Explorer', icon: 'files', location: 'sidebar', component: ExplorerView, order: 10, command: 'workbench.showExplorer' });
  registerView({ id: 'settings', title: 'Settings', icon: 'settings', location: 'sidebar', component: SettingsView, order: 100, group: 'bottom', command: 'preferences.openSettings' });
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
  ]);
}
