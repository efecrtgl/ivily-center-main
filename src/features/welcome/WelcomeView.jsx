import { useStore } from '../../core/store.js';
import { appStore } from '../../app/appStore.js';
import { commandsVersion, executeCommand, listCommands } from '../../core/commands.js';
import { keybindingFor, keybindingStore } from '../../core/keybindings.js';
import { listThemes, themeStore } from '../../theme/engine.js';
import { ThemeSwatch, selectTheme } from '../../shell/ThemePicker.jsx';
import { workspaceStore } from '../../workspace/store.js';

/** Editor-area start page. Lists real commands and shortcuts from the registry. */
export function WelcomeView() {
  const info = useStore(appStore, (s) => s.info);
  useStore(commandsVersion);
  useStore(keybindingStore);
  const current = useStore(themeStore, (s) => s.current?.id);
  const workspace = useStore(workspaceStore, (s) => s.current);
  const shortcuts = listCommands({ paletteOnly: true })
    .map((c) => ({ ...c, key: keybindingFor(c.id) }))
    .filter((c) => c.key);

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <header className="welcome__header">
          <h1>Ivily Center</h1>
          <p className="muted">
            Development build {info?.version ?? __APP_VERSION__}.{' '}
            {workspace ? `Workspace “${workspace.record.name}” is open.` : 'No workspace is open.'}
          </p>
          <div className="welcome__start">
            {!workspace && (
              <button type="button" className="btn btn--primary" onClick={() => executeCommand('workspace.openFolder')}>
                Open Folder…
              </button>
            )}
            <button type="button" className="btn" onClick={() => executeCommand('workbench.commandPalette')}>
              Show All Commands
            </button>
            <button type="button" className="btn" onClick={() => executeCommand('workbench.quickOpen')}>
              Go to File…
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => executeCommand('ecosystem.showDashboard')}>
              Ivily Ecosystem
            </button>
          </div>
        </header>

        <section className="welcome__section" aria-labelledby="welcome-themes">
          <h2 id="welcome-themes" className="section-title">
            Theme
          </h2>
          <div className="welcome__themes">
            {listThemes().map((t) => (
              <button key={t.id} type="button" className="card welcome__theme" aria-pressed={t.id === current} onClick={() => selectTheme(t.id)}>
                <ThemeSwatch theme={t} />
                <span>{t.name}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="welcome__section" aria-labelledby="welcome-keys">
          <h2 id="welcome-keys" className="section-title">
            Keyboard shortcuts
          </h2>
          <ul className="welcome__keys">
            {shortcuts.map((c) => (
              <li key={c.id}>
                <button type="button" className="welcome__key" onClick={() => executeCommand(c.id)}>
                  <span>
                    <span className="subtle">{c.category}: </span>
                    {c.title}
                  </span>
                  <kbd className="kbd">{c.key}</kbd>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {info && (
          <p className="subtle welcome__storage">
            Data: {info.database.mode === 'persistent' ? info.database.path : 'in memory (not saved)'} · schema v{info.database.schemaVersion}
          </p>
        )}
      </div>
    </div>
  );
}
