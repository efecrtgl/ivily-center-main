// Context-aware window title. The workspace system (Phase 3) and editor (Phase 5) set the
// workspace name and active file; the title bar and the OS window title (taskbar, Alt+Tab)
// are derived from the same state.
import { createStore } from './store.js';
import { setWindowTitle } from '../platform/window.js';

export const APP_TITLE = 'Ivily Center';

/** @type {import('./store.js').Store<{ workspace: string | null, file: string | null, dirty: boolean }>} */
export const titleStore = createStore({ workspace: null, file: null, dirty: false });

/** @param {{ workspace: string | null, file: string | null, dirty: boolean }} t */
export function formatTitle(t) {
  const parts = [];
  if (t.file) parts.push(`${t.dirty ? '● ' : ''}${t.file}`);
  if (t.workspace) parts.push(t.workspace);
  parts.push(APP_TITLE);
  return parts.join(' — ');
}

/** Keep `document.title` and the native window title in sync. */
export function initWindowTitle() {
  const apply = () => {
    const title = formatTitle(titleStore.get());
    if (typeof document !== 'undefined') document.title = title;
    Promise.resolve(setWindowTitle(title)).catch(() => {});
  };
  apply();
  return titleStore.subscribe(apply);
}
