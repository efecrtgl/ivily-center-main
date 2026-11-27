// Workspace session: UI state that belongs to one workspace and is restored when it reopens.
//
// Features contribute *session participants* instead of persisting state themselves:
//
//   registerSessionParticipant('layout', {
//     save: () => ({ ...layout }),          // JSON-serializable snapshot
//     restore: (data) => apply(data),       // data is undefined for a workspace without a session
//     reset: () => clearWorkspaceState(),   // called before switching: drop the old workspace's state
//   });
//
// Editors (Phase 5), the explorer (4), terminals (8), Git (9) etc. add their own participants.
// The document is versioned and saved (debounced) to the backend, which keeps the previous
// version as a fallback. A failing participant never breaks the others.

export const SESSION_VERSION = 1;
const SAVE_DELAY_MS = 800;

/**
 * @typedef {object} SessionParticipant
 * @property {() => unknown} save
 * @property {(data: unknown) => void} restore
 * @property {() => void} [reset]
 */

/** @type {Map<string, SessionParticipant>} */
const participants = new Map();

/** @type {{ save: (doc: object) => Promise<unknown>, canSave: () => boolean, onError: (e: unknown) => void }} */
let sink = { save: async () => {}, canSave: () => false, onError: () => {} };
let timer = null;
let restoring = false;

/** Configure where sessions are written (set by the workspace store). */
export function setSessionSink(next) {
  sink = next;
}

/** @param {string} id @param {SessionParticipant} p @returns {() => void} */
export function registerSessionParticipant(id, p) {
  if (!/^[a-z][\w.-]*$/.test(id)) throw new Error(`Invalid session participant id: ${id}`);
  if (participants.has(id)) throw new Error(`Session participant already registered: ${id}`);
  participants.set(id, p);
  return () => participants.delete(id);
}

/** Build the session document from all participants. */
export function collectSession() {
  /** @type {Record<string, unknown>} */
  const data = {};
  for (const [id, p] of participants) {
    try {
      const v = p.save();
      if (v !== undefined) data[id] = v;
    } catch (e) {
      console.warn(`session participant ${id} failed to save`, e);
    }
  }
  return { version: SESSION_VERSION, participants: data };
}

/** Restore participants from a session document (or reset them to defaults when absent). */
export function restoreSession(doc) {
  const valid = doc && typeof doc === 'object' && doc.version === SESSION_VERSION && doc.participants && typeof doc.participants === 'object';
  restoring = true;
  try {
    for (const [id, p] of participants) {
      try {
        p.restore(valid ? doc.participants[id] : undefined);
      } catch (e) {
        console.warn(`session participant ${id} failed to restore`, e);
      }
    }
  } finally {
    restoring = false;
  }
}

/** Drop workspace-specific state of every participant (before switching workspaces). */
export function resetParticipants() {
  cancelPendingSave();
  for (const [id, p] of participants) {
    try {
      p.reset?.();
    } catch (e) {
      console.warn(`session participant ${id} failed to reset`, e);
    }
  }
}

export function cancelPendingSave() {
  clearTimeout(timer);
  timer = null;
}

/** A participant's state changed: schedule a save. */
export function markSessionDirty() {
  if (restoring || !sink.canSave()) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    flushSession();
  }, SAVE_DELAY_MS);
}

/** @type {Set<() => Promise<void>>} */
const flushHooks = new Set();

/**
 * Async work that must finish before the session is saved for a workspace switch or window close
 * (e.g. writing editor recovery drafts while the old workspace is still current).
 * @param {() => Promise<void>} fn
 */
export function registerFlushHook(fn) {
  flushHooks.add(fn);
  return () => flushHooks.delete(fn);
}

/** Save now (before switching workspaces or closing the window). */
export async function flushSession() {
  cancelPendingSave();
  await Promise.allSettled([...flushHooks].map((fn) => fn()));
  if (!sink.canSave()) return;
  try {
    await sink.save(collectSession());
  } catch (e) {
    sink.onError(e);
  }
}

/** Test helper. */
export function _resetSessionRegistry() {
  cancelPendingSave();
  participants.clear();
  sink = { save: async () => {}, canSave: () => false, onError: () => {} };
}
