// Application-level facts (version, storage health) loaded once at startup.
import { createStore } from '../core/store.js';

/** @type {import('../core/store.js').Store<{ ready: boolean, info: null | Awaited<ReturnType<typeof import('../platform/ipc.js').appInfo>> }>} */
export const appStore = createStore({ ready: false, info: null });
