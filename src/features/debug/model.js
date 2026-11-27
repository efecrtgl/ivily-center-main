// Debugging: launch configurations, one active session at a time, breakpoints, stepping,
// call stack, variables and the debug console.
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter } from '@codemirror/view';
import { RangeSet, StateEffect, StateField } from '@codemirror/state';
import { createStore } from '../../core/store.js';
import { setContext } from '../../core/context.js';
import { notify } from '../../core/notifications.js';
import { errorCode, errorMessage } from '../../core/errors.js';
import { confirmDialog } from '../../core/dialogs.js';
import { quickPick } from '../../core/quickPick.js';
import { showPanelView, updateLayout } from '../../core/layout.js';
import * as ipc from '../../platform/ipc.js';
import { markSessionDirty, registerSessionParticipant } from '../../workspace/session.js';
import { workspaceStore } from '../../workspace/store.js';
import { activeEditor, openDocument, registerEditorExtension, revealInDocument, viewsOf } from '../editor/model.js';
import { toWorkspaceRef } from '../tasks/matchers.js';
import { DapClient } from './client.js';

export const debugStore = createStore({
  /** @type {null | { configs: any[], adapters: any[], issues: string[], canRun: boolean }} */
  info: null,
  /** @type {null | { id: number, name: string, adapter: string, state: 'starting' | 'running' | 'stopped' | 'terminated', threads: any[], threadId: number | null, frames: any[], frameId: number | null, scopes: any[], reason: string | null, capabilities: any }} */
  session: null,
  /** doc key → [{ line, verified, message }] */
  breakpoints: /** @type {Record<string, { line: number, verified?: boolean, message?: string }[]>} */ ({}),
  /** @type {{ category: string, text: string }[]} */
  console: [],
  /** variablesReference → children */
  variables: /** @type {Record<number, any[]>} */ ({}),
});

/** @type {DapClient | null} */
let client = null;
let unlisten = null;
let unlistenExit = null;
let lastConfigId = null;
const MAX_CONSOLE = 5000;

const set = (patch) => debugStore.set((s) => ({ ...s, ...patch }));
const setSession = (patch) => debugStore.set((s) => (s.session ? { ...s, session: { ...s.session, ...patch } } : s));

function publishContext() {
  const st = debugStore.get().session?.state ?? 'inactive';
  setContext('inDebugMode', st !== 'inactive' && st !== 'terminated');
  setContext('debugState', st);
}
debugStore.subscribe(publishContext);

export function consoleAppend(category, text) {
  debugStore.set((s) => ({ ...s, console: [...s.console, { category, text: String(text) }].slice(-MAX_CONSOLE) }));
}

// ── Info ────────────────────────────────────────────────────────────────────

export async function loadDebugInfo(refresh = false) {
  if (!ipc.isTauri() || !workspaceStore.get().current) {
    set({ info: null });
    return null;
  }
  try {
    const info = await ipc.dapInfo(refresh);
    set({ info });
    return info;
  } catch (e) {
    notify({ severity: 'error', title: 'Could not read launch configurations', message: errorMessage(e), source: 'debug' });
    return null;
  }
}

// ── Paths ───────────────────────────────────────────────────────────────────

const folders = () => workspaceStore.get().current?.folders ?? [];
const isWorkspaceKey = (key) => /^\d+:/.test(key);
const parseKey = (key) => ({ root: Number(key.slice(0, key.indexOf(':'))), path: key.slice(key.indexOf(':') + 1) });
export function absPathOf(key) {
  const { root, path } = parseKey(key);
  const base = folders()[root]?.path;
  return base ? `${base.replace(/[\\/]+$/, '')}\\${path.replace(/\//g, '\\')}` : null;
}
const keyOfPath = (abs) => {
  const ref = abs ? toWorkspaceRef(abs, '', folders()) : null;
  return ref ? `${ref.root}:${ref.path}` : null;
};

// ── Breakpoints (gutter + persistence) ──────────────────────────────────────

const setBpEffect = StateEffect.define();
class BpMarker extends GutterMarker {
  constructor(verified) {
    super();
    this.verified = verified;
  }
  eq(o) {
    return o.verified === this.verified;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = `cm-breakpoint${this.verified === false ? ' cm-breakpoint--unverified' : ''}`;
    s.title = this.verified === false ? 'Breakpoint (not verified by the debugger)' : 'Breakpoint';
    return s;
  }
}
BpMarker.prototype.startSide = 1;
BpMarker.prototype.endSide = 1;
const bpOn = new BpMarker(true);
const bpOff = new BpMarker(false);

