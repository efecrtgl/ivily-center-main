// Tasks: list, run (with dependencies), approvals, cancel, history and problem matching.
//
// The backend resolves every task from the workspace files and enforces trust and approval; this
// module asks the user to approve unapproved commands (showing each exact command), runs the plan
// in order (or in parallel when `dependsOrder` says so) and stops a chain at the first failure.
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorCode, errorMessage } from '../../core/errors.js';
import { confirmDialog } from '../../core/dialogs.js';
import { quickPick } from '../../core/quickPick.js';
import { uiLog } from '../../core/output.js';
import * as ipc from '../../platform/ipc.js';
import { isCurrentEpoch, workspaceStore } from '../../workspace/store.js';
import { createTerminal, onTerminalExited, terminalStore } from '../terminal/model.js';
import { createMatcher, lineSplitter, toWorkspaceRef } from './matchers.js';

export const HISTORY_KEY = 'ui.tasks.history';
const HISTORY_LIMIT = 30;

/**
 * @typedef {{ id: string, label: string, source: string, root: number, cwd: string, group: string | null, dependsOn: string[], dependsOrder: string, problemMatchers: string[], detail: string | null, error: string | null, command: string, approved: boolean, exec: any }} TaskInfo
 * @typedef {{ label: string, taskId: string, started: number, ended: number | null, code: number | null, status: 'running' | 'succeeded' | 'failed' | 'cancelled' }} HistoryEntry
 */

export const tasksStore = createStore({
  /** @type {TaskInfo[]} */
  tasks: [],
  /** @type {{ root: number, file: string, message: string }[]} */
  issues: [],
  canRun: false,
  loaded: false,
  /** taskId → terminal id */
  running: /** @type {Record<string, number>} */ ({}),
  /** @type {HistoryEntry[]} */
  history: [],
  /** @type {string | null} */
  lastTaskId: null,
});

/** Problems reported by task problem matchers, per task id. */
export const taskProblemsStore = createStore(/** @type {Record<string, { ref: { root: number, path: string } | null, file: string, line: number, col: number, severity: string, message: string, code?: string, source: string }[]>} */ ({}));

/** terminal id → resolver of the run's exit code */
const waiters = new Map();
let installed = false;

export async function loadTasks() {
  if (!ipc.isTauri() || !workspaceStore.get().current) {
    tasksStore.set((s) => ({ ...s, tasks: [], issues: [], canRun: false, loaded: true }));
    return [];
  }
  const epoch = workspaceStore.get().epoch;
  try {
    const r = await ipc.tasksList();
    if (!isCurrentEpoch(epoch)) return [];
    tasksStore.set((s) => ({ ...s, tasks: r.tasks, issues: r.issues, canRun: r.canRun, loaded: true }));
    for (const i of r.issues) uiLog('warn', `tasks: ${i.file}: ${i.message}`);
    return r.tasks;
  } catch (e) {
    notify({ severity: 'error', title: 'Could not read tasks', message: errorMessage(e), source: 'tasks' });
    return [];
  }
}

/** Dependencies first (same rules as the backend): by label in the same folder, then anywhere. */
export function planTask(tasks, id) {
  const out = [];
  const visit = (t, stack) => {
    if (out.includes(t)) return;
    if (stack.includes(t.id)) throw new Error(`Tasks depend on each other: ${t.label}`);
    for (const d of t.dependsOn) {
      const dep = tasks.find((x) => x.root === t.root && x.label === d) ?? tasks.find((x) => x.label === d);
      if (!dep) throw new Error(`Task '${d}' (needed by '${t.label}') was not found`);
      visit(dep, [...stack, t.id]);
    }
    out.push(t);
  };
  const t = tasks.find((x) => x.id === id);
  if (!t) throw new Error('Task not found');
  visit(t, []);
  return out;
}

async function saveHistory() {
  if (ipc.isTauri()) ipc.uiStateSet(HISTORY_KEY, tasksStore.get().history.filter((h) => h.status !== 'running')).catch(() => {});
}

