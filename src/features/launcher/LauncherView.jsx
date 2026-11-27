import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { confirmDialog } from '../../core/dialogs.js';
import { errorMessage } from '../../core/errors.js';
import { setSetting, useSetting } from '../../core/settings.js';
import { keybindingFor } from '../../core/keybindings.js';
import * as ipc from '../../platform/ipc.js';
import { openDiscovered, openFolder, openInNewWindow, openRecent, openWorkspaceFile, recentsVersion, updateCurrent, workspaceStore } from '../../workspace/store.js';

/** @typedef {import('../../platform/ipc.js').WorkspaceRecord} WorkspaceRecord */

const STATUS_LABEL = { missing: 'Missing', inaccessible: 'Not accessible', unreachable: 'Not reachable' };

/**
 * Filter by name, path or group (every term must match).
 * @param {WorkspaceRecord[]} records @param {string} query
 */
export function filterRecords(records, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return records;
  return records.filter((r) => {
    const hay = `${r.name}\n${r.path}\n${r.group}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

function EditForm({ record, onDone }) {
  const [name, setName] = useState(record.name);
  const [group, setGroup] = useState(record.group);
  const [error, setError] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    try {
      await ipc.workspaceUpdateMeta(record.id, { name, group });
      recentsVersion.set((v) => v + 1);
      const cur = workspaceStore.get().current;
      if (cur?.record.id === record.id) {
        updateCurrent({ record: { ...cur.record, name: name.trim(), group: group.trim() } });
      }
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <form className="launcher__edit" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && onDone()}>
      <input className="input" aria-label="Display name" value={name} maxLength={128} autoFocus onChange={(e) => setName(e.target.value)} />
      <input className="input" aria-label="Group" placeholder="Group (optional)" value={group} maxLength={64} onChange={(e) => setGroup(e.target.value)} />
      <button type="submit" className="btn btn--primary">Save</button>
      <button type="button" className="btn btn--ghost" onClick={onDone}>Cancel</button>
      {error && <div className="sev-error launcher__error" role="alert">{error}</div>}
    </form>
  );
}

function RecordRow({ record, status, isOpen, onChanged }) {
  const [editing, setEditing] = useState(false);
  const unavailable = status && status !== 'available';

  const toggleFavorite = async () => {
    try {
      await ipc.workspaceUpdateMeta(record.id, { favorite: !record.favorite });
      onChanged();
    } catch (e) {
      notify({ severity: 'error', title: 'Could not update the workspace', message: errorMessage(e), source: 'workspace' });
    }
  };
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Remove “${record.name}” from the list?`,
      message: 'Its saved session and workspace settings stored by Ivily Center are deleted. Files on disk are not touched, and trust decisions are kept.',
      detail: record.path,
      confirmLabel: 'Remove from list',
      danger: true,
    });
    if (!ok) return;
    try {
      await ipc.workspaceRemove(record.id);
      onChanged();
    } catch (e) {
      notify({ severity: 'error', title: 'Could not remove the workspace', message: errorMessage(e), source: 'workspace' });
    }
  };
  const locate = async () => {
    try {
      if (await ipc.workspaceRelocate(record.id)) onChanged();
    } catch (e) {
      notify({ severity: 'error', title: 'Could not change the location', message: errorMessage(e), source: 'workspace' });
    }
  };

  if (editing) return <li className="launcher__item launcher__item--editing"><EditForm record={record} onDone={() => { setEditing(false); onChanged(); }} /></li>;

  return (
    <li className={`launcher__item${unavailable ? ' launcher__item--unavailable' : ''}`}>
      <button type="button" className="launcher__open" onClick={() => openRecent(record.id)} disabled={isOpen} aria-describedby={`ws-path-${record.id}`}>
        <Icon name={record.kind === 'file' ? 'workspace' : 'folder'} size={18} />
        <span className="launcher__text">
          <span className="launcher__name">
            {record.name}
            {record.group && <span className="launcher__chip">{record.group}</span>}
            {isOpen && <span className="launcher__chip launcher__chip--accent">open</span>}
            {unavailable && <span className="launcher__chip launcher__chip--warn">{STATUS_LABEL[status]}</span>}
          </span>
          <span className="launcher__path subtle" id={`ws-path-${record.id}`}>{record.path}</span>
        </span>
        <span className="launcher__when subtle">{timeAgo(record.lastOpenedAt)}</span>
      </button>
      <div className="launcher__actions">
        {unavailable && (
          <button type="button" className="btn btn--ghost" onClick={locate}>Locate…</button>
        )}
        <button type="button" className="btn btn--ghost btn--icon" aria-pressed={record.favorite} aria-label={record.favorite ? 'Remove from favorites' : 'Add to favorites'} title={record.favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={toggleFavorite}>
          <Icon name="star" size={14} className={record.favorite ? 'icon--filled' : ''} />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" aria-label="Open in new window" title="Open in new window" onClick={() => openInNewWindow(record.id)} disabled={isOpen || unavailable}>
          <Icon name="split" size={14} />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" aria-label="Rename or group" title="Rename or group" onClick={() => setEditing(true)}>
          <Icon name="pencil" size={14} />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" aria-label="Remove from list" title="Remove from list" onClick={remove} disabled={isOpen}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </li>
  );
}

