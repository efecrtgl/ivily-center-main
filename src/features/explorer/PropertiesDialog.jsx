import { useEffect } from 'react';
import { createStore, useStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import * as ipc from '../../platform/ipc.js';

const propsStore = createStore(/** @type {any} */ (null));

export async function showProperties(root, path) {
  try {
    propsStore.set(await ipc.fsProperties(root, path));
  } catch (e) {
    notify({ severity: 'error', title: 'Could not read properties', message: errorMessage(e), source: 'explorer' });
  }
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function PropertiesDialog() {
  const p = useStore(propsStore);
  useEffect(() => {
    if (!p) return;
    const onKey = (e) => e.key === 'Escape' && propsStore.set(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p]);
  if (!p) return null;
  const date = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && propsStore.set(null)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="props-title">
        <h2 id="props-title">{p.name || 'Properties'}</h2>
        <dl className="props-list">
          <dt>Location</dt>
          <dd className="mono selectable">{p.path}</dd>
          <dt>Type</dt>
          <dd>{p.kind === 'dir' ? 'Folder' : p.kind === 'link' ? 'Link' : 'File'}</dd>
          {p.kind === 'dir' ? (
            <>
              <dt>Items</dt>
              <dd>{p.items ?? '—'}</dd>
            </>
          ) : (
            <>
              <dt>Size</dt>
              <dd>{formatBytes(p.size)} ({p.size.toLocaleString()} bytes)</dd>
            </>
          )}
          <dt>Created</dt>
          <dd>{date(p.created)}</dd>
          <dt>Modified</dt>
          <dd>{date(p.modified)}</dd>
          <dt>Attributes</dt>
          <dd>{[p.readonly && 'Read-only', p.hidden && 'Hidden'].filter(Boolean).join(', ') || 'None'}</dd>
        </dl>
        <div className="modal__actions">
          <button type="button" className="btn btn--primary" autoFocus onClick={() => propsStore.set(null)}>Close</button>
        </div>
      </div>
    </div>
  );
}