export async function loadHistory() {
  if (!ipc.isTauri()) return;
  try {
    const h = await ipc.uiStateGet(HISTORY_KEY);
    if (Array.isArray(h)) tasksStore.set((s) => ({ ...s, history: h.filter((x) => x && typeof x.label === 'string').slice(0, HISTORY_LIMIT) }));
  } catch {
    /* convenience only */
  }
}

function addHistory(entry) {
  tasksStore.set((s) => ({ ...s, history: [entry, ...s.history].slice(0, HISTORY_LIMIT) }));
}
function finishHistory(entry, patch) {
  tasksStore.set((s) => ({ ...s, history: s.history.map((h) => (h === entry ? Object.assign(entry, patch) : h)) }));
  saveHistory();
}

/** Start one task in a terminal and resolve with its exit code (null when unknown/cancelled). */
async function startOne(task, approve) {
  const ws = workspaceStore.get().current;
  const folder = ws?.folders[task.root]?.path ?? '';
  const cwd = task.cwd ? `${folder}\\${task.cwd.replace(/\//g, '\\')}` : folder;
  const matcher = task.problemMatchers.length ? createMatcher(task.problemMatchers) : null;
  taskProblemsStore.set((p) => ({ ...p, [task.id]: [] }));
  const splitter = matcher
    ? lineSplitter((line) => {
        const found = matcher.push(line);
        if (found.length) {
          const mapped = found.map((f) => ({ ...f, ref: toWorkspaceRef(f.file, cwd, ws?.folders ?? []) }));
          taskProblemsStore.set((p) => ({ ...p, [task.id]: [...(p[task.id] ?? []), ...mapped].slice(0, 5000) }));
        }
      })
    : null;
  const entry = { label: task.label, taskId: task.id, started: Date.now(), ended: null, code: null, status: /** @type {const} */ ('running') };
  addHistory(entry);
  let termId = null;
  const done = new Promise((resolve) => {
    createTerminal({
      title: task.label,
      start: (channel, cols, rows) => ipc.taskRun(task.id, approve, cols, rows, channel),
      onOutput: splitter ? (b) => splitter.write(b) : undefined,
      onStarted: (_backendId, id) => {
        termId = id;
        waiters.set(id, (code) => {
          splitter?.end();
          resolve(code);
        });
        tasksStore.set((s) => ({ ...s, running: { ...s.running, [task.id]: id }, lastTaskId: task.id }));
      },
    }).catch((e) => {
        finishHistory(entry, { ended: Date.now(), status: 'failed' });
        resolve({ error: e });
      });
  });
  const result = await done;
  tasksStore.set((s) => {
    const running = { ...s.running };
    delete running[task.id];
    return { ...s, running };
  });
  if (result && typeof result === 'object') throw result.error;
  const cancelled = cancelledTerms.has(termId);
  cancelledTerms.delete(termId);
  finishHistory(entry, { ended: Date.now(), code: result, status: cancelled || result == null ? 'cancelled' : result === 0 ? 'succeeded' : 'failed' });
  return cancelled ? null : result;
}

const cancelledTerms = new Set();

/**
 * Run a task with its dependencies. Asks for trust/approval as needed.
 * @param {string} id
 */
