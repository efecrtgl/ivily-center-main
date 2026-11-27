import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../icons/Icon.jsx';
import { useStore } from '../core/store.js';
import { closeQuickPick, filterItems, quickPickStore } from '../core/quickPick.js';

const MAX_ROWS = 200;

function Highlighted({ text, positions }) {
  if (!positions.length) return text;
  const set = new Set(positions);
  return [...text].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : ch));
}

/** Quick pick host (top of the window). */
export function QuickPick() {
  const req = useStore(quickPickStore);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!req) return;
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  }, [req]);

  // Static item lists are filtered here; providers (functions) filter themselves.
  useEffect(() => {
    if (!req) return;
    const n = ++seq.current;
    Promise.resolve(typeof req.items === 'function' ? req.items(query) : req.items).then((list) => {
      if (n === seq.current) setItems(list ?? []);
    });
  }, [req, query]);

  const rows = useMemo(() => {
    if (!req) return [];
    const r = typeof req.items === 'function' ? items.map((item) => ({ item, positions: [] })) : filterItems(items, query, req.matchOnDescription);
    return r.slice(0, MAX_ROWS);
  }, [req, items, query]);

  useEffect(() => {
    if (!req || query) return;
    const i = rows.findIndex((r) => r.item.id === req.activeId);
    if (i >= 0) setActive(i);
  }, [rows, req, query]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  if (!req) return null;

  const pick = (i) => rows[i] && closeQuickPick(rows[i].item);
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 10));
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 10));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeQuickPick(null);
    }
  };

  let lastGroup = null;
  return (
    <div className="quick-pick-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && closeQuickPick(null)}>
      <div className="quick-pick popover" role="dialog" aria-label={req.placeholder ?? 'Quick pick'}>
        <input
          ref={inputRef}
          className="input quick-pick__input"
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-pick-list"
          aria-activedescendant={rows[active] ? `qp-${active}` : undefined}
          placeholder={req.placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <div className="quick-pick__list" id="quick-pick-list" role="listbox" ref={listRef}>
          {rows.length === 0 && <div className="quick-pick__empty subtle">No matching items</div>}
          {rows.map(({ item, positions }, i) => {
            const header = item.group && item.group !== lastGroup && !query ? item.group : null;
            lastGroup = item.group ?? lastGroup;
            return (
              <div key={`${item.id}-${i}`}>
                {header && <div className="quick-pick__group section-title">{header}</div>}
                <div
                  id={`qp-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={`quick-pick__item${i === active ? ' quick-pick__item--active' : ''}`}
                  onMouseMove={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(i);
                  }}
                >
                  {item.icon && <Icon name={item.icon} size={14} />}
                  <span className="quick-pick__label">
                    <Highlighted text={item.label} positions={positions} />
                  </span>
                  {item.description && <span className="quick-pick__desc subtle">{item.description}</span>}
                  {item.keybinding && <kbd className="kbd">{item.keybinding}</kbd>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
