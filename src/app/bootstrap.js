// Application startup. Order matters:
//   1. themes (first paint with the cached theme)
//   2. contributions (commands, views, keybindings)
//   3. settings → effects (theme, motion, font size, notification preferences)
//   4. layout, window title, output events, shortcut dispatcher, startup issues
//   5. workspace startup plan (decided by the backend: command-line path, restore, launcher,
//      welcome), session flush before the window closes, "ready" signal for crash detection
import { initThemes, setActiveTheme, applyMotionPreference, applyUiFontSize, DEFAULT_THEME } from '../theme/index.js';
import { installSearch } from '../features/search/integration.js';
import { installTasks } from '../features/tasks/model.js';
import { loadUserCustomizations } from '../features/customize/model.js';
import { registerWorkbenchContributions } from './contributions.js';
import { loadSettings, settingsStore } from '../core/settings.js';
import { setNotificationPrefs, notify } from '../core/notifications.js';
import { setCommandErrorHandler } from '../core/commands.js';
import { installKeybindingDispatcher } from '../core/keybindings.js';
import { initLayout } from '../core/layout.js';
import { initWindowTitle } from '../core/title.js';
import { startOutput, uiLog } from '../core/output.js';
import * as ipc from '../platform/ipc.js';
import { beforeWindowClose } from '../platform/window.js';
import { appStore } from './appStore.js';
import { applyStartup, showPage } from '../workspace/store.js';
import { flushSession } from '../workspace/session.js';
import { onFsChanged, registerExplorerSession, setFileOpener } from '../features/explorer/model.js';
import { applyOptionsToAll, onFsChangedEditor, openDocument, registerEditorSession } from '../features/editor/model.js';
import { themeStore } from '../theme/engine.js';
import { installLsp } from '../features/lsp/integration.js';
import { applyTerminalOptions, installTerminal } from '../features/terminal/model.js';
import { installGit } from '../features/git/integration.js';
import { errorMessage } from '../core/errors.js';

/** Apply settings that have UI side effects. Only changed values are re-applied. */
function applySettingEffects(values, prev) {
  const v = (k) => values[k]?.value;
  const changed = (k) => !prev || prev[k]?.value !== values[k]?.value;
  if (changed('appearance.theme')) setActiveTheme(String(v('appearance.theme') ?? DEFAULT_THEME));
  if (changed('appearance.reduceMotion')) applyMotionPreference(v('appearance.reduceMotion') ?? 'system');
  if (changed('appearance.uiFontSize')) applyUiFontSize(v('appearance.uiFontSize') ?? 13);
  if (['editor.fontFamily', 'editor.fontSize', 'editor.lineHeight'].some(changed)) {
    const root = document.documentElement.style;
    const family = String(v('editor.fontFamily') ?? '').trim();
    if (family && !/[;{}<>]|url\(/i.test(family)) root.setProperty('--editor-font', family);
    else root.removeProperty('--editor-font');
    root.setProperty('--editor-font-size', `${Number(v('editor.fontSize') ?? 14)}px`);
    root.setProperty('--editor-line-height', String(Number(v('editor.lineHeight') ?? 150) / 100));
  }
  if (prev && ['editor.tabSize', 'editor.insertSpaces', 'editor.wordWrap', 'editor.renderWhitespace', 'editor.lineNumbers'].some(changed)) {
    applyOptionsToAll();
  }
  if (prev && ['terminal.fontFamily', 'terminal.fontSize', 'terminal.cursorStyle'].some(changed)) applyTerminalOptions();
  if (['notifications.level', 'notifications.doNotDisturb', 'notifications.timeoutSeconds'].some(changed)) {
    setNotificationPrefs({
      level: v('notifications.level') ?? 'info',
      doNotDisturb: v('notifications.doNotDisturb') ?? false,
      timeoutSeconds: v('notifications.timeoutSeconds') ?? 6,
    });
  }
}

/** Prevent browser behaviours that make no sense in a desktop IDE (reload, print, page find). */
function installWebviewGuards() {
  const blocked = new Set(['F5', 'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+P', 'Ctrl+F', 'Ctrl+G', 'Ctrl+U', 'Ctrl+S']);
  window.addEventListener('keydown', (e) => {
    const mods = `${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}`;
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (blocked.has(`${mods}${key}`)) e.preventDefault();
  });
  if (import.meta.env.PROD) {
    // Keep the native menu (copy/paste) in text fields only; hide "Reload"/"Inspect" elsewhere.
    window.addEventListener('contextmenu', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (!t.closest('input, textarea, [contenteditable="true"], .selectable')) e.preventDefault();
    });
  }
}

