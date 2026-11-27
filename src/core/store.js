// Minimal external store for feature state. React components subscribe with `useStore`
// (useSyncExternalStore), so only components whose selected slice changed re-render.
import { useSyncExternalStore } from 'react';

/**
 * @template S
 * @typedef {{ get: () => S, set: (next: S | ((prev: S) => S)) => void, subscribe: (fn: () => void) => () => void }} Store
 */

/**
 * @template S
 * @param {S} initial
 * @returns {Store<S>}
 */
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? next(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const fn of [...listeners]) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/**
 * @template S, T
 * @param {Store<S>} store
 * @param {(s: S) => T} [selector]
 * @returns {T}
 */
export function useStore(store, selector = (s) => /** @type {any} */ (s)) {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
