import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../core/store.js';
import { closeContextMenu, contextMenuStore } from '../core/contextMenu.js';

/** Keyboard-accessible context menu (arrows, Home/End, Enter, Escape). */
export function ContextMenu() {
  const menu = useStore(contextMenuStore);
  const ref = useRef(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)),
    });
    ref.current.querySelector('[role="menuitem"]:not([disabled])')?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) closeContextMenu();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeContextMenu();
      }
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', closeContextMenu);
      window.removeEventListener('resize', closeContextMenu);
    };
  }, [menu]);

  if (!menu) return null;

  const onKeyDown = (e) => {
    const items = [...ref.current.querySelectorAll('[role="menuitem"]:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    const go = (n) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
  };

  return (
    <div className="context-menu popover" role="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((it, i) =>
        'separator' in it ? (
          <div key={i} className="context-menu__sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`context-menu__item${it.danger ? ' context-menu__item--danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              closeContextMenu();
              it.run?.();
            }}
          >
            <span>{it.label}</span>
            {it.keybinding && <span className="subtle context-menu__key">{it.keybinding}</span>}
          </button>
        ),
      )}
    </div>
  );
}