function bpSet(doc, list) {
  return RangeSet.of(
    [...list].filter((b) => b.line >= 1 && b.line <= doc.lines).sort((a, b) => a.line - b.line).map((b) => (b.verified === false ? bpOff : bpOn).range(doc.line(b.line).from)),
  );
}

function linesOf(state, field) {
  const out = [];
  const it = state.field(field).iter();
  while (it.value) {
    out.push(state.doc.lineAt(it.from).number);
    it.next();
  }
  return [...new Set(out)];
}

function breakpointExtension(key) {
  if (!isWorkspaceKey(key)) return [];
  const field = StateField.define({
    create: (st) => bpSet(st.doc, debugStore.get().breakpoints[key] ?? []),
    update(v, tr) {
      let next = v.map(tr.changes);
      for (const e of tr.effects) if (e.is(setBpEffect)) next = bpSet(tr.state.doc, e.value);
      return next;
    },
  });
  return [
    field,
    gutter({
      class: 'cm-breakpoints',
      markers: (v) => v.state.field(field),
      initialSpacer: () => bpOn,
      domEventHandlers: {
        mousedown(view, block) {
          toggleBreakpointAt(key, view.state.doc.lineAt(block.from).number);
          return true;
        },
      },
    }),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      const lines = linesOf(u.state, field);
      const cur = debugStore.get().breakpoints[key] ?? [];
      if (lines.length === cur.length && lines.every((l, i) => l === cur[i]?.line)) return;
      writeBreakpoints(key, lines.map((line) => ({ line })), false);
    }),
  ];
}

function writeBreakpoints(key, list, applyToViews = true) {
  debugStore.set((s) => {
    const breakpoints = { ...s.breakpoints };
    if (list.length) breakpoints[key] = list;
    else delete breakpoints[key];
    return { ...s, breakpoints };
  });
  if (applyToViews) for (const v of viewsOf(key)) v.dispatch({ effects: setBpEffect.of(list) });
  markSessionDirty();
}

export function toggleBreakpointAt(key, line) {
  if (!isWorkspaceKey(key)) {
    notify({ severity: 'info', title: 'Breakpoints are available for files in the workspace', source: 'debug' });
    return;
  }
  const cur = debugStore.get().breakpoints[key] ?? [];
  const next = cur.some((b) => b.line === line) ? cur.filter((b) => b.line !== line) : [...cur, { line }].sort((a, b) => a.line - b.line);
  writeBreakpoints(key, next);
  if (client && debugStore.get().session?.state !== 'terminated') sendBreakpoints(key).catch(() => {});
}

export function toggleBreakpoint() {
  const ed = activeEditor();
  if (!ed?.view) return;
  toggleBreakpointAt(ed.key, ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number);
}

export async function removeAllBreakpoints() {
  const keys = Object.keys(debugStore.get().breakpoints);
  if (!keys.length) return;
  const ok = await confirmDialog({ title: 'Remove all breakpoints?', confirmLabel: 'Remove', danger: true });
  if (!ok) return;
  for (const k of keys) {
    writeBreakpoints(k, []);
    if (client) sendBreakpoints(k).catch(() => {});
  }
}

async function sendBreakpoints(key) {
  const path = absPathOf(key);
  if (!client || !path) return;
  const list = debugStore.get().breakpoints[key] ?? [];
  const r = await client.request('setBreakpoints', { source: { path, name: path.slice(path.lastIndexOf('\\') + 1) }, breakpoints: list.map((b) => ({ line: b.line })), lines: list.map((b) => b.line) });
  const verified = list.map((b, i) => ({ line: r.breakpoints?.[i]?.line ?? b.line, verified: r.breakpoints?.[i]?.verified !== false, message: r.breakpoints?.[i]?.message }));
  writeBreakpoints(key, verified);
}

// ── Current-line highlight ──────────────────────────────────────────────────

