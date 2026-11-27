import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { FileIcon } from '../../icons/FileIcon.jsx';
import { useStore } from '../../core/store.js';
import { setContext } from '../../core/context.js';
import { openContextMenu } from '../../core/contextMenu.js';
import { confirmDialog } from '../../core/dialogs.js';
import { getSetting } from '../../core/settings.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import * as ipc from '../../platform/ipc.js';
import { openFolder, openWorkspaceFile, showPage, workspaceStore } from '../../workspace/store.js';
import {
  baseName, cancelEdit, collapseAll, commitEdit, deleteItems, dropItems, duplicateItem, explorerStore, flattenRows, keyOf, openFile,
  parentKeyOf, parseKey, paste, refreshAll, select, setClipboard, setExpanded, startCreate, startRename, toggleExpanded,
} from './model.js';
import { explorerDecorations } from './decorations.js';
import { PropertiesDialog, showProperties } from './PropertiesDialog.jsx';

const OVERSCAN = 8;

function InlineInput({ initial, depth, kind, name }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the name without its extension when renaming files.
    const dot = kind === 'file' ? initial.lastIndexOf('.') : -1;
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial, kind]);
  const submit = async () => setError(await commitEdit(value));
  return (
    <div className="explorer-row explorer-row--editing" style={{ paddingLeft: `${depth * 0.9 + 0.4}rem` }}>
      <FileIcon name={value || name || 'untitled'} kind={kind === 'root' ? 'dir' : kind} />
      <div className="explorer-row__edit">
        <input
          ref={ref}
          className="input"
          aria-label={initial ? 'New name' : kind === 'dir' ? 'New folder name' : 'New file name'}
          aria-invalid={Boolean(error)}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') cancelEdit();
          }}
          onBlur={() => (value.trim() && value !== initial ? submit() : cancelEdit())}
        />
        {error && <div className="explorer-row__error sev-error" role="alert">{error}</div>}
      </div>
    </div>
  );
}

