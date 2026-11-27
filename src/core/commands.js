// Command registry. Every user-facing action (title bar, menus, shortcuts, the future Command
// Palette, extensions) is a command, so behaviour, permissions and shortcuts live in one place.
import { createStore } from './store.js';
import { evaluateWhen } from './context.js';

/**
 * @typedef {object} CommandDefinition
 * @property {string} id            Namespaced id, e.g. `workbench.toggleSidebar`.
 * @property {string} title         Human-readable title shown in the palette and menus.
 * @property {string} category      Group, e.g. `View`, `Window`, `Preferences`.
 * @property {string} [description]
 * @property {string} [icon]        Icon id from the icon registry.
 * @property {string} [when]        Context clause; when false the command is unavailable.
 * @property {boolean} [palette]    Hide from the palette when `false` (default `true`).
 * @property {(args?: unknown) => unknown | Promise<unknown>} run
 */

/** @typedef {Omit<CommandDefinition, 'run'> & { source: string }} CommandInfo */

const ID = /^[a-zA-Z][\w-]*(\.[\w-]+)+$/;
const RECENT_LIMIT = 20;

/** @type {Map<string, CommandDefinition & { source: string }>} */
const commands = new Map();

/** Bumped on every (un)registration so UIs listing commands can re-render. */
export const commandsVersion = createStore(0);
/** Most recently executed command ids, newest first. */
export const recentCommands = createStore(/** @type {string[]} */ ([]));

/** @type {(err: unknown, id: string) => void} */
let errorHandler = (err, id) => console.error(`Command ${id} failed`, err);

/** Route command failures (set once by the app to show a notification and log to Output). */
export function setCommandErrorHandler(fn) {
  errorHandler = fn;
}

/**
 * Register a command. Returns a disposer.
 * @param {CommandDefinition} def
 * @param {string} [source] Who registered it (`core`, a feature name, later an extension id).
 */
export function registerCommand(def, source = 'core') {
  if (!def || !ID.test(def.id)) throw new Error(`Invalid command id: ${def?.id}`);
  if (typeof def.run !== 'function') throw new Error(`Command ${def.id} has no run function`);
  if (!def.title || !def.category) throw new Error(`Command ${def.id} needs a title and category`);
  if (commands.has(def.id)) throw new Error(`Command already registered: ${def.id}`);
  commands.set(def.id, { ...def, source });
  commandsVersion.set((v) => v + 1);
  return () => {
    if (commands.get(def.id)?.run === def.run) {
      commands.delete(def.id);
      commandsVersion.set((v) => v + 1);
    }
  };
}

/** @param {string} id */
export const hasCommand = (id) => commands.has(id);

/** @param {string} id @returns {CommandInfo | undefined} */
export function getCommand(id) {
  const c = commands.get(id);
  if (!c) return undefined;
  const { run: _run, ...info } = c;
  return info;
}

/** @param {string} id @param {Record<string, unknown>} [ctx] */
export function isCommandEnabled(id, ctx) {
  const c = commands.get(id);
  return Boolean(c) && evaluateWhen(c.when, ctx);
}

/**
 * All commands (optionally only those available in the current context), sorted by category/title.
 * @param {{ availableOnly?: boolean, paletteOnly?: boolean }} [opts]
 * @returns {CommandInfo[]}
 */
export function listCommands({ availableOnly = false, paletteOnly = false } = {}) {
  return [...commands.values()]
    .filter((c) => (!availableOnly || evaluateWhen(c.when)) && (!paletteOnly || c.palette !== false))
    .map(({ run: _run, ...info }) => info)
    .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}

/**
 * Execute a command. Unknown or unavailable commands resolve to `{ ok: false }` rather than
 * throwing, so callers (shortcuts, menus) need no error handling of their own.
 * @param {string} id
 * @param {unknown} [args]
 * @returns {Promise<{ ok: boolean, value?: unknown, reason?: string }>}
 */
export async function executeCommand(id, args) {
  const c = commands.get(id);
  if (!c) return { ok: false, reason: 'unknown' };
  if (!evaluateWhen(c.when)) return { ok: false, reason: 'unavailable' };
  recentCommands.set((r) => [id, ...r.filter((x) => x !== id)].slice(0, RECENT_LIMIT));
  try {
    return { ok: true, value: await c.run(args) };
  } catch (err) {
    errorHandler(err, id);
    return { ok: false, reason: 'error' };
  }
}

/** Test helper: remove all commands. */
export function _resetCommands() {
  commands.clear();
  recentCommands.set([]);
  commandsVersion.set((v) => v + 1);
}
