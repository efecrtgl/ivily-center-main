import { Icon } from '../icons/Icon.jsx';
import { useStore } from '../core/store.js';
import { viewStore, viewsAt } from '../core/views.js';
import { layoutStore, toggleSidebarView } from '../core/layout.js';
import { keybindingFor } from '../core/keybindings.js';

export function ActivityBar() {
  const views = viewsAt(useStore(viewStore), 'sidebar');
  const { sidebarVisible, sidebarView } = useStore(layoutStore);

  const item = (v) => {
    const active = sidebarVisible && sidebarView === v.id;
    const key = v.command ? keybindingFor(v.command) : null;
    return (
      <button
        key={v.id}
        type="button"
        className={`activitybar__item${active ? ' activitybar__item--active' : ''}`}
        aria-pressed={active}
        aria-label={v.title}
        title={key ? `${v.title} (${key})` : v.title}
        onClick={() => toggleSidebarView(v.id)}
      >
        <Icon name={v.icon} size={22} />
      </button>
    );
  };

  return (
    <nav className="activitybar" aria-label="Views">
      <div className="activitybar__group">{views.filter((v) => v.group !== 'bottom').map(item)}</div>
      <div className="activitybar__group">{views.filter((v) => v.group === 'bottom').map(item)}</div>
    </nav>
  );
}
