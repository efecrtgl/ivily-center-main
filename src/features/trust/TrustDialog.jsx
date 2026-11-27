import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { useSetting } from '../../core/settings.js';
import { workspaceStore } from '../../workspace/store.js';
import { CAPABILITIES, denyTrust, grantTrust, parentOf } from '../../workspace/trust.js';

/**
 * Asks whether to trust a newly opened workspace. Closing the dialog (Escape) leaves the workspace
 * in Restricted Mode *without* recording a decision, so the user is asked again next time.
 * Nothing is ever trusted without an explicit click.
 */
export function TrustDialog() {
  const { current, trustPrompt } = useStore(workspaceStore);
  const promptEnabled = useSetting('security.workspaceTrust.prompt') ?? true;
  const [customize, setCustomize] = useState(false);
  const [caps, setCaps] = useState(() => new Set(CAPABILITIES.map((c) => c.id)));
  const [remember, setRemember] = useState(true);
  const [working, setWorking] = useState(false);
  const ref = useRef(null);
  const open = Boolean(current && trustPrompt && promptEnabled);

  useEffect(() => {
    if (!open) return;
    setCustomize(false);
    ref.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') workspaceStore.set((s) => ({ ...s, trustPrompt: false }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, current?.record.id]);

  if (!open) return null;

  const undecided = current.trust.folders.filter((f) => f.decision === null);
  const folders = undecided.length ? undecided : current.trust.folders;
  const parents = [...new Set(folders.map((f) => parentOf(f.path)))];
  const parentLabel = parents.length === 1 && parents[0] ? parents[0] : null;
  const run = async (fn) => {
    setWorking(true);
    try {
      await fn();
    } finally {
      setWorking(false);
    }
  };
  const toggle = (id) => setCaps((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal trust-dialog" role="dialog" aria-modal="true" aria-labelledby="trust-title" aria-describedby="trust-desc" tabIndex={-1} ref={ref}>
        <div className="trust-dialog__head">
          <Icon name="shield" size={26} />
          <h2 id="trust-title">Do you trust the authors of the files in this workspace?</h2>
        </div>
        <div id="trust-desc" className="trust-dialog__body">
          <p>
            Ivily Center opened <strong>{current.record.name}</strong> in <strong>Restricted Mode</strong>. You can browse and edit files
            safely. Until you trust it, nothing defined by the workspace is executed:
          </p>
          <ul className="trust-dialog__caps">
            {CAPABILITIES.map((c) => <li key={c.id}>{c.title}</li>)}
          </ul>
          <ul className="trust-dialog__folders mono">
            {folders.map((f) => <li key={f.pathKey}>{f.path}</li>)}
          </ul>
          <p className="subtle">Only trust code from sources you know. Trust is stored by Ivily Center on this computer, never in the project, and can be revoked at any time.</p>
        </div>

        {customize && (
          <fieldset className="trust-dialog__custom">
            <legend className="section-title">Allow</legend>
            {CAPABILITIES.map((c) => (
              <label key={c.id} className="trust-dialog__cap">
                <input type="checkbox" className="checkbox" checked={caps.has(c.id)} onChange={() => toggle(c.id)} />
                <span>
                  {c.title}
                  <span className="subtle trust-dialog__capdesc">{c.description}</span>
                </span>
              </label>
            ))}
            <label className="trust-dialog__cap">
              <input type="checkbox" className="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>Remember this decision (otherwise it lasts until Ivily Center is closed)</span>
            </label>
            <div className="trust-dialog__actions">
              <button type="button" className="btn btn--primary" disabled={working || caps.size === 0} onClick={() => run(() => grantTrust({ scope: 'folder', capabilities: [...caps], remember }))}>
                Apply
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setCustomize(false)}>Back</button>
            </div>
          </fieldset>
        )}

        {!customize && (
          <div className="trust-dialog__actions">
            <button type="button" className="btn btn--primary" disabled={working} onClick={() => run(() => grantTrust({ scope: 'folder', capabilities: null, remember: true }))}>
              Trust {folders.length > 1 ? 'these folders' : 'this folder'}
            </button>
            {parentLabel && (
              <button type="button" className="btn" disabled={working} title={`Trust every folder inside ${parentLabel}`} onClick={() => run(() => grantTrust({ scope: 'parent', capabilities: null, remember: true }))}>
                Trust everything in {parentLabel}
              </button>
            )}
            <button type="button" className="btn" disabled={working} onClick={() => run(() => grantTrust({ scope: 'folder', capabilities: null, remember: false }))}>
              Trust for this session
            </button>
            <button type="button" className="btn btn--ghost" disabled={working} onClick={() => setCustomize(true)}>Customize…</button>
            <span className="trust-dialog__spacer" />
            {undecided.length > 0 ? (
              <button type="button" className="btn" disabled={working} onClick={() => run(denyTrust)} title="Remember this choice and do not ask again for these folders">
                Stay restricted
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => workspaceStore.set((st) => ({ ...st, trustPrompt: false }))}>
                Cancel
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
