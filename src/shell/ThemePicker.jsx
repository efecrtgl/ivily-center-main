import { useEffect, useRef } from 'react';
import { useStore } from '../core/store.js';
import { listThemes, resolveTokens, themeStore } from '../theme/engine.js';
import { setSetting } from '../core/settings.js';
import { notify } from '../core/notifications.js';

/** Swatch preview drawn from the theme's own resolved tokens (works for any registered theme). */
export function ThemeSwatch({ theme }) {
  const t = resolveTokens(theme);
  return (
    <span className="theme-swatch" data-style-preview={theme.style} aria-hidden="true" style={{ background: t['color.bg'], borderColor: t['color.border.strong'] }}>
      <span style={{ background: t['color.surface'] }} />
      <span style={{ background: t['color.accent'] }} />
      <span style={{ background: t['color.fg'] }} />
    </span>
  );
}

export function selectTheme(id) {
  return setSetting('appearance.theme', id).catch((e) =>
    notify({ severity: 'error', title: 'Could not change theme', message: e?.message ?? String(e), source: 'settings' }),
  );
}

/** Theme list popover (status bar). Arrow keys move, Enter selects, Escape closes. */
export function ThemePicker({ onClose }) {
  useStore(themeStore, (s) => s.version);
  const current = useStore(themeStore, (s) => s.current?.id);
  const themes = listThemes();
  const ref = useRef(null);

  useEffect(() => {
    ref.current?.querySelector('[aria-checked="true"]')?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...ref.current.querySelectorAll('[role="menuitemradio"]')];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div className="popover theme-picker" role="menu" aria-label="Theme" ref={ref} onKeyDown={onKeyDown}>
      <div className="section-title popover__title">Theme</div>
      {themes.map((t) => (
        <button
          key={t.id}
          type="button"
          role="menuitemradio"
          aria-checked={t.id === current}
          className="theme-picker__item"
          onClick={() => {
            selectTheme(t.id);
            onClose();
          }}
        >
          <ThemeSwatch theme={t} />
          <span className="theme-picker__name">{t.name}</span>
          {t.id === current && <span className="subtle">active</span>}
        </button>
      ))}
    </div>
  );
}
