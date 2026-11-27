import { useEffect, useMemo } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { useSetting, setSetting } from '../../core/settings.js';
import * as ipc from '../../platform/ipc.js';
import { showPage } from '../../workspace/store.js';
import { appStore } from '../../app/appStore.js';
import { renderMarkdown } from '../preview/markdown.js';
import { checkForUpdates, installUpdate, loadUpdateInfo, updateStore } from './model.js';

const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : '');
const OUTCOME = { upToDate: 'Up to date', available: 'Update available', failed: 'Failed', started: 'Installer started' };

/** About & Updates page. */
export function UpdatesView() {
  const { info, checking, result, error, progress } = useStore(updateStore);
  const app = useStore(appStore, (s) => s.info);
  const auto = useSetting('updates.checkOnStartup');
  useEffect(() => {
    loadUpdateInfo();
  }, []);
  const notes = useMemo(() => (result?.notes ? renderMarkdown(result.notes) : ''), [result?.notes]);
  const pct = progress?.total ? Math.round((progress.downloaded / progress.total) * 100) : null;

  return (
    <div className="tools-page">
      <div className="tools-page__inner">
        <div className="tools-bar">
          <h1><Icon name="info" size={22} /> About Ivily Center</h1>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn--ghost" onClick={() => showPage('editor')}>Back to editors</button>
        </div>
        <dl className="module-facts">
          <dt>Version</dt>
          <dd>{info?.currentVersion ?? app?.version ?? '—'}</dd>
          <dt>Source</dt>
          <dd>
            <button type="button" className="link-like" onClick={() => ipc.openExternalUrl('https://github.com/efecrtgl/ivily-center-main').catch(() => {})}>github.com/efecrtgl/ivily-center-main</button> · MIT licence
          </dd>
          {app?.database && (<><dt>Data</dt><dd className="module-path">{app.database.path ?? 'in memory'}</dd></>)}
        </dl>

        <h2 className="section-title updates-title">Updates</h2>
        <div className="tools-bar">
          <button type="button" className="btn btn--primary" disabled={checking || Boolean(progress)} onClick={() => checkForUpdates()}>
            <Icon name="refresh" size={14} /> {checking ? 'Checking…' : 'Check for Updates'}
          </button>
          <label className="kb-check">
            <input type="checkbox" className="checkbox" checked={auto !== false} onChange={(e) => setSetting('updates.checkOnStartup', e.target.checked, 'user')} /> Check once a day on startup
          </label>
        </div>
        {error && <p className="sev-warning">{error}</p>}
        {result && !result.available && !error && <p>Ivily Center {result.currentVersion} is up to date (checked {fmt(result.checkedAt)}).</p>}
        {result?.available && (
          <div className="module-card">
            <div className="module-card__head">
              <div>
                <h2>Ivily Center {result.version}</h2>
                <div className="subtle">{result.date ? `Released ${result.date}` : ''}</div>
              </div>
              <button type="button" className="btn btn--primary" disabled={Boolean(progress)} onClick={installUpdate}>
                Download and Install
              </button>
            </div>
            {progress && (
              <div role="status" className="subtle">
                {progress.stage === 'installing' ? 'Starting the installer…' : `Downloading${pct != null ? ` ${pct}%` : '…'}`}
                {pct != null && <progress max={100} value={pct} className="update-progress" />}
              </div>
            )}
            {/* eslint-disable-next-line react/no-danger -- sanitized by DOMPurify */}
            {notes && <article className="markdown-body update-notes" dangerouslySetInnerHTML={{ __html: notes }} />}
          </div>
        )}
        <p className="subtle">
          Updates come only from this project's GitHub Releases and are verified with the Ivily signing key built into the app before installation. Nothing is downloaded or installed without
          your confirmation.
        </p>

        {info?.history?.length > 0 && (
          <>
            <h2 className="section-title updates-title">History</h2>
            <table className="trust-table">
              <tbody>
                {info.history.slice(0, 20).map((h, i) => (
                  <tr key={i}>
                    <td>{fmt(h.at)}</td>
                    <td>{h.kind === 'check' ? 'Check' : 'Install'}</td>
                    <td>{OUTCOME[h.outcome] ?? h.outcome}{h.version ? ` (${h.version})` : ''}</td>
                    <td className="subtle">{h.message ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
