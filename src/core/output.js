// Output client: mirrors backend output channels for the Output panel and lets UI code log to
// the `ui` channel. Entries are delivered by events and batched per animation frame.
import { createStore } from './store.js';
import * as ipc from '../platform/ipc.js';

/** @typedef {{ channel: string, seq: number, ts: number, level: 'trace'|'info'|'warn'|'error', message: string }} OutputEntry */
/** @typedef {{ id: string, label: string, lines: number, uiWritable: boolean }} ChannelInfo */

const CLIENT_LIMIT = 5000;

/** @type {import('./store.js').Store<{ channels: ChannelInfo[], entries: Record<string, OutputEntry[]> }>} */
export const outputStore = createStore({ channels: [], entries: {} });

/** @type {OutputEntry[]} */
let pending = [];
let scheduled = false;

function flush() {
  scheduled = false;
  const batch = pending;
  pending = [];
  outputStore.set((s) => {
    const entries = { ...s.entries };
    for (const e of batch) {
      const list = entries[e.channel];
      // Only channels that were opened (loaded) are mirrored; others are fetched on demand.
      if (!list) continue;
      if (list.length && list[list.length - 1].seq >= e.seq) continue;
      entries[e.channel] = [...list, e].slice(-CLIENT_LIMIT);
    }
    return { ...s, entries };
  });
}

/** @param {OutputEntry} entry */
export function receiveEntry(entry) {
  pending.push(entry);
  if (!scheduled) {
    scheduled = true;
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(flush);
  }
}

/** Start listening for backend output. Returns an unsubscribe function. */
export function startOutput() {
  return ipc.onEvent(ipc.events.outputEntry, receiveEntry);
}

export async function loadChannels() {
  if (!ipc.isTauri()) return;
  const channels = await ipc.outputChannels();
  outputStore.set((s) => ({ ...s, channels }));
}

/** Load (or reload) a channel's history and start mirroring it. @param {string} channel */
export async function openChannel(channel) {
  if (!ipc.isTauri()) {
    outputStore.set((s) => ({ ...s, entries: { ...s.entries, [channel]: s.entries[channel] || [] } }));
    return;
  }
  const lines = await ipc.outputRead(channel, 0);
  outputStore.set((s) => ({ ...s, entries: { ...s.entries, [channel]: lines.slice(-CLIENT_LIMIT) } }));
}

/** @param {string} channel */
export async function clearChannel(channel) {
  if (ipc.isTauri()) await ipc.outputClear(channel);
  outputStore.set((s) => ({ ...s, entries: { ...s.entries, [channel]: [] } }));
}

/**
 * Log from UI code to the `ui` channel. Never throws.
 * @param {'trace'|'info'|'warn'|'error'} level
 * @param {string} message
 */
export function uiLog(level, message) {
  if (!ipc.isTauri()) {
    (level === 'error' ? console.error : console.log)(`[ui] ${message}`);
    return;
  }
  ipc.outputAppend('ui', level, String(message)).catch(() => {});
}

/** Format an entry for display / copy. @param {OutputEntry} e */
export function formatEntry(e) {
  const d = new Date(e.ts);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return `[${time}] [${e.level}] ${e.message}`;
}
