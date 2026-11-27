import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { clearChannel, formatEntry, loadChannels, openChannel, outputStore } from '../../core/output.js';
import { notify } from '../../core/notifications.js';
import { createStore } from '../../core/store.js';

/** Selected channel is shared with commands (e.g. "Clear Output"). */
export const outputUi = createStore({ channel: 'app' });

const LEVELS = ['trace', 'info', 'warn', 'error'];

export function OutputView() {
  const { channels, entries } = useStore(outputStore);
  const channel = useStore(outputUi, (s) => s.channel);
  const [filter, setFilter] = useState('');
  const [minLevel, setMinLevel] = useState('trace');
  const [follow, setFollow] = useState(true);
  const scroller = useRef(null);

  useEffect(() => {
    loadChannels().catch(() => {});
  }, []);
  useEffect(() => {
    openChannel(channel).catch(() => {});
  }, [channel]);

  const lines = entries[channel] || [];
  const visible = useMemo(() => {
    const min = LEVELS.indexOf(minLevel);
    const q = filter.toLowerCase();
    return lines.filter((e) => LEVELS.indexOf(e.level) >= min && (!q || e.message.toLowerCase().includes(q)));
  }, [lines, filter, minLevel]);

  useLayoutEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [visible, follow]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(visible.map(formatEntry).join('\n'));
      notify({ title: 'Output copied to the clipboard', source: 'output' });
    } catch {
      notify({ severity: 'warning', title: 'Could not access the clipboard', source: 'output' });
    }
  };

  return (
    <div className="output">
      <div className="output__toolbar">
        <select className="select" aria-label="Output channel" value={channel} onChange={(e) => outputUi.set({ channel: e.target.value })}>
          {(channels.length ? channels : [{ id: channel, label: channel }]).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Minimum level" value={minLevel} onChange={(e) => setMinLevel(e.target.value)}>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l === 'trace' ? 'All levels' : `${l} and above`}
            </option>
          ))}
        </select>
        <input className="input output__filter" type="search" placeholder="Filter" aria-label="Filter output" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="output__spacer" />
        <label className="output__follow subtle">
          <input type="checkbox" className="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <button type="button" className="btn btn--ghost btn--icon" title="Copy visible output" aria-label="Copy visible output" onClick={copy}>
          <Icon name="copy" size={14} />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" title="Clear channel" aria-label="Clear channel" onClick={() => clearChannel(channel)}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      <div className="output__lines selectable" ref={scroller} role="log" aria-label={`Output: ${channel}`}>
        {visible.length === 0 ? (
          <div className="subtle output__empty">No output.</div>
        ) : (
          visible.map((e) => (
            <div key={e.seq} className={`output__line output__line--${e.level}`}>
              {formatEntry(e)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
