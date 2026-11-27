import { useEffect } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { describeContributions, extensionsStore, installExtension, loadExtensions, setExtensionEnabled, uninstallExtension } from './model.js';

/** Extensions side-bar view. */
export function ExtensionsView() {
  const { installed, issues, recommendations, problems, loaded } = useStore(extensionsStore);
  useEffect(() => {
    if (!loaded) loadExtensions();
  }, [loaded]);
  const ids = new Set(installed.map((e) => e.manifest.id));
  const missing = recommendations.filter((r) => !ids.has(r));
  return (
    <div className="ext-view">
      <div className="debug-start">
        <button type="button" className="btn btn--primary" onClick={installExtension}>
          <Icon name="folder-open" size={14} /> Install from Folder…
        </button>
        <div className="subtle debug-note">Extensions are declarative (themes, icon packs, snippets, shortcuts, file associations) and never run code.</div>
      </div>
      <ul className="ext-list" aria-label="Installed extensions">
        {installed.map((ext) => {
          const m = ext.manifest;
          return (
            <li key={m.id} className={`ext-item${ext.enabled ? '' : ' ext-item--disabled'}`}>
              <div className="ext-item__head">
                <strong>{m.name}</strong> <span className="subtle">{m.version}</span>
                <span style={{ flex: 1 }} />
                <label className="kb-check" title={ext.enabled ? 'Disable' : 'Enable'}>
                  <input type="checkbox" className="checkbox" checked={ext.enabled} onChange={(e) => setExtensionEnabled(m.id, e.target.checked)} aria-label={`Enable ${m.name}`} />
                </label>
                <button type="button" className="btn btn--ghost btn--icon" aria-label={`Remove ${m.name}`} title="Remove" onClick={() => uninstallExtension(ext)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
              <div className="subtle ext-item__meta">
                {m.id}
                {m.publisher ? ` · ${m.publisher}` : ''}
              </div>
              {m.description && <div className="ext-item__desc">{m.description}</div>}
              <ul className="ext-item__contrib subtle">
                {describeContributions(m.contributes).map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
              {problems[m.id]?.map((p) => (
                <div key={p} className="sev-warning debug-note">{p}</div>
              ))}
            </li>
          );
        })}
        {loaded && installed.length === 0 && <li className="subtle debug-note">No extensions installed.</li>}
      </ul>
      {missing.length > 0 && (
        <div className="debug-start">
          <div className="section-title">Recommended by this workspace</div>
          {missing.map((r) => (
            <div key={r} className="subtle debug-note">{r} — not installed. Ivily Center has no extension marketplace; get the extension folder from its publisher.</div>
          ))}
        </div>
      )}
      {issues.map((i) => (
        <div key={i} className="sev-warning debug-note">{i}</div>
      ))}
    </div>
  );
}
