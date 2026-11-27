import { useEffect, useRef } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { FileIcon } from '../../icons/FileIcon.jsx';
import { useStore } from '../../core/store.js';
import { openContextMenu } from '../../core/contextMenu.js';
import { workspaceStore } from '../../workspace/store.js';
import { revealInDocument } from '../editor/model.js';
import { cancelSearch, dismiss, replaceAll, runSearch, searchStore, totalMatches } from './model.js';

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function Toggle({ label, title, on, onClick }) {
  return (
    <button type="button" className={`search-toggle${on ? ' search-toggle--on' : ''}`} title={title} aria-label={title} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}

function Preview({ m }) {
  const parts = [];
  let last = 0;
  m.ranges.forEach(([s, e], i) => {
    if (s > last) parts.push(m.preview.slice(last, s));
    parts.push(<mark key={i}>{m.preview.slice(s, e)}</mark>);
    last = e;
  });
  parts.push(m.preview.slice(last));
  return <span className="search-preview">{parts}</span>;
}

let debounce = 0;
const update = (patch, rerun = true) => {
  searchStore.set((s) => ({ ...s, ...patch }));
  if (rerun) {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 300);
  }
};

/** Search sidebar view (Ctrl+Shift+F). */
export function SearchView() {
  const s = useStore(searchStore);
  const ws = useStore(workspaceStore);
  const inputRef = useRef(null);
  const multiRoot = (ws.current?.folders?.length ?? 0) > 1;

  useEffect(() => {
    const focus = () => inputRef.current?.select();
    window.addEventListener('ivily:focus-search', focus);
    focus();
    return () => window.removeEventListener('ivily:focus-search', focus);
  }, []);

  if (!ws.current) return <div className="empty-state subtle search-empty">Open a folder to search its files.</div>;

  const count = totalMatches(s.results);
  const open = (f, m, preview) => {
    const [from, to] = m.ranges[0] ?? [0, 0];
    revealInDocument({ root: f.root, path: f.path }, m.line, m.previewOffset + from, m.previewOffset + to, { preview, focus: !preview });
  };
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounce);
      runSearch();
    } else if (e.key === 'ArrowUp' && e.altKey) {
      const i = s.history.indexOf(s.query);
      if (s.history[i + 1]) update({ query: s.history[i + 1] });
    } else if (e.key === 'ArrowDown' && e.altKey) {
      const i = s.history.indexOf(s.query);
      if (i > 0) update({ query: s.history[i - 1] });
    }
  };

  return (
    <div className="search-view">
      <div className="search-form">
        <div className="search-row">
          <button type="button" className="btn btn--ghost btn--icon" aria-label={s.showReplace ? 'Hide replace' : 'Show replace'} aria-expanded={s.showReplace} onClick={() => update({ showReplace: !s.showReplace }, false)}>
            <Icon name={s.showReplace ? 'chevron-down' : 'chevron-right'} size={14} />
          </button>
          <div className="search-input">
            <input
              ref={inputRef}
              className="input"
              placeholder="Search (Enter; Alt+↑/↓ history)"
              aria-label="Search"
              value={s.query}
              spellCheck={false}
              onChange={(e) => update({ query: e.target.value })}
              onKeyDown={onKey}
              list="search-history"
            />
            <datalist id="search-history">{s.history.map((h) => <option key={h} value={h} />)}</datalist>
            <Toggle label="Aa" title="Match case" on={s.caseSensitive} onClick={() => update({ caseSensitive: !s.caseSensitive })} />
            <Toggle label="ab" title="Match whole word" on={s.wholeWord} onClick={() => update({ wholeWord: !s.wholeWord })} />
            <Toggle label=".*" title="Use regular expression" on={s.isRegex} onClick={() => update({ isRegex: !s.isRegex })} />
          </div>
        </div>
        {s.showReplace && (
          <div className="search-row search-row--indent">
            <input className="input" placeholder="Replace" aria-label="Replace" value={s.replace} spellCheck={false} onChange={(e) => update({ replace: e.target.value }, false)} />
            <button type="button" className="btn btn--ghost btn--icon" title="Replace all (asks first)" aria-label="Replace all" disabled={!count || s.running} onClick={() => replaceAll()}>
              <Icon name="check" size={14} />
            </button>
          </div>
        )}
        <div className="search-row search-row--indent">
          <input className="input" placeholder="Files to include (e.g. src/**, *.js)" aria-label="Files to include" value={s.include} spellCheck={false} onChange={(e) => update({ include: e.target.value })} />
        </div>
        <div className="search-row search-row--indent">
          <input className="input" placeholder="Files to exclude" aria-label="Files to exclude" value={s.exclude} spellCheck={false} onChange={(e) => update({ exclude: e.target.value })} />
          <Toggle label={<Icon name="settings" size={13} />} title="Use .gitignore and files.exclude" on={s.useIgnore} onClick={() => update({ useIgnore: !s.useIgnore })} />
        </div>
      </div>
      <div className="search-status subtle" role="status" aria-live="polite">
        {s.error && <span className="sev-error">{s.error}</span>}
        {!s.error && s.running && (
          <>
            Searching… {count} result{count === 1 ? '' : 's'}{' '}
            <button type="button" className="btn btn--ghost search-stop" onClick={cancelSearch}>Stop</button>
          </>
        )}
        {!s.error && !s.running && s.summary && (
          <>
            {count === 0 ? 'No results.' : `${count} result${count === 1 ? '' : 's'} in ${s.results.length} file${s.results.length === 1 ? '' : 's'}`}
            {s.summary.limitHit && ' — limit reached, refine the search'}
            {s.summary.cancelled && ' — stopped'}
          </>
        )}
      </div>
      <ul className="search-results" role="tree" aria-label="Search results">
        {s.results.map((f) => {
          const id = `${f.root}:${f.path}`;
          const collapsed = s.collapsed[id];
          return (
            <li key={id} role="treeitem" aria-expanded={!collapsed}>
              <div
                className="search-file"
                title={f.path}
                onClick={() => searchStore.set((st) => ({ ...st, collapsed: { ...st.collapsed, [id]: !collapsed } }))}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    { label: 'Open File', run: () => revealInDocument({ root: f.root, path: f.path }, f.matches[0]?.line ?? 1) },
                    ...(s.showReplace ? [{ label: 'Replace in This File…', run: () => replaceAll([f]) }] : []),
                    { label: 'Dismiss', run: () => dismiss(f.root, f.path) },
                    { label: 'Copy Path', run: () => navigator.clipboard?.writeText(f.path) },
                  ])
                }
              >
                <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                <FileIcon name={baseName(f.path)} kind="file" size={14} />
                <span className="search-file__name">{baseName(f.path)}</span>
                <span className="search-file__dir subtle">
                  {multiRoot ? `${ws.current.folders[f.root]?.name ?? ''}${dirName(f.path) ? ' · ' : ''}` : ''}
                  {dirName(f.path)}
                </span>
                <span className="badge">{f.matches.length}</span>
              </div>
              {!collapsed && (
                <ul role="group">
                  {f.matches.map((m) => (
                    <li
                      key={m.line}
                      role="treeitem"
                      tabIndex={0}
                      className="search-match"
                      onClick={() => open(f, m, true)}
                      onDoubleClick={() => open(f, m, false)}
                      onKeyDown={(e) => e.key === 'Enter' && open(f, m, false)}
                      onContextMenu={(e) => openContextMenu(e, [{ label: 'Dismiss', run: () => dismiss(f.root, f.path, m.line) }])}
                    >
                      <span className="search-match__line subtle">{m.line}</span>
                      <Preview m={m} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
