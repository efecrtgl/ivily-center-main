import { Icon } from '../icons/Icon.jsx';
import { useStore } from '../core/store.js';
import { viewStore, viewsAt } from '../core/views.js';
import { layoutStore, updateLayout } from '../core/layout.js';
import { executeCommand } from '../core/commands.js';

export function Panel() {
  const views = viewsAt(useStore(viewStore), 'panel');
  const panelView = useStore(layoutStore, (l) => l.panelView);
  const active = views.find((v) => v.id === panelView) || views[0];
  const Active = active?.component;

  return (
    <section className="panel" aria-label="Panel">
      <div className="panel__header">
        <div className="panel__tabs" role="tablist">
          {views.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={v === active}
              className={`panel__tab${v === active ? ' panel__tab--active' : ''}`}
              onClick={() => updateLayout({ panelView: v.id })}
            >
              {v.title}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--ghost btn--icon" aria-label="Close panel" title="Close panel" onClick={() => executeCommand('workbench.togglePanel')}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="panel__body" role="tabpanel">
        {Active ? <Active /> : null}
      </div>
    </section>
  );
}
