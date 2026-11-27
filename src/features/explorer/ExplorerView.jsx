import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { openFolder, openWorkspaceFile, showPage, workspaceStore } from '../../workspace/store.js';

/**
 * Explorer: lists the workspace folders. Browsing their contents arrives with the file
 * explorer (Phase 4); the UI says so plainly instead of showing a fake tree.
 */
export function ExplorerView() {
  const ws = useStore(workspaceStore, (s) => s.current);
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
  return (
    <div className="explorer">
      <ul className="explorer__roots" aria-label="Workspace folders">
        {ws.folders.map((f) => (
          <li key={f.path} className={`explorer__root${f.available ? '' : ' explorer__root--missing'}`} title={f.problem ?? f.path}>
            <Icon name="folder" size={15} />
            <span className="explorer__name">{f.name}</span>
            {!f.available && <span className="launcher__chip launcher__chip--warn">unavailable</span>}
            <span className="explorer__path subtle">{f.path}</span>
          </li>
        ))}
      </ul>
      <p className="subtle explorer__note">Browsing files inside the workspace is not available yet in this development build.</p>
    </div>
  );
}