export async function runTask(id) {
  const st = tasksStore.get();
  if (!st.canRun) {
    notify({ severity: 'warning', title: 'Tasks are disabled in Restricted Mode', message: 'Trust this workspace for “Run tasks” to run its tasks.', source: 'tasks', actions: [{ label: 'Manage Workspace Trust', command: 'trust.manage' }] });
    return false;
  }
  let plan;
  try {
    plan = planTask(st.tasks, id);
  } catch (e) {
    notify({ severity: 'error', title: 'Cannot run the task', message: errorMessage(e), source: 'tasks' });
    return false;
  }
  const broken = plan.find((t) => t.error);
  if (broken) {
    notify({ severity: 'error', title: `Task “${broken.label}” cannot run`, message: broken.error, source: 'tasks' });
    return false;
  }
  const busy = plan.find((t) => st.running[t.id] != null && t.command);
  if (busy) {
    notify({ severity: 'info', title: `“${busy.label}” is already running`, source: 'tasks' });
    return false;
  }
  const unapproved = plan.filter((t) => t.command && !t.approved);
  if (unapproved.length) {
    const ok = await confirmDialog({
      title: unapproved.length === 1 ? `Run task “${unapproved[0].label}”?` : `Run ${unapproved.length} tasks for the first time?`,
      message:
        'These commands come from the workspace and will run with your user rights. They are shown exactly as they will run. ' +
        'Approve only if you trust them; you will be asked again if a command changes.',
      detail: unapproved.map((t) => `${t.label}  (${t.source}${t.cwd ? `, in ${t.cwd}` : ''})\n  ${t.command}`).join('\n\n'),
      confirmLabel: 'Approve and run',
    });
    if (!ok) return false;
  }
  const approveIds = new Set(unapproved.map((t) => t.id));
  const target = plan[plan.length - 1];
  const deps = plan.slice(0, -1);
  try {
    if (target.dependsOrder === 'parallel' && deps.length) {
      const codes = await Promise.all(deps.filter((t) => t.command).map((t) => startOne(t, approveIds.has(t.id))));
      if (codes.some((c) => c !== 0)) return stopped(target, 'a dependency failed');
    } else {
      for (const t of deps) {
        if (!t.command) continue;
        const code = await startOne(t, approveIds.has(t.id));
        if (code !== 0) return stopped(target, `“${t.label}” ${code == null ? 'was stopped' : `exited with code ${code}`}`);
      }
    }
    if (!target.command) return true;
    const code = await startOne(target, approveIds.has(target.id));
    if (code !== 0 && code != null) notify({ severity: 'warning', title: `Task “${target.label}” failed`, message: `Exit code ${code}.`, source: 'tasks' });
    return code === 0;
  } catch (e) {
    const code = errorCode(e);
    notify({ severity: 'error', title: `Task “${target.label}” could not start`, message: errorMessage(e), source: 'tasks', ...(code === 'workspace_untrusted' ? { actions: [{ label: 'Manage Workspace Trust', command: 'trust.manage' }] } : {}) });
    return false;
  } finally {
    loadTasks();
  }
}

function stopped(target, why) {
  notify({ severity: 'warning', title: `Task “${target.label}” did not run`, message: `Stopped because ${why}.`, source: 'tasks' });
  return false;
}

/** Stop a running task (kills its process tree). */
export function terminateTask(id) {
  const termId = tasksStore.get().running[id];
  if (termId == null) return;
  cancelledTerms.add(termId);
  const t = terminalStore.get().terminals.find((x) => x.id === termId);
  if (t?.backendId != null) ipc.terminalKill(t.backendId).catch(() => {});
}

const itemFor = (t) => ({
  id: t.id,
  label: t.label,
  description: t.error ? `⚠ ${t.error}` : t.command || (t.dependsOn.length ? `runs ${t.dependsOn.join(', ')}` : ''),
  detail: t.detail ?? undefined,
  group: t.source === 'ivily' || t.source === 'vscode' ? 'workspace tasks' : `detected (${t.source})`,
});

/** Quick pick of tasks (optionally a group: build / test). */
export async function pickAndRun(group) {
  const tasks = await loadTasks();
  let list = group ? tasks.filter((t) => t.group === group) : tasks;
  if (group && list.length === 1) return runTask(list[0].id);
  if (!list.length) list = tasks;
  if (!list.length) {
    notify({ severity: 'info', title: 'No tasks found', message: 'Add tasks to .ivily/tasks.json (Tasks: Configure Tasks), or open a folder with package.json or Cargo.toml.', source: 'tasks', actions: [{ label: 'Configure Tasks', command: 'tasks.configure' }] });
    return false;
  }
  const item = await quickPick({ placeholder: group ? `Select the ${group} task to run` : 'Select the task to run', items: list.map(itemFor), matchOnDescription: true });
  return item ? runTask(item.id) : false;
}

export async function pickAndTerminate() {
  const st = tasksStore.get();
  const running = st.tasks.filter((t) => st.running[t.id] != null);
  if (!running.length) return notify({ severity: 'info', title: 'No task is running', source: 'tasks' });
  if (running.length === 1) return terminateTask(running[0].id);
  const item = await quickPick({ placeholder: 'Select the task to stop', items: running.map(itemFor) });
  if (item) terminateTask(item.id);
}

