import { useMemo } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { FileIcon } from '../../icons/FileIcon.jsx';
import { useStore } from '../../core/store.js';
import { openContextMenu } from '../../core/contextMenu.js';
import { diagnosticsStore } from '../lsp/manager.js';
import { taskProblemsStore } from '../tasks/model.js';
import { workspaceStore } from '../../workspace/store.js';
import { revealInDocument } from '../editor/model.js';
import { clearTaskProblems, collectProblems, countProblems, groupProblems, problemsUi } from './model.js';

const baseName = (p) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
const ICON = { error: 'error', warning: 'warning', info: 'info' };

/** Hook: all problems, recomputed when a source changes. */
export function useProblems() {
  const diags = useStore(diagnosticsStore);
  const tasks = useStore(taskProblemsStore);
  const folders = useStore(workspaceStore, (s) => s.current?.folders);
  return useMemo(() => collectProblems(diags, tasks, folders ?? []), [diags, tasks, folders]);
}

export function openProblem(p) {
  if (p.ref) revealInDocument(p.ref, p.line, p.col - 1);
}

let cursor = -1;
/** Go to the next (+1) or previous (-1) problem in panel order. */
export function goToProblem(delta) {
  const flat = groupProblems(collectProblems()).flatMap((g) => g.problems).filter((p) => p.ref);
  if (!flat.length) return false;
  cursor = (((cursor + delta) % flat.length) + flat.length) % flat.length;
  openProblem(flat[cursor]);
  return true;
}

/** Problems panel (Ctrl+Shift+M). */
export function ProblemsView() {
  const all = useProblems();
  const ui = useStore(problemsUi);
  const groups = useMemo(() => groupProblems(all, ui), [all, ui]);
  const counts = countProblems(all);
  const toggle = (k) => problemsUi.set((s) => ({ ...s, [k]: !s[k] }));

  return (
    <div className="problems">
      <div className="output__toolbar">
        <input className="input output__filter" type="search" placeholder="Filter (text, file, code)" aria-label="Filter problems" value={ui.filter} onChange={(e) => problemsUi.set((s) => ({ ...s, filter: e.target.value }))} />
        {['error', 'warning', 'info'].map((k) => (
          <button key={k} type="button" className={`search-toggle${ui[k] ? ' search-toggle--on' : ''}`} aria-pressed={ui[k]} title={`Show ${k === 'info' ? 'infos' : `${k}s`}`} onClick={() => toggle(k)}>
            <Icon name={ICON[k]} size={13} /> {counts[k]}
          </button>
        ))}
        <span className="output__spacer" />
        <button type="button" className="btn btn--ghost btn--icon" title="Collapse all" aria-label="Collapse all" onClick={() => problemsUi.set((s) => ({ ...s, collapsed: Object.fromEntries(groups.map((g) => [g.id, true])) }))}>
          <Icon name="collapse" size={14} />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" title="Clear task problems" aria-label="Clear task problems" onClick={clearTaskProblems}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      {groups.length === 0 ? (
        <div className="subtle output__empty">{all.length ? 'No problems match the filter.' : 'No problems have been detected in the workspace.'}</div>
      ) : (
        <ul className="search-results problems__list" role="tree" aria-label="Problems">
          {groups.map((g) => {
            const collapsed = ui.collapsed[g.id];
            return (
              <li key={g.id} role="treeitem" aria-expanded={!collapsed}>
                <div className="search-file" title={g.file} onClick={() => problemsUi.set((s) => ({ ...s, collapsed: { ...s.collapsed, [g.id]: !collapsed } }))}>
                  <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                  <FileIcon name={baseName(g.file)} kind="file" size={14} />
                  <span className="search-file__name">{baseName(g.file)}</span>
                  <span className="search-file__dir subtle">{g.file.includes('/') ? g.file.slice(0, g.file.lastIndexOf('/')) : ''}</span>
                  <span className="badge">{g.problems.length}</span>
                </div>
                {!collapsed && (
                  <ul role="group">
                    {g.problems.map((p) => (
                      <li
                        key={p.key}
                        role="treeitem"
                        tabIndex={0}
                        className="problem"
                        title={p.message}
                        onClick={() => openProblem(p)}
                        onKeyDown={(e) => e.key === 'Enter' && openProblem(p)}
                        onContextMenu={(e) =>
                          openContextMenu(e, [
                            { label: 'Copy Message', run: () => navigator.clipboard?.writeText(p.message) },
                            { label: 'Copy', run: () => navigator.clipboard?.writeText(`${p.file}:${p.line}:${p.col}: ${p.severity}${p.code ? ` ${p.code}` : ''}: ${p.message}`) },
                          ])
                        }
                      >
                        <Icon name={ICON[p.severity]} size={13} className={`sev-${p.severity}`} />
                        <span className="problem__msg">{p.message}</span>
                        <span className="subtle problem__meta">
                          {p.source}
                          {p.code ? `(${p.code})` : ''} [{p.line}, {p.col}]
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
