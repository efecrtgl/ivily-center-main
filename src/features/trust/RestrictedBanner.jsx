import { useState } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { showPage, workspaceStore } from '../../workspace/store.js';
import { LEVEL_LABEL } from '../../workspace/trust.js';

/** Persistent notice while the workspace is not fully trusted. Dismissable per workspace. */
export function RestrictedBanner() {
  const current = useStore(workspaceStore, (s) => s.current);
  const [dismissed, setDismissed] = useState(null);
  if (!current || current.trust.level === 'trusted' || dismissed === current.record.id) return null;
  const partial = current.trust.level === 'partial';
  return (
    <div className={`restricted-banner${partial ? ' restricted-banner--partial' : ''}`} role="status">
      <Icon name="shield" size={14} />
      <span>
        <strong>{LEVEL_LABEL[current.trust.level]}</strong>
        {partial
          ? ' — only some workspace-defined actions are allowed.'
          : ' — tasks, workspace processes, language servers, extensions and debugging defined by this workspace are disabled.'}
      </span>
      <button type="button" className="btn btn--ghost" onClick={() => workspaceStore.set((s) => ({ ...s, trustPrompt: true }))}>Trust…</button>
      <button type="button" className="btn btn--ghost" onClick={() => showPage('trust')}>Manage</button>
      <button type="button" className="btn btn--ghost btn--icon" aria-label="Hide this notice" title="Hide this notice" onClick={() => setDismissed(current.record.id)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
