import { useEffect } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { setSetting, useSetting } from '../../core/settings.js';
import { showPage } from '../../workspace/store.js';
import { backupStore, cancelRestore, createBackup, deleteBackup, exportBackup, importBackup, loadBackups, restoreBackup, verifyBackup } from './model.js';

const KIND = { manual: 'Manual', automatic: 'Automatic', safety: 'Before restore', imported: 'Imported' };
const size = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Backups page. */
export function BackupsView() {
  const { backups, folder, restorePending, busy, verified } = useStore(backupStore);
  const auto = useSetting('backup.automatic') ?? 'weekly';
  const keep = useSetting('backup.keep') ?? 10;
  useEffect(() => {
    loadBackups();
  }, []);
  return (
    <div className="tools-page">
      <div className="tools-page__inner">
        <div className="tools-bar">
          <h1><Icon name="shield" size={22} /> Backups</h1>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn--primary" disabled={Boolean(busy)} onClick={() => createBackup('manual')}>Back Up Now</button>
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={importBackup}>Import…</button>
          <button type="button" className="btn btn--ghost" onClick={() => showPage('editor')}>Back to editors</button>
        </div>
        <p className="subtle">
          Backups contain Ivily Center's own data — settings, workspaces and trust decisions, sessions, notes, installed extensions and unsaved drafts. Project files are never included; use
          version control for them. Stored in <span className="module-path selectable">{folder}</span>.
        </p>
        {busy && <p role="status" className="subtle">{busy}</p>}
        {restorePending && (
          <p className="sev-warning" role="status">
            A restore is staged and will be applied at the next start.{' '}
            <button type="button" className="link-like" onClick={cancelRestore}>Cancel the restore</button>
          </p>
        )}
        <div className="tools-bar">
          <label className="kb-check">
            Automatic backups{' '}
            <select className="select" value={auto} onChange={(e) => setSetting('backup.automatic', e.target.value, 'user')} aria-label="Automatic backups">
              <option value="off">Off</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          <label className="kb-check">
            keep the last{' '}
            <input className="input kb-num" type="number" min={1} max={100} value={keep} aria-label="Automatic backups to keep" onChange={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 100) setSetting('backup.keep', n, 'user'); }} />
          </label>
        </div>
        <table className="trust-table">
          <thead>
            <tr><th>Created</th><th>Type</th><th>Size</th><th>Contents</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {backups.map((b) => {
              const m = b.manifest;
              const v = verified[b.name];
              return (
                <tr key={b.name}>
                  <td title={b.name}>{m ? new Date(m.createdAt).toLocaleString() : b.name}</td>
                  <td>{m ? KIND[m.kind] ?? m.kind : <span className="sev-error">Unreadable</span>}</td>
                  <td>{size(b.size)}</td>
                  <td className="subtle">
                    {m ? `${m.files.length} file(s), schema v${m.schemaVersion}, app ${m.appVersion}` : b.error}
                    {v && <div className={v === 'ok' ? 'sev-info' : 'sev-error'}>{v === 'ok' ? 'Verified' : v}</div>}
                  </td>
                  <td className="tools-actions">
                    <button type="button" className="btn btn--ghost" disabled={!m || Boolean(busy)} onClick={() => verifyBackup(b.name)}>Verify</button>
                    <button type="button" className="btn btn--ghost" disabled={!m || Boolean(busy)} onClick={() => restoreBackup(b)}>Restore…</button>
                    <button type="button" className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => exportBackup(b)}>Export…</button>
                    <button type="button" className="btn btn--ghost btn--icon" aria-label={`Delete ${b.name}`} disabled={Boolean(busy)} onClick={() => deleteBackup(b)}><Icon name="trash" size={13} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {backups.length === 0 && <div className="empty-state subtle">No backups yet.</div>}
      </div>
    </div>
  );
}
