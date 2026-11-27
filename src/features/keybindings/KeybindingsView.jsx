import { useMemo, useState } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { commandsVersion, listCommands } from '../../core/commands.js';
import { chordFromEvent, effectiveKeybindings, findConflicts, keybindingStore } from '../../core/keybindings.js';
import { confirmDialog } from '../../core/dialogs.js';
import { showPage } from '../../workspace/store.js';
import { assignKeybinding, isModified, removeKeybinding, resetKeybindings } from './model.js';

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/** Captures one chord; Escape cancels, Enter on its own confirms nothing. */
function Recorder({ onDone, label }) {
  const [chord, setChord] = useState('');
  return (
    <input
      className="input kb-record"
      autoFocus
      readOnly
      aria-label={label}
      placeholder="Press the shortcut, then Enter (Esc cancels)"
      value={chord}
      onBlur={() => onDone(null)}
      onKeyDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) return onDone(null);
        if (e.key === 'Enter' && chord && !e.ctrlKey && !e.altKey && !e.shiftKey) return onDone(chord);
        if (MODIFIER_CODES.test(e.code)) return;
        const c = chordFromEvent(e.nativeEvent ?? e);
        if (c) setChord(c);
      }}
    />
  );
}

/** Keyboard Shortcuts editor (page). */
export function KeybindingsView() {
  useStore(commandsVersion);
  const kb = useStore(keybindingStore);
  const [filter, setFilter] = useState('');
  const [recordFilter, setRecordFilter] = useState(false);
  const [editing, setEditing] = useState(/** @type {null | { command: string, previous: any }} */ (null));
  const [onlyModified, setOnlyModified] = useState(false);

  const effective = useMemo(() => effectiveKeybindings(kb), [kb]);
  const conflicts = useMemo(() => findConflicts(effective), [effective]);
  const conflictKeys = useMemo(() => new Set(conflicts.map((c) => `${c.key}\u0000${c.when}`)), [conflicts]);

  const rows = useMemo(() => {
    const cmds = listCommands();
    const out = [];
    for (const c of cmds) {
      const bindings = effective.filter((b) => b.command === c.id);
      if (bindings.length) for (const b of bindings) out.push({ c, b });
      else out.push({ c, b: null });
    }
    const f = filter.trim().toLowerCase();
    return out.filter(({ c, b }) => {
      if (onlyModified && !isModified(c.id, kb.user)) return false;
      if (!f) return true;
      if (recordFilter) return b?.key.toLowerCase() === f;
      return `${c.category}: ${c.title}`.toLowerCase().includes(f) || c.id.toLowerCase().includes(f) || (b?.key.toLowerCase().includes(f) ?? false);
    });
  }, [effective, filter, recordFilter, onlyModified, kb.user]);

  const finish = async (chord) => {
    const e = editing;
    setEditing(null);
    if (!chord || !e) return;
    const taken = effective.filter((b) => b.key === chord && b.command !== e.command);
    if (taken.length) {
      const ok = await confirmDialog({
        title: `${chord} is already used`,
        message: `It is bound to ${taken.map((t) => t.command).join(', ')}. Bindings added later take precedence when both apply. Assign it anyway?`,
        confirmLabel: 'Assign',
      });
      if (!ok) return;
    }
    await assignKeybinding(e.command, chord, e.previous);
  };

  return (
    <div className="kb-page">
      <div className="kb-page__inner">
        <div className="tools-bar">
          <h1><Icon name="keyboard" size={22} /> Keyboard Shortcuts</h1>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn--ghost" onClick={() => showPage('editor')}>Back to editors</button>
        </div>
        <p className="subtle">
          Shortcuts follow key positions, so they stay the same on every keyboard layout. Changes are saved for your user. {conflicts.length > 0 && <span className="kb-conflict">{conflicts.length} conflicting shortcut(s) — only the last binding of each can run.</span>}
        </p>
        <div className="kb-bar">
          {recordFilter ? (
            <Recorder label="Search by shortcut" onDone={(c) => { if (c) setFilter(c); else setRecordFilter(Boolean(filter)); }} />
          ) : (
            <input className="input" placeholder="Search commands or shortcuts" aria-label="Search keyboard shortcuts" value={filter} onChange={(e) => setFilter(e.target.value)} />
          )}
          <button type="button" className={`btn${recordFilter ? ' btn--primary' : ''}`} onClick={() => { setRecordFilter(!recordFilter); setFilter(''); }} aria-pressed={recordFilter}>
            Record keys
          </button>
          <label className="kb-check">
            <input type="checkbox" className="checkbox" checked={onlyModified} onChange={(e) => setOnlyModified(e.target.checked)} /> Changed only
          </label>
        </div>
        <table className="trust-table kb-table">
          <thead>
            <tr><th>Command</th><th>Shortcut</th><th>When</th><th>Source</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {rows.map(({ c, b }) => {
              const isEditing = editing && editing.command === c.id && editing.previous === b;
              const conflict = b && conflictKeys.has(`${b.key}\u0000${(b.when || '').replace(/\s+/g, '')}`);
              return (
                <tr key={`${c.id}|${b?.key ?? ''}|${b?.when ?? ''}|${b?.source ?? ''}`}>
                  <td title={c.id}>{c.category}: {c.title}</td>
                  <td>
                    {isEditing ? <Recorder label={`New shortcut for ${c.title}`} onDone={finish} /> : b ? <kbd className={`kbd${conflict ? ' kb-conflict' : ''}`} title={conflict ? 'Conflicts with another binding' : undefined}>{b.key}</kbd> : <span className="subtle">—</span>}
                  </td>
                  <td className="kb-when subtle">{b?.when ?? ''}</td>
                  <td className="subtle">{b ? (b.source === 'user' ? 'User' : 'Default') : ''}</td>
                  <td className="tools-actions">
                    <button type="button" className="btn btn--ghost" onClick={() => setEditing({ command: c.id, previous: b })}>{b ? 'Change' : 'Add'}</button>
                    {b && <button type="button" className="btn btn--ghost" onClick={() => removeKeybinding(b)}>Remove</button>}
                    {isModified(c.id, kb.user) && <button type="button" className="btn btn--ghost" onClick={() => resetKeybindings(c.id)}>Reset</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty-state subtle">No matching commands.</div>}
      </div>
    </div>
  );
}
