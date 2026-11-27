import { useDeferredValue, useState } from 'react';
import { useStore } from '../../core/store.js';
import { groupByCategory, resetSetting, searchSettings, setSetting, settingsStore } from '../../core/settings.js';

/** One setting row: control chosen from the schema type; validation errors come from Rust. */
function SettingRow({ s, resolved }) {
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);
  const value = resolved?.value ?? s.default;
  const modified = (resolved?.source ?? 'default') !== 'default';
  const id = `setting-${s.key}`;

  const commit = async (v) => {
    setError(null);
    try {
      await setSetting(s.key, v);
      setDraft(null);
    } catch (e) {
      setError(e?.message ?? String(e));
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
    <div className={`setting${modified ? ' setting--modified' : ''}`}>
      <div className="setting__head">
        <label htmlFor={id} className="setting__title">
          {s.title}
        </label>
        {modified && (
          <button type="button" className="btn btn--ghost setting__reset" onClick={() => resetSetting(s.key).catch((e) => setError(e?.message ?? String(e)))}>
            Reset
          </button>
        )}
      </div>
      <div className="setting__desc subtle">{s.description}</div>
      <div className="setting__control">
        {control}
        {s.type === 'integer' && <span className="subtle">{`${s.min}–${s.max}`}</span>}
      </div>
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
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const groups = groupByCategory(searchSettings(schema, deferred, values));

  return (
    <div className="settings">
      <div className="settings__search">
        <input
          className="input"
          type="search"
          placeholder="Search settings (@modified for changed ones)"
          aria-label="Search settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {!loaded && <div className="empty-state">Loading settings…</div>}
      {loaded && groups.length === 0 && <div className="empty-state">No settings match “{query}”.</div>}
      {groups.map((g) => (
        <section key={g.category} className="settings__group" aria-label={g.category}>
          <h2 className="section-title">{g.category}</h2>
          {g.items.map((s) => (
            <SettingRow key={s.key} s={s} resolved={values[s.key]} />
          ))}
        </section>
      ))}
      <p className="subtle settings__note">Settings shown here apply to your user profile. Workspace-level settings become available with workspaces.</p>
    </div>
  );
}
