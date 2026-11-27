import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { openContextMenu } from '../../core/contextMenu.js';
import {
  clearTerminal, createTerminal, focusTerminal, getInstance, killTerminal, loadProfiles, newTerminalWithProfile, renameTerminal, splitTerminal,
  terminalStore,
} from './model.js';

function Pane({ id, active }) {
  const ref = useRef(null);
  const info = useStore(terminalStore, (s) => s.terminals.find((t) => t.id === id));
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');

  useLayoutEffect(() => {
    const inst = getInstance(id);
    if (!inst || !ref.current) return;
    ref.current.appendChild(inst.host);
    const fit = () => {
      try {
        inst.fit.fit();
      } catch {
        /* hidden */
      }
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(ref.current);
    return () => ro?.disconnect();
  }, [id]);

  useEffect(() => {
    if (active) getInstance(id)?.term.focus();
  }, [active, id]);

  const find = (forward) => {
    const s = getInstance(id)?.search;
    if (!s || !query) return;
    if (forward) s.findNext(query);
    else s.findPrevious(query);
  };

  return (
    <div
      className={`terminal-pane${active ? ' terminal-pane--active' : ''}`}
      onMouseDown={() => focusTerminal(id)}
      onKeyDownCapture={(e) => {
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          setSearching(true);
        }
      }}
    >
      {searching && (
        <div className="terminal-search">
          <input
            className="input"
            autoFocus
            placeholder="Find in terminal"
            aria-label="Find in terminal"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              getInstance(id)?.search.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') find(!e.shiftKey);
              if (e.key === 'Escape') {
                setSearching(false);
                getInstance(id)?.term.focus();
              }
            }}
          />
          <button type="button" className="btn btn--ghost btn--icon" aria-label="Previous match" onClick={() => find(false)}>↑</button>
          <button type="button" className="btn btn--ghost btn--icon" aria-label="Next match" onClick={() => find(true)}>↓</button>
          <button type="button" className="btn btn--ghost btn--icon" aria-label="Close search" onClick={() => setSearching(false)}><Icon name="close" size={12} /></button>
        </div>
      )}
      {info?.status === 'exited' && <div className="terminal-exited subtle">Process exited{info.exitCode != null ? ` (${info.exitCode})` : ''}</div>}
      <div className="terminal-mount" ref={ref} />
    </div>
  );
}

/** Terminal panel view: tabs (one or two split panes each) and toolbar. */
export function TerminalView() {
  const { terminals, groups, activeGroup } = useStore(terminalStore);
  const [renaming, setRenaming] = useState(null);

  useEffect(() => {
    loadProfiles();
  }, []);

  const group = groups.find((g) => g.id === activeGroup);
  const tabMenu = (e, t) =>
    openContextMenu(e, [
      { label: 'Rename…', run: () => setRenaming(t.id) },
      { label: 'Clear', run: () => clearTerminal(t.id) },
      { label: 'Split', run: () => { focusTerminal(t.id); splitTerminal(); } },
      { separator: true },
      { label: 'Kill Terminal', danger: true, run: () => killTerminal(t.id) },
    ]);

  return (
    <div className="terminal-view">
      <div className="terminal-main">
        {!group && (
          <div className="empty-state">
            <div className="subtle">No terminal is open. Terminals start only when you ask for one.</div>
            <div className="explorer__actions">
              <button type="button" className="btn btn--primary" onClick={() => createTerminal()}>New Terminal</button>
              <button type="button" className="btn btn--ghost" onClick={newTerminalWithProfile}>Choose profile…</button>
            </div>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.id} className="terminal-group" hidden={g.id !== activeGroup}>
            {g.panes.map((p) => (
              <Pane key={p} id={p} active={g.id === activeGroup && g.active === p} />
            ))}
          </div>
        ))}
      </div>
      <div className="terminal-side">
        <div className="terminal-toolbar">
          <button type="button" className="btn btn--ghost btn--icon" title="New Terminal (Ctrl+Shift+`)" aria-label="New terminal" onClick={() => createTerminal()}><Icon name="file-plus" size={14} /></button>
          <button type="button" className="btn btn--ghost btn--icon" title="New Terminal with Profile…" aria-label="New terminal with profile" onClick={newTerminalWithProfile}><Icon name="chevron-down" size={14} /></button>
          <button type="button" className="btn btn--ghost btn--icon" title="Split Terminal" aria-label="Split terminal" onClick={splitTerminal}><Icon name="split" size={14} /></button>
          <button type="button" className="btn btn--ghost btn--icon" title="Kill Terminal" aria-label="Kill terminal" disabled={!group} onClick={() => group && killTerminal(group.active)}><Icon name="trash" size={14} /></button>
        </div>
        <ul className="terminal-tabs" role="tablist" aria-label="Terminals">
          {groups.flatMap((g) =>
            g.panes.map((p, i) => {
              const t = terminals.find((x) => x.id === p);
              if (!t) return null;
              return (
                <li key={p} role="tab" aria-selected={g.id === activeGroup && g.active === p} className={`terminal-tab${g.id === activeGroup && g.active === p ? ' terminal-tab--active' : ''}`} onClick={() => focusTerminal(p)} onContextMenu={(e) => tabMenu(e, t)} onDoubleClick={() => setRenaming(p)}>
                  <span className="subtle">{i > 0 ? '└' : ''}</span>
                  {renaming === p ? (
                    <input className="input" autoFocus defaultValue={t.title} aria-label="Terminal name" onBlur={(e) => { renameTerminal(p, e.target.value); setRenaming(null); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(null); }} />
                  ) : (
                    <span className="terminal-tab__name">{t.title}</span>
                  )}
                  {t.status === 'exited' && <span className="subtle">✕</span>}
                </li>
              );
            }),
          )}
        </ul>
      </div>
    </div>
  );
}