let started = false;

export async function bootstrap() {
  if (started) return;
  started = true;

  initThemes();
  registerWorkbenchContributions();

  setCommandErrorHandler((err, id) => {
    const message = err?.message ?? String(err);
    uiLog('error', `command ${id} failed: ${message}`);
    notify({ severity: 'error', title: 'Command failed', message: `${id}: ${message}`, source: 'commands' });
  });

  let prev = null;
  settingsStore.subscribe(() => {
    const { values } = settingsStore.get();
    applySettingEffects(values, prev);
    prev = values;
  });

  startOutput();
  registerExplorerSession();
  registerEditorSession();
  installLsp();
  installTerminal();
  installGit();
  installSearch();
  installTasks();
  setFileOpener((ref, opts) => openDocument(ref, opts));
  ipc.onEvent(ipc.events.fsChanged, (change) => {
    onFsChanged(change);
    onFsChangedEditor(change);
  });
  let appearance = themeStore.get().current?.appearance;
  themeStore.subscribe(() => {
    const next = themeStore.get().current?.appearance;
    if (next !== appearance) {
      appearance = next;
      applyOptionsToAll();
    }
  });
  installKeybindingDispatcher(window);
  installWebviewGuards();
  initWindowTitle();

  await loadUserCustomizations().catch(() => {});
  const results = await Promise.allSettled([
    ipc.isTauri() ? ipc.appInfo() : Promise.resolve(null),
    loadSettings([]),
    initLayout(),
  ]);
  const [info, settings] = results;

  if (info.status === 'fulfilled') {
    appStore.set({ ready: true, info: info.value });
    for (const issue of info.value?.startupIssues ?? []) {
      notify({ severity: issue.severity, title: issue.code === 'db_recovered' ? 'Database recovered' : 'Storage problem', message: issue.message, source: 'database', sticky: true });
    }
  } else {
    appStore.set({ ready: true, info: null });
  }
  if (settings.status === 'rejected') {
    notify({ severity: 'error', title: 'Settings could not be loaded', message: settings.reason?.message ?? String(settings.reason), source: 'settings' });
  } else if (settings.value?.invalid?.length) {
    notify({
      severity: 'warning',
      title: 'Some saved settings were ignored',
      message: `${settings.value.invalid.length} stored value(s) are invalid and were replaced by defaults. Details are in the Settings output channel.`,
      source: 'settings',
      actions: [{ label: 'Show Output', command: 'workbench.showOutput' }],
    });
  }
  // Apply effects once even if nothing changed after load (e.g. outside Tauri).
  applySettingEffects(settingsStore.get().values, null);

  if (ipc.isTauri()) {
    try {
      await applyStartup(await ipc.workspaceStartup());
    } catch (e) {
      showPage('launcher');
      notify({ severity: 'error', title: 'Could not restore the workspace', message: errorMessage(e), source: 'workspace' });
    }
    beforeWindowClose(() => flushSession());
    // The workbench restored: reset the failed-start counter used for safe mode.
    ipc.sessionReady().catch(() => {});
  } else {
    showPage('launcher');
  }
  uiLog('info', 'workbench ready');
}
