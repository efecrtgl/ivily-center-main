// View registry: features contribute views to workbench locations without the shell knowing
// about them. `sidebar` views get an activity-bar entry; `panel` views get a tab in the panel.
import { createStore } from './store.js';

/**
 * @typedef {object} ViewDefinition
 * @property {string} id
 * @property {string} title
 * @property {string} icon               Icon id.
 * @property {'sidebar' | 'panel'} location
 * @property {import('react').ComponentType} component
 * @property {number} [order]
 * @property {'top' | 'bottom'} [group]  Activity bar group (sidebar views).
 * @property {string} [command]          Command that reveals the view (for tooltips/shortcuts).
 */

/** @type {import('./store.js').Store<ViewDefinition[]>} */
export const viewStore = createStore([]);

/** @param {ViewDefinition} view @returns {() => void} */
export function registerView(view) {
  if (!/^[a-z][\w.-]*$/.test(view.id)) throw new Error(`Invalid view id: ${view.id}`);
  if (viewStore.get().some((v) => v.id === view.id)) throw new Error(`View already registered: ${view.id}`);
  viewStore.set((list) => [...list, view].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)));
  return () => viewStore.set((list) => list.filter((v) => v !== view));
}

/** @param {ViewDefinition[]} views @param {'sidebar' | 'panel'} location */
export const viewsAt = (views, location) => views.filter((v) => v.location === location);
