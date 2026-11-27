import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import * as ipc from '../../platform/ipc.js';
import { listLanguages, TIER_LABEL } from '../../languages/registry.js';
import { registerBuiltinLanguages } from '../../languages/builtin.js';
import { showPage, workspaceStore } from '../../workspace/store.js';
import { confirmDialog } from '../../core/dialogs.js';
import { runInNewTerminal, terminalStore, loadProfiles } from '../terminal/model.js';

/** Detection results shared with other features (e.g. LSP server discovery). */
export const toolsStore = createStore(/** @type {null | { tools: any[], relevant: string[], detectedAt: number }} */ (null));

/** Language intelligence status per language id, filled by the LSP manager (Phase 7). */
export const languageIntelStore = createStore(/** @type {Record<string, { server: string, state: string }>} */ ({}));

export async function detectTools(refresh = false) {
  if (!ipc.isTauri()) return null;
  try {
    const r = await ipc.toolchainsDetect(refresh);
    toolsStore.set(r);
    return r;
  } catch (e) {
    notify({ severity: 'error', title: 'Tool detection failed', message: errorMessage(e), source: 'tools' });
    return null;
  }
}

const STATUS = {
  available: { label: 'Installed', cls: 'sev-info' },
  notFound: { label: 'Not found', cls: 'subtle' },
  storeAlias: { label: 'Store alias only', cls: 'sev-warning' },
  unverified: { label: 'Found, version unknown', cls: 'sev-warning' },
};

/** Install a tool with winget in a visible terminal, after explicit confirmation. */
async function installInTerminal(t) {
  const command = `winget install --id ${t.winget} --exact --source winget`;
  const ok = await confirmDialog({
    title: `Install ${t.name}?`,
    message:
      `This runs the command below in a new PowerShell terminal. winget downloads ${t.name} from the official winget community repository ` +
      '(package id shown below). Depending on the package, it installs for your user or system-wide and may ask for administrator approval (UAC). ' +
      'You can cancel in the terminal at any time (Ctrl+C). Run “Detect again” afterwards to verify.',
    detail: command,
    confirmLabel: 'Run in terminal',
  });
  if (!ok) return;
  const profiles = terminalStore.get().profiles.length ? terminalStore.get().profiles : await loadProfiles();
  const ps = profiles.find((p) => p.id === 'pwsh') ?? profiles.find((p) => p.id === 'powershell');
  await runInNewTerminal(command, ps?.id);
}

function ToolRow({ t, relevant }) {
  const copyWinget = () => {
    navigator.clipboard?.writeText(`winget install --id ${t.winget} --exact --source winget`);
    notify({ title: 'winget command copied', message: 'Run it in a terminal to install. Ivily Center does not install software by itself.', source: 'tools' });
  };
  const missing = t.status !== 'available';
  return (
    <tr className={missing && relevant ? 'tools-row--needed' : undefined}>
      <td>
        <strong>{t.name}</strong>
        {relevant && <span className="launcher__chip launcher__chip--accent" title="Used by the open workspace">workspace</span>}
        <div className="subtle">{t.category}</div>
      </td>
      <td className={STATUS[t.status]?.cls}>{STATUS[t.status]?.label ?? t.status}</td>
      <td className="mono">{t.version ?? '—'}</td>
      <td className="mono tools-path" title={t.path ?? ''}>{t.path ?? '—'}</td>
      <td className="tools-actions">
        {missing && (
          <>
            <button type="button" className="btn btn--ghost" onClick={() => ipc.toolchainsOpenHomepage(t.id).catch(() => {})}>Download page</button>
            {t.winget && <button type="button" className="btn btn--ghost" onClick={copyWinget} title={`winget install --id ${t.winget}`}>Copy winget command</button>}
            {t.winget && <button type="button" className="btn btn--ghost" onClick={() => installInTerminal(t)}>Install in terminal…</button>}
          </>
        )}
      </td>
    </tr>
  );
}

