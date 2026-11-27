import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { Icon } from '../../icons/Icon.jsx';
import { FileIcon } from '../../icons/FileIcon.jsx';
import { useStore } from '../../core/store.js';
import { openContextMenu } from '../../core/contextMenu.js';
import { executeCommand } from '../../core/commands.js';
import {
  activateTab, attachView, closeTab, closeTabs, detachView, docsStore, editorStore, focusGroup, getDoc, moveTab, pinTab,
  reloadFromDisk, revertDocument, saveDocument, showInView, splitEditor,
} from './model.js';

/** The CodeMirror view of one group. Its state is swapped when the active tab changes. */
function CodeView({ groupId, activeKey }) {
  const host = useRef(null);
  const prev = useRef(null);
  useLayoutEffect(() => {
    const view = new EditorView({ parent: host.current });
    attachView(groupId, view);
    return () => {
      detachView(groupId);
      view.destroy();
      prev.current = null;
    };
  }, [groupId]);
  useLayoutEffect(() => {
    showInView(groupId, prev.current, activeKey);
    prev.current = activeKey;
  }, [groupId, activeKey]);
  return <div className="code-view" ref={host} onMouseDown={() => editorStore.get().activeGroup !== groupId && focusGroup(groupId)} />;
}

function DocBanner({ docKey }) {
  const meta = useStore(docsStore, (s) => s[docKey]);
  if (!meta) return null;
  if (meta.disk === 'deleted') {
    return (
      <div className="editor-banner editor-banner--warn" role="status">
        <Icon name="warning" size={13} /> The file was deleted or moved on disk. Saving will ask before recreating it.
      </div>
    );
  }
  if (meta.disk === 'changed') {
    return (
      <div className="editor-banner editor-banner--warn" role="status">
        <Icon name="warning" size={13} /> The file changed on disk and you have unsaved changes.
        <button type="button" className="btn btn--ghost" onClick={() => revertDocument(docKey)}>Load disk version…</button>
        <button type="button" className="btn btn--ghost" onClick={() => saveDocument(docKey)}>Save mine…</button>
      </div>
    );
  }
  if (meta.readonly) return <div className="editor-banner" role="status"><Icon name="info" size={13} /> Read-only file. Use Save As to save a copy.</div>;
  if (meta.large) return <div className="editor-banner" role="status"><Icon name="info" size={13} /> Large file: syntax highlighting, folding and completion are turned off.</div>;
  return null;
}

function TabBar({ group, isActiveGroup }) {
  const metas = useStore(docsStore);
  const [dragKey, setDragKey] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [group.active]);

  const menu = (e, tab) => {
    const keys = group.tabs.map((t) => t.key);
    const i = keys.indexOf(tab.key);
    const meta = metas[tab.key];
    openContextMenu(e, [
      { label: 'Close', keybinding: 'Ctrl+W', run: () => closeTab(group.id, tab.key) },
      { label: 'Close Others', run: () => closeTabs(group.id, keys.filter((k) => k !== tab.key)) },
      { label: 'Close to the Right', disabled: i === keys.length - 1, run: () => closeTabs(group.id, keys.slice(i + 1)) },
      { label: 'Close Saved', run: () => closeTabs(group.id, keys.filter((k) => !metas[k]?.dirty)) },
      { label: 'Close All', run: () => closeTabs(group.id, keys) },
      { separator: true },
      { label: tab.pinned ? 'Unpin' : 'Pin', run: () => pinTab(group.id, tab.key, !tab.pinned) },
      { label: 'Split Right', run: () => { activateTab(group.id, tab.key); splitEditor('horizontal'); } },
      { label: 'Split Down', run: () => { activateTab(group.id, tab.key); splitEditor('vertical'); } },
      { separator: true },
      { label: 'Copy Path', disabled: !meta?.location, run: () => navigator.clipboard?.writeText(meta.location) },
      { label: 'Revert File', disabled: !meta?.dirty || meta.untitled, run: () => revertDocument(tab.key) },
      { label: 'Reload from Disk', disabled: meta?.untitled, run: () => reloadFromDisk(tab.key) },
    ]);
  };

  return (
    <div className={`editor-tabs${isActiveGroup ? ' editor-tabs--active' : ''}`} role="tablist" aria-label="Open editors" ref={listRef}>
      {group.tabs.map((tab, i) => {
        const meta = metas[tab.key];
        const active = tab.key === group.active;
        return (
          <div
            key={tab.key}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={meta?.location || meta?.name}
            className={['editor-tab', active && 'editor-tab--active', tab.preview && 'editor-tab--preview', tab.pinned && 'editor-tab--pinned', meta?.dirty && 'editor-tab--dirty'].filter(Boolean).join(' ')}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(group.id, tab.key);
              } else if (e.button === 0) activateTab(group.id, tab.key);
            }}
            onDoubleClick={() => tab.preview && pinTab(group.id, tab.key, false)}
            onContextMenu={(e) => menu(e, tab)}
            draggable
            onDragStart={() => setDragKey(tab.key)}
            onDragOver={(e) => dragKey && e.preventDefault()}
            onDrop={() => {
              if (dragKey) moveTab(group.id, dragKey, i);
              setDragKey(null);
            }}
          >
            <FileIcon name={meta?.name ?? ''} kind="file" size={14} />
            <span className="editor-tab__name">{meta?.name ?? tab.key}</span>
            {meta?.disk && meta.disk !== 'ok' && <span className="sev-warning" title="Changed on disk">!</span>}
            <button
              type="button"
              className="editor-tab__close"
              aria-label={`Close ${meta?.name ?? ''}`}
              title={meta?.dirty ? 'Unsaved changes — close' : 'Close'}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(group.id, tab.key);
              }}
            >
              <span className="editor-tab__dot" aria-hidden="true" />
              <Icon name="close" size={11} />
            </button>
          </div>
        );
      })}
      <div className="editor-tabs__fill" />
      <div className="editor-tabs__actions">
        <button type="button" className="btn btn--ghost btn--icon" title="Split Editor (Ctrl+\)" aria-label="Split editor" onClick={() => { focusGroup(group.id); splitEditor(); }}>
          <Icon name="split" size={14} />
        </button>
      </div>
    </div>
  );
}

function EditorGroup({ group, isActiveGroup }) {
  return (
    <section className={`editor-group${isActiveGroup ? ' editor-group--active' : ''}`} aria-label="Editor group" onFocus={() => !isActiveGroup && focusGroup(group.id)}>
      <TabBar group={group} isActiveGroup={isActiveGroup} />
      {group.active && <DocBanner docKey={group.active} />}
      {group.active ? (
        <CodeView groupId={group.id} activeKey={group.active} />
      ) : (
        <div className="empty-state editor-group__empty">
          <div className="subtle">No editor open in this group</div>
          <button type="button" className="btn btn--ghost" onClick={() => executeCommand('file.open')}>Open File…</button>
        </div>
      )}
    </section>
  );
}

/** Editor groups laid out side by side (or stacked). */
export function EditorArea() {
  const { groups, activeGroup, orientation } = useStore(editorStore);
  return (
    <div className={`editor-groups editor-groups--${orientation}`}>
      {groups.map((g) => (
        <EditorGroup key={g.id} group={g} isActiveGroup={g.id === activeGroup} />
      ))}
    </div>
  );
}

export { getDoc };
