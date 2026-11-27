import { useEffect, useState } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { confirmDialog } from '../../core/dialogs.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import * as ipc from '../../platform/ipc.js';
import { showPage, workspaceStore } from '../../workspace/store.js';
import { CAPABILITIES, LEVEL_LABEL, revokeTrust } from '../../workspace/trust.js';

const capTitle = (id) => CAPABILITIES.find((c) => c.id === id)?.title ?? id;

function sourceLabel(f) {
  switch (f.source.kind) {
    case 'folder':
      return 'Decision for this folder';
    case 'parent':
      return `Inherited from ${f.source.path}`;
    case 'session':
      return 'This session only';
    default:
      return 'No decision yet';
  }
}

/** Manage Workspace Trust: current workspace status and every remembered decision. */
export function TrustManagerView() {
  const current = useStore(workspaceStore, (s) => s.current);
  const [records, setRecords] = useState(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!ipc.isTauri()) {
      setRecords([]);
      return;
    }
    ipc.trustList().then(setRecords, (e) => {
      setRecords([]);
      notify({ severity: 'error', title: 'Could not load trust decisions', message: errorMessage(e), source: 'trust' });
    });
  }, [version, current?.trust]);

  const revoke = async (r) => {
    const ok = await confirmDialog({
      title: r.decision === 'trusted' ? 'Revoke trust?' : 'Forget this decision?',
      message:
        r.decision === 'trusted'
          ? 'Workspaces in this location will open in Restricted Mode again. Nothing already running is affected (nothing runs yet in this version).'
          : 'You will be asked again the next time a workspace in this location is opened.',
      detail: r.path + (r.includeChildren ? ' (and all subfolders)' : ''),
      confirmLabel: r.decision === 'trusted' ? 'Revoke trust' : 'Forget decision',
      danger: r.decision === 'trusted',
    });
    if (ok && (await revokeTrust(r.pathKey))) setVersion((v) => v + 1);
  };

  return (
    <div className="trust-manager">
      <div className="trust-manager__inner">
        <header className="trust-manager__header">
          <h1>
            <Icon name="shield" size={22} /> Workspace Trust
          </h1>
          <button type="button" className="btn btn--ghost" onClick={() => showPage(current ? 'welcome' : 'launcher')}>Close</button>
        </header>
        <p className="muted">
          Trust decides whether Ivily Center may execute things a workspace defines — tasks, processes, language servers, extensions,
          debug sessions and executables referenced in workspace settings. Decisions are stored by Ivily Center on this computer, never
          inside a project.
        </p>

        {current && (
          <section aria-labelledby="tm-current">
            <h2 id="tm-current" className="section-title">This workspace — {LEVEL_LABEL[current.trust.level]}</h2>
            <table className="trust-table">
              <thead>
                <tr><th>Folder</th><th>Status</th><th>Allowed</th><th /></tr>
              </thead>
              <tbody>
                {current.trust.folders.map((f) => (
                  <tr key={f.pathKey}>
                    <td className="mono">{f.path}</td>
                    <td>
                      {f.decision === 'trusted' ? 'Trusted' : f.decision === 'denied' ? 'Restricted (remembered)' : 'Restricted'}
                      <div className="subtle">{sourceLabel(f)}</div>
                    </td>
                    <td>{f.capabilities.length === CAPABILITIES.length ? 'Everything' : f.capabilities.length ? f.capabilities.map(capTitle).join(', ') : 'Nothing'}</td>
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="trust-manager__actions">
              <button type="button" className="btn btn--primary" onClick={() => workspaceStore.set((s) => ({ ...s, trustPrompt: true }))}>
                Change trust for this workspace…
              </button>
            </div>
          </section>
        )}

        <section aria-labelledby="tm-all">
          <h2 id="tm-all" className="section-title">Remembered decisions</h2>
          {records === null && <div className="subtle">Loading…</div>}
          {records?.length === 0 && <div className="subtle">No decisions yet.</div>}
          {records?.length > 0 && (
            <table className="trust-table">
              <thead>
                <tr><th>Location</th><th>Decision</th><th>Allowed</th><th /></tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={`${r.pathKey}-${r.persistent}`}>
                    <td className="mono">
                      {r.path}
                      {r.includeChildren && <div className="subtle">and all subfolders</div>}
                    </td>
                    <td>
                      {r.decision === 'trusted' ? 'Trusted' : 'Restricted'}
                      <div className="subtle">{r.persistent ? `since ${new Date(r.updatedAt).toLocaleString()}` : 'this session only'}</div>
                    </td>
                    <td>{r.decision === 'denied' ? '—' : r.capabilities.length === CAPABILITIES.length ? 'Everything' : r.capabilities.map(capTitle).join(', ')}</td>
                    <td>
                      <button type="button" className="btn" onClick={() => revoke(r)}>{r.decision === 'trusted' ? 'Revoke' : 'Forget'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