function ServersTab() {
  const [list, setList] = useState(null);
  useEffect(() => {
    if (ipc.isTauri()) ipc.lspServers().then(setList, () => setList([]));
    else setList([]);
  }, []);
  const copy = (text) => {
    navigator.clipboard?.writeText(text);
    notify({ title: 'Install command copied', message: 'Run it in a terminal. Ivily Center never installs language servers by itself.', source: 'tools' });
  };
  return (
    <section>
      <p className="muted">
        Language servers provide completion, hover, diagnostics, go to definition, references, rename and formatting. They run only in
        workspaces trusted for language servers. A specific executable can be set in Settings → Language Servers.
      </p>
      {!list && <div className="empty-state">Loading…</div>}
      {list && (
        <table className="trust-table tools-table">
          <thead><tr><th>Server</th><th>Languages</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong><div className="subtle mono">{s.id}</div></td>
                <td className="subtle">{s.languages.join(', ')}</td>
                <td>
                  {s.disabled ? <span className="subtle">Disabled</span> : s.path ? <span className="sev-info">Installed</span> : <span className="subtle">Not installed</span>}
                  {s.path && <div className="mono subtle tools-path" title={s.path}>{s.path}</div>}
                </td>
                <td className="tools-actions">
                  {!s.path && <button type="button" className="btn btn--ghost" onClick={() => copy(s.install)} title={s.install}>Copy install command</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** "Languages & Tools" page. */
export function ToolsView() {
  const data = useStore(toolsStore);
  const ws = useStore(workspaceStore, (s) => s.current);
  const intel = useStore(languageIntelStore);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('tools');
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!data) detectTools(false);
  }, [data]);
  useEffect(() => {
    detectTools(false);
  }, [ws?.record.id]);

  const relevant = useMemo(() => new Set(data?.relevant ?? []), [data]);
  const tools = useMemo(() => {
    const list = data?.tools ?? [];
    return [...list].sort((a, b) => Number(relevant.has(b.id)) - Number(relevant.has(a.id)) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }, [data, relevant]);
  registerBuiltinLanguages();
  const langs = listLanguages().filter((l) => !query || `${l.name} ${(l.extensions ?? []).join(' ')}`.toLowerCase().includes(query.toLowerCase()));

  const refresh = async () => {
    setBusy(true);
    await detectTools(true);
    setBusy(false);
  };

  return (
    <div className="tools-page">
      <div className="tools-page__inner">
        <header className="trust-manager__header">
          <h1><Icon name="wrench" size={22} /> Languages &amp; Tools</h1>
          <button type="button" className="btn btn--ghost" onClick={() => showPage(ws ? 'editor' : 'launcher')}>Close</button>
        </header>
        <div className="settings__tabs tools-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'tools'} className={`settings__tab${tab === 'tools' ? ' settings__tab--active' : ''}`} onClick={() => setTab('tools')}>Toolchains</button>
          <button type="button" role="tab" aria-selected={tab === 'languages'} className={`settings__tab${tab === 'languages' ? ' settings__tab--active' : ''}`} onClick={() => setTab('languages')}>Languages</button>
          <button type="button" role="tab" aria-selected={tab === 'servers'} className={`settings__tab${tab === 'servers' ? ' settings__tab--active' : ''}`} onClick={() => setTab('servers')}>Language Servers</button>
        </div>

        {tab === 'tools' && (
          <section>
            <p className="muted">
              Tools found on this computer (PATH and common install folders). Detection runs each tool's version command from a neutral folder;
              nothing from the workspace is executed and nothing is installed automatically.
            </p>
            <div className="tools-bar">
              <button type="button" className="btn" onClick={refresh} disabled={busy}><Icon name="refresh" size={14} /> {busy ? 'Detecting…' : 'Detect again'}</button>
              {data && <span className="subtle">Last checked {new Date(data.detectedAt).toLocaleTimeString()}</span>}
            </div>
            {!data && <div className="empty-state">Detecting tools…</div>}
            {data && (
              <table className="trust-table tools-table">
                <thead><tr><th>Tool</th><th>Status</th><th>Version</th><th>Location</th><th /></tr></thead>
                <tbody>{tools.map((t) => <ToolRow key={t.id} t={t} relevant={relevant.has(t.id)} />)}</tbody>
              </table>
            )}
          </section>
        )}

        {tab === 'servers' && <ServersTab />}

        {tab === 'languages' && (
          <section>
            <p className="muted">
              <strong>Syntax + structure</strong>: full parser (highlighting, folding, indentation). <strong>Syntax highlighting</strong>: token-based.{' '}
              <strong>Basic highlighting</strong>: keywords, strings and comments only. Completion, diagnostics and navigation require a language server.
            </p>
            <input className="input tools-filter" type="search" placeholder="Filter languages" aria-label="Filter languages" value={query} onChange={(e) => setQuery(e.target.value)} />
            <table className="trust-table">
              <thead><tr><th>Language</th><th>File types</th><th>Editor support</th><th>Code intelligence</th></tr></thead>
              <tbody>
                {langs.map((l) => (
                  <tr key={l.id}>
                    <td><strong>{l.name}</strong>{l.note && <div className="subtle">{l.note}</div>}</td>
                    <td className="mono subtle">{[...(l.filenames ?? []), ...(l.extensions ?? []).map((e) => `.${e}`)].slice(0, 8).join(' ')}</td>
                    <td>{TIER_LABEL[l.tier]}</td>
                    <td>{intel[l.id] ? `${intel[l.id].server} (${intel[l.id].state})` : <span className="subtle">None</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}
