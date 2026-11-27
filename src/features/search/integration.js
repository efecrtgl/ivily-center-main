// Search/Quick Open/keybinding wiring: loads history and user shortcuts, resets on workspace switch.
import { workspaceStore } from '../../workspace/store.js';
import { loadHistory, resetSearch } from './model.js';
import { loadUserKeybindings } from '../keybindings/model.js';

let installed = false;
export function installSearch() {
  if (installed) return;
  installed = true;
  loadHistory();
  loadUserKeybindings();
  let id = workspaceStore.get().current?.record.id ?? '';
  workspaceStore.subscribe(() => {
    const next = workspaceStore.get().current?.record.id ?? '';
    if (next === id) return;
    id = next;
    resetSearch();
  });
}