/** Workspace launcher: open, recent, favorites, groups and project discovery. Never mandatory. */
export function LauncherView() {
  const version = useStore(recentsVersion);
  const currentId = useStore(workspaceStore, (s) => s.current?.record.id);
  const busy = useStore(workspaceStore, (s) => s.busy);
  const startup = useSetting('workbench.startup') ?? 'lastWorkspace';
  const [records, setRecords] = useState(/** @type {WorkspaceRecord[] | null} */ (null));
  const [status, setStatus] = useState(/** @type {Record<string, string>} */ ({}));
  const [query, setQuery] = useState('');
  const [discovery, setDiscovery] = useState(null);
  const loadSeq = useRef(0);

  const reload = () => recentsVersion.set((v) => v + 1);

  useEffect(() => {
    if (!ipc.isTauri()) {
      setRecords([]);
      return;
    }
    const seq = ++loadSeq.current;
    ipc
      .workspaceList()
      .then((list) => {
        if (seq !== loadSeq.current) return;
        setRecords(list);
        return ipc.workspaceAvailability(list.map((r) => r.id)).then((res) => {
          if (seq === loadSeq.current) setStatus(Object.fromEntries(res.map((r) => [r.id, r.status])));
        });
      })
      .catch((e) => {
        setRecords([]);
        notify({ severity: 'error', title: 'Could not load recent workspaces', message: errorMessage(e), source: 'workspace' });
      });
  }, [version]);

  const filtered = useMemo(() => filterRecords(records ?? [], query), [records, query]);
  const favorites = filtered.filter((r) => r.favorite);
  const recent = filtered.filter((r) => !r.favorite);

  const discover = async () => {
    try {
      const result = await ipc.workspaceDiscover();
      if (result) setDiscovery(result);
    } catch (e) {
      notify({ severity: 'error', title: 'Could not search that folder', message: errorMessage(e), source: 'workspace' });
    }
  };

  const keyFor = (id) => keybindingFor(id);
  const row = (r) => <RecordRow key={r.id} record={r} status={status[r.id]} isOpen={r.id === currentId} onChanged={reload} />;

  return (
    <div className="launcher" aria-busy={busy}>
      <div className="launcher__inner">
        <header className="launcher__header">
          <div>
            <h1>Workspaces</h1>
            <p className="muted">Open a folder or a workspace file, or continue where you left off.</p>
          </div>
          <div className="launcher__primary">
            <button type="button" className="btn btn--primary" onClick={openFolder} disabled={busy}>
              <Icon name="folder-open" size={15} /> Open Folder…
              {keyFor('workspace.openFolder') && <kbd className="kbd">{keyFor('workspace.openFolder')}</kbd>}
            </button>
            <button type="button" className="btn" onClick={openWorkspaceFile} disabled={busy}>
              <Icon name="workspace" size={15} /> Open Workspace File…
            </button>
            <button type="button" className="btn" onClick={discover} disabled={busy}>
              <Icon name="search" size={15} /> Find Projects…
            </button>
          </div>
        </header>

        <input
          className="input launcher__search"
          type="search"
          placeholder="Filter by name, path or group"
          aria-label="Filter workspaces"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {records === null && <div className="empty-state">Loading…</div>}
        {records !== null && records.length === 0 && (
          <div className="empty-state">
            <Icon name="folder" size={28} />
            <div>No recent workspaces yet.</div>
            <div className="subtle">Open a folder to get started. Nothing is executed when a folder is opened.</div>
          </div>
        )}
        {records !== null && records.length > 0 && filtered.length === 0 && <div className="empty-state">No workspaces match “{query}”.</div>}

        {favorites.length > 0 && (
          <section aria-labelledby="launcher-fav">
            <h2 id="launcher-fav" className="section-title">Favorites</h2>
            <ul className="launcher__list">{favorites.map(row)}</ul>
          </section>
        )}
        {recent.length > 0 && (
          <section aria-labelledby="launcher-recent">
            <h2 id="launcher-recent" className="section-title">Recent</h2>
            <ul className="launcher__list">{recent.map(row)}</ul>
          </section>
        )}

        {discovery && (
          <section aria-labelledby="launcher-found">
            <div className="launcher__found-head">
              <h2 id="launcher-found" className="section-title">Projects in {discovery.root}</h2>
              <button type="button" className="btn btn--ghost btn--icon" aria-label="Hide results" title="Hide results" onClick={() => setDiscovery(null)}>
                <Icon name="close" size={14} />
              </button>
            </div>
            {discovery.projects.length === 0 && <div className="subtle launcher__none">No project folders were found directly inside this folder.</div>}
            <ul className="launcher__list">
              {discovery.projects.map((p) => (
                <li key={p.token} className="launcher__item">
                  <button type="button" className="launcher__open" onClick={() => (p.knownWorkspaceId ? openRecent(p.knownWorkspaceId) : openDiscovered(p.token))}>
                    <Icon name="folder" size={18} />
                    <span className="launcher__text">
                      <span className="launcher__name">
                        {p.name}
                        {p.markers.map((m) => (
                          <span key={m} className="launcher__chip">{m}</span>
                        ))}
                        {p.knownWorkspaceId && <span className="launcher__chip launcher__chip--accent">in list</span>}
                      </span>
                      <span className="launcher__path subtle">{p.path}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="launcher__footer">
          <label className="subtle" htmlFor="launcher-startup">On startup</label>
          <select
            id="launcher-startup"
            className="select"
            value={String(startup)}
            onChange={(e) => setSetting('workbench.startup', e.target.value).catch((err) => notify({ severity: 'error', title: 'Could not save', message: errorMessage(err), source: 'settings' }))}
          >
            <option value="lastWorkspace">Reopen the last workspace</option>
            <option value="launcher">Show this launcher</option>
            <option value="welcome">Show the welcome page</option>
          </select>
        </footer>
      </div>
    </div>
  );
}