/** File explorer for the workspace roots. */
export function ExplorerView() {
  const ws = useStore(workspaceStore, (s) => s.current);
  const state = useStore(explorerStore);
  const decorations = useStore(explorerDecorations);
  const roots = useMemo(() => ws?.folders.map((f) => ({ name: f.name, available: f.available })) ?? [], [ws]);
  const rows = useMemo(() => flattenRows(state, roots), [state, roots]);
  const listRef = useRef(null);
  const [rowH, setRowH] = useState(22);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  const [dropTarget, setDropTarget] = useState(null);
  const selection = useMemo(() => new Set(state.selection), [state.selection]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 13;
      setRowH(Math.round(rem * 1.75));
      setViewport({ top: el.scrollTop, height: el.clientHeight });
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [ws]);

  // Keep the focused row visible.
  useEffect(() => {
    const el = listRef.current;
    const i = rows.findIndex((r) => r.key === state.focus);
    if (!el || i < 0) return;
    const top = i * rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
  }, [state.focus, rows, rowH]);

  const selectedKeys = useCallback(() => (state.selection.length ? state.selection : state.focus ? [state.focus] : []), [state.selection, state.focus]);

  const confirmAndDelete = useCallback(async (keys, permanent) => {
    const items = keys.filter((k) => parseKey(k).rel !== '');
    if (!items.length) return;
    const names = items.map((k) => baseName(parseKey(k).rel));
    const what = items.length === 1 ? `“${names[0]}”` : `${items.length} items`;
    if (permanent || getSetting('explorer.confirmDelete') !== false) {
      const ok = await confirmDialog({
        title: permanent ? `Permanently delete ${what}?` : `Move ${what} to the Recycle Bin?`,
        message: permanent ? 'This cannot be undone.' : 'You can restore it from the Recycle Bin.',
        detail: names.slice(0, 8).join('\n') + (names.length > 8 ? `\n… and ${names.length - 8} more` : ''),
        confirmLabel: permanent ? 'Delete permanently' : 'Move to Recycle Bin',
        danger: permanent,
      });
      if (!ok) return;
    }
    await deleteItems(items, { permanent });
  }, []);

  const targetDir = (key) => {
    const row = rows.find((r) => r.key === key);
    if (!row) return keyOf(0, '');
    return row.kind === 'dir' || row.kind === 'root' ? row.key : parentKeyOf(row.key);
  };

  const menuFor = (row, e) => {
    if (!selection.has(row.key)) select(row.key, {}, rows);
    const keys = selection.has(row.key) ? selectedKeys() : [row.key];
    const isFolder = row.kind === 'dir' || row.kind === 'root';
    const dir = targetDir(row.key);
    const { root, rel } = parseKey(row.key);
    const absPath = ws ? `${ws.folders[root].path}${rel ? `\\${rel.replace(/\//g, '\\')}` : ''}` : rel;
    openContextMenu(e, [
      ...(row.kind === 'file' ? [{ label: 'Open', run: () => openFile(row.key) }, { separator: true }] : []),
      { label: 'New File…', run: () => startCreate('newFile', dir) },
      { label: 'New Folder…', run: () => startCreate('newFolder', dir) },
      { separator: true },
      { label: 'Cut', keybinding: 'Ctrl+X', disabled: row.kind === 'root', run: () => setClipboard('cut', keys) },
      { label: 'Copy', keybinding: 'Ctrl+C', disabled: row.kind === 'root', run: () => setClipboard('copy', keys) },
      { label: 'Paste', keybinding: 'Ctrl+V', disabled: !state.clipboard, run: () => paste(dir) },
      { label: 'Duplicate', disabled: row.kind === 'root' || keys.length > 1, run: () => duplicateItem(row.key) },
      { separator: true },
      { label: 'Copy Path', run: () => navigator.clipboard?.writeText(absPath) },
      { label: 'Copy Relative Path', run: () => navigator.clipboard?.writeText(rel || '.') },
      { label: 'Reveal in File Explorer', run: () => ipc.fsReveal(root, rel).catch((err) => notify({ severity: 'error', title: 'Could not open File Explorer', message: errorMessage(err), source: 'explorer' })) },
      { separator: true },
      { label: 'Rename…', keybinding: 'F2', disabled: row.kind === 'root' || keys.length > 1, run: () => startRename(row.key) },
      { label: 'Delete', keybinding: 'Delete', disabled: row.kind === 'root', run: () => confirmAndDelete(keys, false) },
      { label: 'Delete Permanently', keybinding: 'Shift+Delete', danger: true, disabled: row.kind === 'root', run: () => confirmAndDelete(keys, true) },
      { separator: true },
      ...(isFolder ? [{ label: 'Refresh', run: () => refreshAll() }] : []),
      { label: 'Properties', run: () => showProperties(root, rel) },
    ]);
  };

  const activate = (row, preview) => {
    if (row.kind === 'dir' || row.kind === 'root') toggleExpanded(row.key);
    else if (row.kind === 'file') openFile(row.key, { preview });
  };

  const onKeyDown = (e) => {
    if (!rows.length) return;
    const i = Math.max(0, rows.findIndex((r) => r.key === state.focus));
    const row = rows[i];
    const move = (n) => {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, n))];
      if (next) select(next.key, { shift: e.shiftKey }, rows);
    };
    const ctrl = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case 'ArrowDown': return move(i + 1);
      case 'ArrowUp': return move(i - 1);
      case 'Home': return move(0);
      case 'End': return move(rows.length - 1);
      case 'PageDown': return move(i + Math.floor(viewport.height / rowH));
      case 'PageUp': return move(i - Math.floor(viewport.height / rowH));
      case 'ArrowRight':
        e.preventDefault();
        if ((row.kind === 'dir' || row.kind === 'root') && !row.expanded) setExpanded(row.key, true);
        else if (row.expanded && rows[i + 1]?.depth > row.depth) select(rows[i + 1].key, {}, rows);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        if (row.expanded) setExpanded(row.key, false);
        else if (row.kind !== 'root') select(parentKeyOf(row.key), {}, rows);
        return;
      case 'Enter':
        e.preventDefault();
        return activate(row, false);
      case ' ':
        e.preventDefault();
        return row.kind === 'file' ? openFile(row.key, { preview: true }) : toggleExpanded(row.key);
      case 'F2':
        e.preventDefault();
        if (row.kind !== 'root') startRename(row.key);
        return;
      case 'Delete':
        e.preventDefault();
        return confirmAndDelete(selectedKeys(), e.shiftKey);
      default:
    }
    if (ctrl && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      setClipboard('copy', selectedKeys().filter((k) => parseKey(k).rel));
    } else if (ctrl && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      setClipboard('cut', selectedKeys().filter((k) => parseKey(k).rel));
    } else if (ctrl && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      paste(targetDir(state.focus ?? keyOf(0, '')));
    } else if (ctrl && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      explorerStore.set((s) => ({ ...s, selection: rows.filter((r) => r.kind !== 'root' && !r.editing).map((r) => r.key) }));
    }
  };

  if (!ws) {
    return (
      <div className="empty-state">
        <Icon name="files" size={28} />
        <div>No folder open</div>
        <div className="explorer__actions">
          <button type="button" className="btn btn--primary" onClick={openFolder}>Open Folder…</button>
          <button type="button" className="btn" onClick={openWorkspaceFile}>Open Workspace File…</button>
          <button type="button" className="btn btn--ghost" onClick={() => showPage('launcher')}>Recent workspaces</button>
        </div>
      </div>
    );
  }

  const first = Math.max(0, Math.floor(viewport.top / rowH) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / rowH) + OVERSCAN);
  const focusDir = targetDir(state.focus ?? keyOf(0, ''));

  return (
    <div className="explorer-view">
      <div className="explorer-toolbar" role="toolbar" aria-label="Explorer actions">
        <button type="button" className="btn btn--ghost btn--icon" title="New File…" aria-label="New file" onClick={() => startCreate('newFile', focusDir)}>
          <Icon name="file-plus" size={15} />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" title="New Folder…" aria-label="New folder" onClick={() => startCreate('newFolder', focusDir)}>
          <Icon name="folder-plus" size={15} />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" title="Refresh" aria-label="Refresh" onClick={refreshAll}>
          <Icon name="refresh" size={15} />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" title="Collapse All" aria-label="Collapse all" onClick={collapseAll}>
          <Icon name="collapse" size={15} />
        </button>
      </div>
      <div
        className="explorer-list"
        ref={listRef}
        role="tree"
        aria-label="Files"
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => setContext('explorerFocus', true)}
        onBlur={() => setContext('explorerFocus', false)}
        onScroll={(e) => setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) menuFor(rows[0], e);
        }}
      >
        <div style={{ height: rows.length * rowH, position: 'relative' }}>
          {rows.slice(first, last).map((row, j) => {
            const i = first + j;
            const style = { position: 'absolute', top: i * rowH, left: 0, right: 0, height: rowH };
            if (row.editing) {
              const initial = row.name;
              return (
                <div key={row.key} style={style}>
                  <InlineInput initial={initial} depth={row.depth} kind={row.kind} name={row.name} />
                </div>
              );
            }
            const deco = decorations[row.key];
            const dir = state.dirs[row.key];
            const isFolder = row.kind === 'dir' || row.kind === 'root';
            const cut = state.clipboard?.mode === 'cut' && state.clipboard.keys.includes(row.key);
            return (
              <div
                key={row.key}
                style={{ ...style, paddingLeft: `${row.depth * 0.9 + 0.4}rem` }}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={isFolder ? row.expanded : undefined}
                aria-selected={selection.has(row.key)}
                className={[
                  'explorer-row',
                  row.kind === 'root' && 'explorer-row--root',
                  selection.has(row.key) && 'explorer-row--selected',
                  state.focus === row.key && 'explorer-row--focused',
                  row.ignored && getSetting('explorer.gitIgnored') !== 'show' && 'explorer-row--ignored',
                  row.entry?.hidden && 'explorer-row--hidden',
                  cut && 'explorer-row--cut',
                  dropTarget === row.key && 'explorer-row--drop',
                ].filter(Boolean).join(' ')}
                title={row.kind === 'root' ? ws.folders[row.root].path : row.rel}
                draggable={row.kind !== 'root'}
                onClick={(e) => {
                  select(row.key, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }, rows);
                  if (!e.ctrlKey && !e.shiftKey && !e.metaKey) activate(row, true);
                }}
                onDoubleClick={() => row.kind === 'file' && openFile(row.key, { preview: false })}
                onContextMenu={(e) => menuFor(row, e)}
                onDragStart={(e) => {
                  const keys = selection.has(row.key) ? selectedKeys() : [row.key];
                  e.dataTransfer.setData('application/x-ivily-explorer', JSON.stringify(keys));
                  e.dataTransfer.effectAllowed = 'copyMove';
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes('application/x-ivily-explorer')) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
                  setDropTarget(targetDir(row.key));
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDropTarget(null);
                  let keys;
                  try {
                    keys = JSON.parse(e.dataTransfer.getData('application/x-ivily-explorer'));
                  } catch {
                    return;
                  }
                  if (!Array.isArray(keys) || !keys.length) return;
                  const dest = targetDir(row.key);
                  const copy = e.ctrlKey;
                  const ok = await confirmDialog({
                    title: `${copy ? 'Copy' : 'Move'} ${keys.length === 1 ? `“${baseName(parseKey(keys[0]).rel)}”` : `${keys.length} items`} into “${baseName(parseKey(dest).rel) || ws.folders[parseKey(dest).root].name}”?`,
                    confirmLabel: copy ? 'Copy' : 'Move',
                  });
                  if (ok) dropItems(keys, dest, copy);
                }}
              >
                <span className="explorer-row__twisty" aria-hidden="true">
                  {isFolder ? <Icon name={row.expanded ? 'chevron-down' : 'chevron-right'} size={12} /> : null}
                </span>
                {row.kind === 'root' ? <Icon name="folder" size={15} /> : <FileIcon name={row.name} kind={row.kind} open={row.expanded} />}
                <span className="explorer-row__name" style={deco?.color ? { color: deco.color } : undefined}>
                  {row.name}
                </span>
                {dir?.loading && <span className="explorer-row__spinner subtle" aria-label="Loading">…</span>}
                {dir?.error && <span className="sev-error explorer-row__badge" title={dir.error}>!</span>}
                {dir?.truncated && <span className="subtle explorer-row__badge" title="Too many entries; not all are shown">…</span>}
                {row.kind === 'root' && !ws.folders[row.root].available && <span className="launcher__chip launcher__chip--warn">unavailable</span>}
                {deco?.badge && <span className="explorer-row__badge" style={{ color: deco.color }} title={deco.tooltip}>{deco.badge}</span>}
              </div>
            );
          })}
        </div>
      </div>
      <PropertiesDialog />
    </div>
  );
}