export function rerunLast() {
  const id = tasksStore.get().lastTaskId ?? tasksStore.get().history[0]?.taskId;
  if (!id) return pickAndRun();
  return runTask(id);
}

export async function showHistory() {
  const h = tasksStore.get().history;
  if (!h.length) return notify({ severity: 'info', title: 'No tasks have run yet', source: 'tasks' });
  const fmt = (e) => (e.ended ? `${((e.ended - e.started) / 1000).toFixed(1)} s` : 'running');
  const item = await quickPick({
    placeholder: 'Task history — select to run again',
    items: h.map((e, i) => ({ id: `${i}`, label: e.label, description: `${e.status}${e.code != null ? ` (code ${e.code})` : ''} · ${fmt(e)} · ${new Date(e.started).toLocaleString()}` })),
  });
  if (item) runTask(h[Number(item.id)].taskId);
}

export async function revokeApprovals() {
  const ok = await confirmDialog({ title: 'Revoke task approvals?', message: 'Every task of this workspace will ask for approval again before it runs.', confirmLabel: 'Revoke' });
  if (!ok) return;
  try {
    await ipc.tasksRevokeApprovals();
    notify({ title: 'Task approvals revoked', source: 'tasks' });
    loadTasks();
  } catch (e) {
    notify({ severity: 'error', title: 'Could not revoke approvals', message: errorMessage(e), source: 'tasks' });
  }
}

export function installTasks() {
  if (installed) return;
  installed = true;
  onTerminalExited(({ id, code }) => {
    const w = waiters.get(id);
    if (w) {
      waiters.delete(id);
      w(code);
    }
  });
  loadHistory();
  let key = '';
  workspaceStore.subscribe(() => {
    const ws = workspaceStore.get().current;
    const next = ws ? `${ws.record.id}|${ws.trust.capabilities.includes('taskExecution')}` : '';
    if (next === key) return;
    key = next;
    taskProblemsStore.set({});
    tasksStore.set((s) => ({ ...s, running: {}, lastTaskId: null }));
    loadTasks();
  });
}


const TEMPLATE = `{
  // Ivily Center tasks. Every task asks for approval before its first run.
  // "type": "shell" (default, runs in the task shell) or "process" (program + args, no shell).
  // Variables: \${workspaceFolder}, \${workspaceFolderBasename}.
  // Problem matchers: rustc, tsc, gcc, eslint-compact, eslint-stylish, msCompile.
  "version": 1,
  "tasks": [
    {
      "label": "build",
      "command": "echo Hello from Ivily Center",
      "group": "build",
      "problemMatcher": []
    }
  ]
}
`;

/** Create `.ivily/tasks.json` (only when it does not exist) and open it. */
export async function configureTasks() {
  const ws = workspaceStore.get().current;
  if (!ws || !ipc.isTauri()) return;
  let root = 0;
  if (ws.folders.length > 1) {
    const item = await quickPick({ placeholder: 'Select the folder for tasks.json', items: ws.folders.map((f, i) => ({ id: String(i), label: f.name, description: f.path })) });
    if (!item) return;
    root = Number(item.id);
  }
  const { openDocument, activeEditor } = await import('../editor/model.js');
  const exists = (e) => errorCode(e) === 'conflict';
  try {
    await ipc.fsCreateDir(root, '.ivily').catch((e) => {
      if (!exists(e)) throw e;
    });
    let created = true;
    await ipc.fsCreateFile(root, '.ivily/tasks.json').catch((e) => {
      if (!exists(e)) throw e;
      created = false;
    });
    await openDocument({ root, path: '.ivily/tasks.json' });
    if (created) {
      // Insert the template as an unsaved edit: the user reviews and saves it.
      requestAnimationFrame(() => {
        const ed = activeEditor();
        if (ed?.view && ed.view.state.doc.length === 0) ed.view.dispatch({ changes: { from: 0, insert: TEMPLATE } });
      });
    }
  } catch (e) {
    notify({ severity: 'error', title: 'Could not create tasks.json', message: errorMessage(e), source: 'tasks' });
  }
}
