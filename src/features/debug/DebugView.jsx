import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { workspaceStore } from '../../workspace/store.js';
import { revealInDocument } from '../editor/model.js';
import {
  configureLaunch, continueExecution, debugStore, evaluate, loadDebugInfo, loadVariables, pauseExecution, restartDebugging, selectFrame, startDebugging, stepInto,
  stepOut, stepOver, stopDebugging, toggleBreakpointAt,
} from './model.js';

const baseName = (p) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

function Variable({ v, depth }) {
  const children = useStore(debugStore, (s) => s.variables[v.variablesReference]);
  const [open, setOpen] = useState(false);
  const expandable = v.variablesReference > 0;
  const toggle = () => {
    if (!expandable) return;
    if (!open && !children) loadVariables(v.variablesReference);
    setOpen(!open);
  };
  return (
    <li role="treeitem" aria-expanded={expandable ? open : undefined}>
      <div className="debug-var" style={{ paddingLeft: `${0.6 + depth * 0.8}rem` }} onClick={toggle} title={v.type ? `${v.name}: ${v.type}` : v.name}>
        {expandable ? <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} /> : <span className="debug-var__pad" />}
        <span className="debug-var__name">{v.name}</span>
        <span className="debug-var__value selectable">{v.value}</span>
      </div>
      {open && children && (
        <ul role="group">
          {children.slice(0, 500).map((c, i) => (
            <Variable key={`${c.name}-${i}`} v={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="debug-section">
      <button type="button" className="debug-section__head section-title" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} /> {title}
      </button>
      {open && children}
    </section>
  );
}

/** Run and Debug side-bar view. */
export function DebugView() {
  const ws = useStore(workspaceStore, (s) => s.current);
  const { info, session, breakpoints } = useStore(debugStore);
  const vars = useStore(debugStore, (s) => s.variables);
  const [configId, setConfigId] = useState('');

  useEffect(() => {
    if (ws && !info) loadDebugInfo();
  }, [ws, info]);

  if (!ws) return <div className="empty-state subtle search-empty">Open a folder to debug it.</div>;
  const active = session && session.state !== 'terminated';
  const stopped = session?.state === 'stopped';
  const configs = info?.configs ?? [];
  const selected = configId || configs[0]?.id || '';

  return (
    <div className="debug-view">
      {!active ? (
        <div className="debug-start">
          {configs.length > 0 ? (
            <>
              <select className="select" aria-label="Launch configuration" value={selected} onChange={(e) => setConfigId(e.target.value)}>
                {configs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.adapter ? '' : ' (no adapter)'}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn--primary" onClick={() => startDebugging(selected)}>
                <Icon name="debug" size={14} /> Start (F5)
              </button>
            </>
          ) : (
            <div className="subtle">
              No launch configurations. <button type="button" className="btn btn--ghost" onClick={configureLaunch}>Add .ivily/launch.json…</button>
            </div>
          )}
          {info && !info.canRun && <div className="sev-warning debug-note">Debugging is disabled until the workspace is trusted for “Debugging”.</div>}
          {info?.issues?.map((i) => <div key={i} className="sev-warning debug-note">{i}</div>)}
          <div className="subtle debug-note">
            Adapters: {info?.adapters?.length ? info.adapters.map((a) => a.name).join(', ') : 'none found (debugpy, lldb-dap, netcoredbg or a configured adapter)'}{' '}
            <button type="button" className="btn btn--ghost" onClick={() => loadDebugInfo(true)} title="Detect adapters again">
              <Icon name="refresh" size={12} />
            </button>
          </div>
        </div>
      ) : (
        <div className="debug-toolbar" role="toolbar" aria-label="Debug actions">
          <span className="debug-toolbar__name" title={session.adapter}>{session.name}</span>
          <span className={`badge debug-state debug-state--${session.state}`}>{session.state}</span>
          {stopped ? (
            <button type="button" className="btn btn--ghost btn--icon" title="Continue (F5)" aria-label="Continue" onClick={continueExecution}>▶</button>
          ) : (
            <button type="button" className="btn btn--ghost btn--icon" title="Pause (F6)" aria-label="Pause" onClick={pauseExecution}>❚❚</button>
          )}
          <button type="button" className="btn btn--ghost btn--icon" title="Step Over (F10)" aria-label="Step over" disabled={!stopped} onClick={stepOver}>↷</button>
          <button type="button" className="btn btn--ghost btn--icon" title="Step Into (F11)" aria-label="Step into" disabled={!stopped} onClick={stepInto}>↓</button>
          <button type="button" className="btn btn--ghost btn--icon" title="Step Out (Shift+F11)" aria-label="Step out" disabled={!stopped} onClick={stepOut}>↑</button>
          <button type="button" className="btn btn--ghost btn--icon" title="Restart (Ctrl+Shift+F5)" aria-label="Restart" onClick={restartDebugging}><Icon name="refresh" size={13} /></button>
          <button type="button" className="btn btn--ghost btn--icon" title="Stop (Shift+F5)" aria-label="Stop" onClick={stopDebugging}>■</button>
        </div>
      )}
      <div className="debug-body">
        {active && (
          <>
            <Section title="Variables">
              <ul className="debug-list" role="tree" aria-label="Variables">
                {(session.scopes ?? []).map((sc) => (
                  <Variable key={sc.variablesReference} v={{ name: sc.name, value: '', variablesReference: sc.variablesReference }} depth={0} />
                ))}
                {!stopped && <li className="subtle debug-note">Variables are shown while paused.</li>}
                {stopped && session.scopes?.length === 0 && vars && <li className="subtle debug-note">No variables.</li>}
              </ul>
            </Section>
            <Section title="Call Stack">
              <ul className="debug-list" aria-label="Call stack">
                {session.frames.map((f) => (
                  <li key={f.id}>
                    <button type="button" className={`debug-frame${f.id === session.frameId ? ' debug-frame--active' : ''}`} onClick={() => selectFrame(f)}>
                      <span>{f.name}</span>
                      <span className="subtle">{f.source?.path ? `${baseName(f.source.path)}:${f.line}` : f.source?.name ?? ''}</span>
                    </button>
                  </li>
                ))}
                {!session.frames.length && <li className="subtle debug-note">{stopped ? 'No frames.' : 'Running…'}</li>}
              </ul>
            </Section>
          </>
        )}
        <Section title="Breakpoints">
          <ul className="debug-list" aria-label="Breakpoints">
            {Object.entries(breakpoints).flatMap(([key, list]) =>
              list.map((b) => {
                const path = key.slice(key.indexOf(':') + 1);
                return (
                  <li key={`${key}:${b.line}`} className="debug-bp">
                    <span className={`cm-breakpoint${b.verified === false ? ' cm-breakpoint--unverified' : ''}`} title={b.message} />
                    <button type="button" className="debug-frame" onClick={() => revealInDocument({ root: Number(key.slice(0, key.indexOf(':'))), path }, b.line)}>
                      <span>{baseName(path)}</span>
                      <span className="subtle">{b.line}</span>
                    </button>
                    <button type="button" className="btn btn--ghost btn--icon" aria-label="Remove breakpoint" onClick={() => toggleBreakpointAt(key, b.line)}>
                      <Icon name="close" size={11} />
                    </button>
                  </li>
                );
              }),
            )}
            {!Object.keys(breakpoints).length && <li className="subtle debug-note">Click the gutter or press F9 to add a breakpoint.</li>}
          </ul>
        </Section>
      </div>
    </div>
  );
}

/** Debug Console panel: adapter output and an expression evaluator. */
export function DebugConsoleView() {
  const lines = useStore(debugStore, (s) => s.console);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState(/** @type {string[]} */ ([]));
  const [pos, setPos] = useState(-1);
  const scroller = useRef(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines]);
  return (
    <div className="output">
      <div className="output__lines selectable debug-console" ref={scroller} role="log" aria-label="Debug console">
        {lines.length === 0 ? <div className="subtle output__empty">Debug output appears here.</div> : lines.map((l, i) => <div key={i} className={`debug-line debug-line--${l.category}`}>{l.text}</div>)}
      </div>
      <input
        className="input debug-input"
        placeholder="Evaluate an expression in the paused frame (Enter)"
        aria-label="Debug console input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && input.trim()) {
            evaluate(input);
            setHistory((h) => [input, ...h.filter((x) => x !== input)].slice(0, 50));
            setInput('');
            setPos(-1);
          } else if (e.key === 'ArrowUp' && history.length) {
            const p = Math.min(history.length - 1, pos + 1);
            setPos(p);
            setInput(history[p]);
          } else if (e.key === 'ArrowDown') {
            const p = pos - 1;
            setPos(Math.max(-1, p));
            setInput(p >= 0 ? history[p] : '');
          }
        }}
      />
    </div>
  );
}