/** @type {{ key: string, line: number } | null} */
let stoppedAt = null;
const refreshEffect = StateEffect.define();
const stoppedLine = Decoration.line({ class: 'cm-debug-stopped' });
function stoppedExtension(key) {
  const build = (view) => (stoppedAt && stoppedAt.key === key && stoppedAt.line <= view.state.doc.lines ? Decoration.set([stoppedLine.range(view.state.doc.line(stoppedAt.line).from)]) : Decoration.none);
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = build(view);
      }
      update(u) {
        this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
function setStoppedAt(loc) {
  const prev = stoppedAt;
  stoppedAt = loc;
  for (const k of new Set([prev?.key, loc?.key].filter(Boolean))) for (const v of viewsOf(k)) v.dispatch({ effects: refreshEffect.of(null) });
}

// ── Session ─────────────────────────────────────────────────────────────────

function activeFileRef() {
  const ed = activeEditor();
  return ed?.doc?.ref && 'root' in ed.doc.ref ? ed.doc.ref : null;
}

/** Start debugging (asks which configuration when there are several). */
export async function startDebugging(configId) {
  if (debugStore.get().session && debugStore.get().session.state !== 'terminated') return continueExecution();
  const info = await loadDebugInfo();
  if (!info) return false;
  if (!info.canRun) {
    notify({ severity: 'warning', title: 'Debugging is disabled in Restricted Mode', message: 'Trust this workspace for “Debugging” to start launch configurations.', source: 'debug', actions: [{ label: 'Manage Workspace Trust', command: 'trust.manage' }] });
    return false;
  }
  let cfg = info.configs.find((c) => c.id === (configId ?? lastConfigId));
  if (!cfg) {
    if (!info.configs.length) {
      notify({ severity: 'info', title: 'No launch configurations', message: 'Add one to .ivily/launch.json or .vscode/launch.json (Debug: Add Configuration).', source: 'debug', actions: [{ label: 'Add Configuration', command: 'debug.configure' }] });
      return false;
    }
    if (info.configs.length === 1) cfg = info.configs[0];
    else {
      const item = await quickPick({ placeholder: 'Select a launch configuration', items: info.configs.map((c) => ({ id: c.id, label: c.name, description: `${c.type} · ${c.request}${c.adapter ? '' : ' · no adapter installed'}` })) });
      if (!item) return false;
      cfg = info.configs.find((c) => c.id === item.id);
    }
  }
  if (!cfg.adapter) {
    notify({ severity: 'warning', title: `No debug adapter for “${cfg.type}”`, message: 'Install a debug adapter for this language (e.g. debugpy, lldb-dap, netcoredbg) or configure one in the setting “Additional debug adapters”.', source: 'debug' });
    return false;
  }
  lastConfigId = cfg.id;
  try {
    let r = await ipc.dapStart(cfg.id, false, activeFileRef());
    if (r.kind === 'needsApproval') {
      const ok = await confirmDialog({
        title: `Start “${cfg.name}”?`,
        message: `This launch configuration comes from the workspace and will be run by ${r.adapter} with your user rights. Approve it only if you trust it; you will be asked again if it changes.`,
        detail: JSON.stringify(r.config, null, 2).slice(0, 4000),
        confirmLabel: 'Approve and start',
      });
      if (!ok) return false;
      r = await ipc.dapStart(cfg.id, true, activeFileRef());
    }
    return await runSession(cfg, r);
  } catch (e) {
    if (client) stopDebugging();
    notify({ severity: 'error', title: 'Could not start debugging', message: errorMessage(e), source: 'debug', ...(errorCode(e) === 'workspace_untrusted' ? { actions: [{ label: 'Manage Workspace Trust', command: 'trust.manage' }] } : {}) });
    return false;
  }
}

async function runSession(cfg, started) {
  const id = started.id;
  client = new DapClient((text) => ipc.dapSend(id, text).catch(() => {}));
  set({ session: { id, name: cfg.name, adapter: started.adapter, state: 'starting', threads: [], threadId: null, frames: [], frameId: null, scopes: [], reason: null, capabilities: {} }, console: [], variables: {} });
  showPanelView('debugConsole');
  updateLayout({ sidebarVisible: true, sidebarView: 'debug' });
  unlisten = ipc.onEvent('dap://message', (p) => p.id === id && client?.receive(p.body));
  unlistenExit = ipc.onEvent('dap://exit', (p) => p.id === id && endSession('the debug adapter exited'));
  const initialized = new Promise((resolve) => {
    const off = client.onEvent((ev) => {
      if (ev === 'initialized') {
        off();
        resolve(null);
      }
    });
  });
  client.onEvent(onEvent);
  consoleAppend('info', `Starting ${cfg.name} with ${started.adapter}…`);
  const caps = await client.request('initialize', { clientID: 'ivily-center', clientName: 'Ivily Center', adapterID: started.adapterId, pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsRunInTerminalRequest: false, locale: 'en' });
  setSession({ capabilities: caps ?? {} });
  const launched = client.request(started.request, started.config);
  launched.catch((e) => {
    consoleAppend('stderr', `${started.request} failed: ${errorMessage(e)}`);
    stopDebugging();
  });
  await Promise.race([initialized, launched.then(() => initialized)]);
  for (const key of Object.keys(debugStore.get().breakpoints)) await sendBreakpoints(key).catch(() => {});
  if (caps?.supportsConfigurationDoneRequest) await client.request('configurationDone').catch(() => {});
  await launched.catch(() => {});
  if (debugStore.get().session?.state === 'starting') setSession({ state: 'running' });
  return true;
}

async function onEvent(event, body) {
  if (event === 'output') {
    if (body.category !== 'telemetry') consoleAppend(body.category ?? 'console', String(body.output ?? '').replace(/\r?\n$/, ''));
  } else if (event === 'stopped') {
    setSession({ state: 'stopped', reason: body.reason ?? null, threadId: body.threadId ?? debugStore.get().session?.threadId ?? null });
    await refreshStopped(body.threadId);
  } else if (event === 'continued') {
    setSession({ state: 'running', frames: [], scopes: [], frameId: null });
    setStoppedAt(null);
  } else if (event === 'terminated') {
    endSession('the program ended');
  } else if (event === 'exited') {
    consoleAppend('info', `Program exited with code ${body.exitCode}.`);
  } else if (event === 'breakpoint' && body.breakpoint?.source?.path) {
    const key = keyOfPath(body.breakpoint.source.path);
    if (key) {
      const list = (debugStore.get().breakpoints[key] ?? []).map((b) => (b.line === body.breakpoint.line ? { ...b, verified: body.breakpoint.verified !== false } : b));
      writeBreakpoints(key, list);
    }
  }
}

async function refreshStopped(threadId) {
  if (!client) return;
  try {
    const { threads = [] } = await client.request('threads');
    const tid = threadId ?? threads[0]?.id ?? null;
    setSession({ threads, threadId: tid });
    if (tid == null) return;
    const { stackFrames = [] } = await client.request('stackTrace', { threadId: tid, startFrame: 0, levels: 50 });
    setSession({ frames: stackFrames });
    if (stackFrames[0]) await selectFrame(stackFrames[0]);
  } catch (e) {
    consoleAppend('stderr', `Could not read the call stack: ${errorMessage(e)}`);
  }
}

export async function selectFrame(frame) {
  if (!client) return;
  setSession({ frameId: frame.id });
  const key = keyOfPath(frame.source?.path);
  if (key) {
    setStoppedAt({ key, line: frame.line });
    revealInDocument(parseKey(key), frame.line, Math.max(0, (frame.column ?? 1) - 1), undefined, { focus: false });
  } else setStoppedAt(null);
  try {
    const { scopes = [] } = await client.request('scopes', { frameId: frame.id });
    debugStore.set((s) => ({ ...s, variables: {}, session: s.session ? { ...s.session, scopes } : s.session }));
    const first = scopes.find((sc) => !sc.expensive);
    if (first) await loadVariables(first.variablesReference);
  } catch {
    /* adapter may not support scopes for this frame */
  }
}

export async function loadVariables(ref) {
  if (!client || !ref) return [];
  try {
    const { variables = [] } = await client.request('variables', { variablesReference: ref });
    debugStore.set((s) => ({ ...s, variables: { ...s.variables, [ref]: variables } }));
    return variables;
  } catch {
    return [];
  }
}

const threadArgs = () => ({ threadId: debugStore.get().session?.threadId ?? 0 });
async function step(command) {
  if (!client || debugStore.get().session?.state !== 'stopped') return;
  setSession({ state: 'running' });
  setStoppedAt(null);
  await client.request(command, threadArgs()).catch((e) => consoleAppend('stderr', `${command}: ${errorMessage(e)}`));
}
export const continueExecution = () => step('continue');
export const stepOver = () => step('next');
export const stepInto = () => step('stepIn');
export const stepOut = () => step('stepOut');
export async function pauseExecution() {
  if (client && debugStore.get().session?.state === 'running') await client.request('pause', threadArgs()).catch(() => {});
}

export async function stopDebugging() {
  const s = debugStore.get().session;
  if (!s || !client) return;
  const id = s.id;
  const c = client;
  await Promise.race([c.request('disconnect', { terminateDebuggee: true }).catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  await ipc.dapStop(id).catch(() => {});
  endSession('stopped');
}

export async function restartDebugging() {
  const cfg = lastConfigId;
  await stopDebugging();
  return startDebugging(cfg);
}

function endSession(why) {
  if (!debugStore.get().session || debugStore.get().session.state === 'terminated') return;
  consoleAppend('info', `Debug session ended (${why}).`);
  client?.close();
  client = null;
  unlisten?.();
  unlistenExit?.();
  unlisten = unlistenExit = null;
  setStoppedAt(null);
  setSession({ state: 'terminated', frames: [], scopes: [], threads: [] });
  // Unverified marks are meaningless without a session.
  for (const [k, list] of Object.entries(debugStore.get().breakpoints)) writeBreakpoints(k, list.map((b) => ({ line: b.line })));
}

/** Evaluate an expression in the selected frame (Debug Console). */
export async function evaluate(expression) {
  const text = expression.trim();
  if (!text) return;
  consoleAppend('input', `> ${text}`);
  if (!client) return consoleAppend('stderr', 'No debug session is running.');
  try {
    const r = await client.request('evaluate', { expression: text, frameId: debugStore.get().session?.frameId ?? undefined, context: 'repl' });
    consoleAppend('result', r.result ?? '');
  } catch (e) {
    consoleAppend('stderr', errorMessage(e));
  }
}

// ── Launch file template ────────────────────────────────────────────────────

const TEMPLATE = `{
  // Launch configurations for Ivily Center (same format as VS Code's launch.json).
  // Supported variables: \${workspaceFolder}, \${workspaceFolderBasename}, \${file},
  // \${fileBasename}, \${fileBasenameNoExtension}, \${fileDirname}, \${fileExtname}, \${relativeFile}.
  // Each configuration asks for approval before its first start.
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Python: current file",
      "type": "python",
      "request": "launch",
      "program": "\${file}",
      "console": "internalConsole"
    }
  ]
}
`;

export async function configureLaunch() {
  const ws = workspaceStore.get().current;
  if (!ws || !ipc.isTauri()) return;
  const exists = (e) => errorCode(e) === 'conflict';
  try {
    await ipc.fsCreateDir(0, '.ivily').catch((e) => {
      if (!exists(e)) throw e;
    });
    let created = true;
    await ipc.fsCreateFile(0, '.ivily/launch.json').catch((e) => {
      if (!exists(e)) throw e;
      created = false;
    });
    await openDocument({ root: 0, path: '.ivily/launch.json' });
    if (created) {
      requestAnimationFrame(() => {
        const ed = activeEditor();
        if (ed?.view && ed.view.state.doc.length === 0) ed.view.dispatch({ changes: { from: 0, insert: TEMPLATE } });
      });
    }
  } catch (e) {
    notify({ severity: 'error', title: 'Could not create launch.json', message: errorMessage(e), source: 'debug' });
  }
}

export async function revokeDebugApprovals() {
  const ok = await confirmDialog({ title: 'Revoke launch approvals?', message: 'Every launch configuration of this workspace will ask for approval again.', confirmLabel: 'Revoke' });
  if (ok) await ipc.dapRevokeApprovals().catch(() => {});
}

// ── Install ─────────────────────────────────────────────────────────────────

let installed = false;
export function installDebug() {
  if (installed) return;
  installed = true;
  registerEditorExtension((key) => [breakpointExtension(key), stoppedExtension(key)]);
  registerSessionParticipant('breakpoints', {
    save: () => Object.fromEntries(Object.entries(debugStore.get().breakpoints).map(([k, v]) => [k, v.map((b) => b.line)])),
    restore: (data) => {
      const clean = {};
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) if (isWorkspaceKey(k) && Array.isArray(v)) clean[k] = [...new Set(v.filter((l) => Number.isInteger(l) && l > 0))].slice(0, 500).map((line) => ({ line }));
      }
      set({ breakpoints: clean });
      for (const [k, v] of Object.entries(clean)) for (const view of viewsOf(k)) view.dispatch({ effects: setBpEffect.of(v) });
    },
    reset: () => set({ breakpoints: {} }),
  });
  let wsId = '';
  workspaceStore.subscribe(() => {
    const ws = workspaceStore.get().current;
    const next = ws ? `${ws.record.id}|${ws.trust.capabilities.includes('debugging')}` : '';
    if (next === wsId) return;
    wsId = next;
    if (client) endSession('workspace changed');
    set({ session: null });
    lastConfigId = null;
    loadDebugInfo();
  });
  publishContext();
}
