import { useEffect, useState } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import * as ipc from '../../platform/ipc.js';
import { showPage, workspaceStore } from '../../workspace/store.js';
import { loadModules, modulesStore, openModule, requestSummary, setModuleEnabled, STATUS_LABEL, SUMMARIES, summarize } from './model.js';

const STATUS_CLASS = { ok: 'sev-info', degraded: 'sev-warning', disabled: 'sev-warning', incompatible: 'sev-warning', error: 'sev-error', notInstalled: 'subtle', off: 'subtle' };
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString() : '');

function Summary({ entry }) {
  if (!entry) return null;
  if (entry.loading) return <div className="subtle module-detail">Asking…</div>;
  if (entry.error) return <div className="sev-error module-detail">{entry.error}</div>;
  const rows = summarize(entry.result);
  return (
    <div className="module-detail selectable">
      {rows.length === 0 && <span className="subtle">No data.</span>}
      {rows.slice(0, 200).map((r, i) => (
        <div key={i} className="module-row" style={{ paddingLeft: `${r.depth * 0.9}rem` }}>
          {r.key && <span className="module-row__key">{r.key}</span>}
          {r.value !== '' && <span>{r.value}</span>}
        </div>
      ))}
    </div>
  );
}

function ModuleCard({ m, details }) {
  const [open, setOpen] = useState(null);
  const ws = useStore(workspaceStore, (s) => s.current);
  const caps = m.info?.capabilities ?? [];
  const granted = new Set(m.info?.granted ?? []);
  const summaries = (SUMMARIES[m.product] ?? []).filter((s) => !s.capability || granted.has(s.capability));
  const health = m.info?.health;
  const update = m.info?.update;
  const activity = m.info?.activity;
  const ask = (s) => {
    setOpen(s.method);
    const root = ws?.folders?.[0]?.path;
    requestSummary(m.product, s.method, s.needsRoot ? { root } : null);
  };
  return (
    <article className="module-card" aria-label={m.name}>
      <header className="module-card__head">
        <div>
          <h2>{m.name}</h2>
          <div className="subtle">{m.description}</div>
        </div>
        <span className={`badge ${STATUS_CLASS[m.status] ?? ''}`}>{STATUS_LABEL[m.status] ?? m.status}</span>
      </header>
      <dl className="module-facts">
        {m.version && (<><dt>Version</dt><dd>{m.version}{update?.updateAvailable ? ` — ${update.latestVersion} available` : ''}</dd></>)}
        {m.info?.protocol && (<><dt>Protocol</dt><dd>{m.info.protocol}</dd></>)}
        {health && (<><dt>Health</dt><dd>{health.status}{health.database ? ` · database ${health.database}` : ''}</dd></>)}
        {activity && (<><dt>Last 7 days</dt><dd>{activity.total ?? 0} operation(s)</dd></>)}
        {m.path && (<><dt>Location</dt><dd className="module-path" title={m.path}>{m.path}</dd></>)}
      </dl>
      {m.message && <p className="module-message">{m.message}</p>}
      {m.status === 'notInstalled' && (
        <p className="subtle module-message">
          Not found in the default location. Install it from its{' '}
          <button type="button" className="link-like" onClick={() => ipc.openExternalUrl(m.repository).catch(() => {})}>releases page</button>, or set its location in Settings → Ecosystem.
        </p>
      )}
      {caps.length > 0 && (
        <div className="module-caps">
          {caps.map((c) => (
            <span key={c.id} className={`badge${c.status === 'available' ? '' : ' subtle'}`} title={c.description ?? c.status}>
              {c.id}
              {c.status !== 'available' ? ` (${c.status === 'notGranted' ? 'not granted' : c.status})` : ''}
            </span>
          ))}
        </div>
      )}
      <div className="module-actions">
        {['ok', 'degraded'].includes(m.status) &&
          summaries.map((s) => (
            <button key={s.method} type="button" className={`btn${open === s.method ? ' btn--primary' : ''}`} disabled={s.needsRoot && !ws} onClick={() => ask(s)} title={s.needsRoot ? 'Sends the first workspace folder path to the module for a read-only analysis' : undefined}>
              {s.label}
            </button>
          ))}
        {m.path && m.status !== 'off' && (
          <button type="button" className="btn btn--ghost" onClick={() => openModule(m.product)}>
            Open {m.name.replace('Ivily ', '')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <label className="kb-check subtle">
          <input type="checkbox" className="checkbox" checked={m.status !== 'off'} onChange={(e) => setModuleEnabled(m.product, e.target.checked)} /> Use in Ivily Center
        </label>
      </div>
      {open && <Summary entry={details?.[open]} />}
    </article>
  );
}

/** Ecosystem dashboard (page). */
export function ModulesView() {
  const { modules, loading, error, details } = useStore(modulesStore);
  useEffect(() => {
    if (!modules.length) loadModules(false);
  }, [modules.length]);
  const checked = modules.reduce((t, m) => Math.max(t, m.checkedAt ?? 0), 0);
  return (
    <div className="tools-page">
      <div className="tools-page__inner">
        <div className="tools-bar">
          <h1><Icon name="ecosystem" size={22} /> Ivily Ecosystem</h1>
          <span style={{ flex: 1 }} />
          <span className="subtle">{checked ? `Checked ${fmtTime(checked)}` : ''}</span>
          <button type="button" className="btn" disabled={loading} onClick={() => loadModules(true)}>
            <Icon name="refresh" size={14} /> {loading ? 'Checking…' : 'Refresh'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => showPage('editor')}>Back to editors</button>
        </div>
        <p className="subtle">
          Ivily Center works on its own; these apps are optional. Status is read on demand through the local, read-only Ivily Ecosystem Protocol — nothing runs in the background and no
          module can change anything from here.
        </p>
        {error && <p className="sev-warning">{error}</p>}
        <div className="module-grid">
          {modules.map((m) => (
            <ModuleCard key={m.product} m={m} details={details[m.product]} />
          ))}
        </div>
      </div>
    </div>
  );
}
