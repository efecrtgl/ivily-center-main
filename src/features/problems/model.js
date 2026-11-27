// Problems: language-server diagnostics and task problem-matcher results in one list.
import { createStore } from '../../core/store.js';
import { diagnosticsStore } from '../lsp/manager.js';
import { taskProblemsStore } from '../tasks/model.js';
import { uriToRef } from '../lsp/uri.js';
import { workspaceStore } from '../../workspace/store.js';

/**
 * @typedef {{ key: string, ref: { root: number, path: string } | null, file: string, line: number, col: number, severity: 'error' | 'warning' | 'info', message: string, code?: string, source: string }} Problem
 */

const LSP_SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'info' };
const ORDER = { error: 0, warning: 1, info: 2 };

export const problemsUi = createStore({ filter: '', error: true, warning: true, info: true, collapsed: /** @type {Record<string, boolean>} */ ({}) });

/**
 * Build the problem list from both sources.
 * @returns {Problem[]}
 */
export function collectProblems(diagnostics = diagnosticsStore.get(), tasks = taskProblemsStore.get(), folders = workspaceStore.get().current?.folders ?? []) {
  /** @type {Problem[]} */
  const out = [];
  for (const [uri, entry] of Object.entries(diagnostics)) {
    const ref = uriToRef(uri, folders);
    const file = ref ? ref.path : decodeURIComponent(uri.replace(/^file:\/\/\/?/, ''));
    entry.diagnostics.forEach((d, i) =>
      out.push({
        key: `lsp|${uri}|${i}`,
        ref,
        file,
        line: (d.range?.start?.line ?? 0) + 1,
        col: (d.range?.start?.character ?? 0) + 1,
        severity: LSP_SEVERITY[d.severity] ?? 'error',
        message: String(d.message ?? ''),
        code: d.code != null ? String(typeof d.code === 'object' ? d.code.value : d.code) : undefined,
        source: d.source ?? entry.server,
      }),
    );
  }
  for (const [taskId, list] of Object.entries(tasks)) {
    list.forEach((p, i) => out.push({ key: `task|${taskId}|${i}`, ref: p.ref, file: p.ref ? p.ref.path : p.file, line: p.line, col: p.col, severity: /** @type {any} */ (p.severity), message: p.message, code: p.code, source: p.source }));
  }
  return out;
}

/** Group by file (files with errors first), problems sorted by severity then position. */
export function groupProblems(list, ui = problemsUi.get()) {
  const q = ui.filter.trim().toLowerCase();
  const visible = list.filter((p) => ui[p.severity] && (!q || p.message.toLowerCase().includes(q) || p.file.toLowerCase().includes(q) || (p.code ?? '').toLowerCase().includes(q)));
  /** @type {Map<string, { id: string, ref: Problem['ref'], file: string, problems: Problem[] }>} */
  const groups = new Map();
  for (const p of visible) {
    const id = p.ref ? `${p.ref.root}:${p.ref.path}` : `ext:${p.file}`;
    if (!groups.has(id)) groups.set(id, { id, ref: p.ref, file: p.file, problems: [] });
    groups.get(id).problems.push(p);
  }
  const sorted = [...groups.values()];
  for (const g of sorted) g.problems.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.line - b.line || a.col - b.col);
  sorted.sort((a, b) => ORDER[a.problems[0].severity] - ORDER[b.problems[0].severity] || a.file.localeCompare(b.file));
  return sorted;
}

export function countProblems(list) {
  const c = { error: 0, warning: 0, info: 0 };
  for (const p of list) c[p.severity]++;
  return c;
}

/** Remove problems reported by tasks (LSP diagnostics are owned by the servers). */
export function clearTaskProblems() {
  taskProblemsStore.set({});
}
