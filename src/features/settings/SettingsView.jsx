import { useDeferredValue, useState } from 'react';
import { useStore } from '../../core/store.js';
import { groupByCategory, resetSetting, searchSettings, setSetting, settingsStore, workspaceScoped } from '../../core/settings.js';
import { errorCode, errorMessage } from '../../core/errors.js';
import { notify } from '../../core/notifications.js';
import { workspaceStore } from '../../workspace/store.js';

/**
 * One setting row for a scope. The value shown is that scope's own value when set, otherwise the
 * inherited effective value. Validation errors come from Rust.
 * @param {{ s: import('../../core/settings.js').SettingSchema, resolved: any, scope: 'user' | 'workspace' }} props
 */
function SettingRow({ s, resolved, scope }) {
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);
  const own = scope === 'user' ? resolved?.userValue : resolved?.workspaceValue;
  const isSet = own !== undefined;
  const value = isSet ? own : scope === 'workspace' ? (resolved?.value ?? s.default) : s.default;
  const overridden = scope === 'user' && resolved?.source === 'workspace';
  const id = `setting-${scope}-${s.key}`;

  const report = (e) => {
    setError(errorMessage(e));
    if (errorCode(e) === 'conflict') {
      notify({
        severity: 'warning',
        title: 'The workspace file changed on disk',
        message: 'Your change was not saved so the other change is not lost. Reload the workspace file and try again.',
        source: 'settings',
        actions: [{ label: 'Reload Workspace File', command: 'workspace.reloadFile' }],
      });
    }
  };
  const commit = async (v) => {
    setError(null);
    try {
      await setSetting(s.key, v, scope);
      setDraft(null);
    } catch (e) {
      report(e);
    }
  };

  let control;
  if (s.type === 'boolean') {
    control = <input id={id} type="checkbox" className="checkbox" checked={value === true} onChange={(e) => commit(e.target.checked)} />;
  } else if (s.type === 'enum') {
    control = (
      <select id={id} className="select" value={String(value)} onChange={(e) => commit(e.target.value)}>
        {s.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (s.type === 'integer') {
    control = (
      <input
        id={id}
        type="number"
        className="input setting__number"
        min={s.min}
        max={s.max}
        step={1}
        value={draft ?? String(value)}
        aria-invalid={Boolean(error)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== null && commit(Number(draft))}
        onKeyDown={(e) => e.key === 'Enter' && draft !== null && commit(Number(draft))}
      />
    );
  } else {
    control = (
      <input
        id={id}
        type="text"
        className="input"
        maxLength={s.maxLength}
        value={draft ?? String(value)}
        aria-invalid={Boolean(error)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== null && commit(draft)}
      />
    );
  }

  return (
    <div className={`setting${isSet ? ' setting--modified' : ''}`}>
      <div className="setting__head">
        <label htmlFor={id} className="setting__title">
          {s.title}
        </label>
        {isSet && (
          <button type="button" className="btn btn--ghost setting__reset" onClick={() => resetSetting(s.key, scope).catch(report)}>
            {scope === 'workspace' ? 'Use user value' : 'Reset'}
          </button>
        )}
      </div>
      <div className="setting__desc subtle">{s.description}</div>
      <div className="setting__control">
        {control}
        {s.type === 'integer' && <span className="subtle">{`${s.min}–${s.max}`}</span>}
      </div>
      {overridden && <div className="setting__note sev-info">Overridden in this workspace</div>}
      {scope === 'workspace' && !isSet && <div className="setting__note subtle">Not set for this workspace — inherited</div>}
      {error && (
        <div className="setting__error sev-error" role="alert">
          {error}
        </div>
      )}
      <code className="setting__key subtle">{s.key}</code>
    </div>
  );
}

export function SettingsView() {
  const { schema, values, loaded } = useStore(settingsStore);
  const workspace = useStore(workspaceStore, (s) => s.current);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState(/** @type {'user' | 'workspace'} */ ('user'));
  const scope = workspace ? tab : 'user';
  const deferred = useDeferredValue(query);
  const visible = scope === 'workspace' ? workspaceScoped(schema) : schema;
  const groups = groupByCategory(searchSettings(visible, deferred, values));

  return (
    <div className="settings">
      <div className="settings__search">
        {workspace && (
          <div className="settings__tabs" role="tablist" aria-label="Settings scope">
            {['user', 'workspace'].map((t) => (
              <button key={t} type="button" role="tab" aria-selected={scope === t} className={`settings__tab${scope === t ? ' settings__tab--active' : ''}`} onClick={() => setTab(t)}>
                {t === 'user' ? 'User' : 'Workspace'}
              </button>
            ))}
          </div>
        )}
        <input
          className="input"
          type="search"
          placeholder="Search settings (@modified for changed ones)"
          aria-label="Search settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {scope === 'workspace' && (
        <p className="subtle settings__note">
          {workspace.file
            ? `Saved in the workspace file ${workspace.file}.`
            : 'Stored by Ivily Center for this workspace; nothing is written into the project folder.'}{' '}
          Workspace values override user values.
        </p>
      )}
      {!loaded && <div className="empty-state">Loading settings…</div>}
      {loaded && groups.length === 0 && <div className="empty-state">No settings match “{query}”.</div>}
      {groups.map((g) => (
        <section key={g.category} className="settings__group" aria-label={g.category}>
          <h2 className="section-title">{g.category}</h2>
          {g.items.map((s) => (
            <SettingRow key={`${scope}-${s.key}`} s={s} resolved={values[s.key]} scope={scope} />
          ))}
        </section>
      ))}
      {!workspace && <p className="subtle settings__note">Open a workspace to change settings for it.</p>}
    </div>
  );
}
