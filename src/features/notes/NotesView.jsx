import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import * as ipc from '../../platform/ipc.js';
import { isCurrentEpoch, workspaceStore } from '../../workspace/store.js';
import { registerFlushHook } from '../../workspace/session.js';
import { renderMarkdown } from '../preview/markdown.js';
import { followLink } from '../preview/model.js';

const SAVE_DELAY = 600;
let pending = null; // { epoch, text }
let timer = null;

async function flush() {
  clearTimeout(timer);
  timer = null;
  const p = pending;
  pending = null;
  if (!p || !isCurrentEpoch(p.epoch) || !ipc.isTauri()) return;
  try {
    await ipc.notesWrite(p.text);
  } catch (e) {
    notify({ severity: 'error', title: 'Could not save notes', message: errorMessage(e), source: 'notes' });
  }
}
registerFlushHook(flush);

/** Workspace notes (Markdown, stored in the app data folder, saved automatically). */
export function NotesView() {
  const ws = useStore(workspaceStore, (s) => s.current);
  const epoch = useStore(workspaceStore, (s) => s.epoch);
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState('edit');
  const ref = useRef(null);

  useEffect(() => {
    setLoaded(false);
    if (!ws || !ipc.isTauri()) return undefined;
    let alive = true;
    ipc.notesRead().then(
      (t) => {
        if (alive && isCurrentEpoch(epoch)) {
          setText(t);
          setLoaded(true);
        }
      },
      (e) => notify({ severity: 'error', title: 'Could not read notes', message: errorMessage(e), source: 'notes' }),
    );
    return () => {
      alive = false;
      flush();
    };
  }, [ws?.record.id, epoch]);

  const html = useMemo(() => (mode === 'preview' ? renderMarkdown(text) : ''), [mode, text]);
  if (!ws) return <div className="empty-state subtle search-empty">Open a folder to keep notes for it.</div>;

  const onChange = (v) => {
    setText(v);
    pending = { epoch, text: v };
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY);
  };
  return (
    <div className="notes">
      <div className="scm-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'edit'} className={`scm-tab${mode === 'edit' ? ' scm-tab--active' : ''}`} onClick={() => setMode('edit')}>Edit</button>
        <button type="button" role="tab" aria-selected={mode === 'preview'} className={`scm-tab${mode === 'preview' ? ' scm-tab--active' : ''}`} onClick={() => setMode('preview')}>Preview</button>
      </div>
      {mode === 'edit' ? (
        <textarea
          className="input notes__text"
          aria-label="Workspace notes"
          placeholder={loaded ? 'Notes for this workspace (Markdown). Saved automatically, kept outside the project.' : 'Loading…'}
          disabled={!loaded}
          value={text}
          spellCheck
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        // eslint-disable-next-line react/no-danger -- sanitized by DOMPurify
        <article
          ref={ref}
          className="markdown-body notes__preview selectable"
          onClick={(e) => {
            const a = /** @type {HTMLElement} */ (e.target).closest?.('a');
            if (!a) return;
            e.preventDefault();
            followLink(a.getAttribute('href'), null, ref.current);
          }}
          dangerouslySetInnerHTML={{ __html: html || '<p class="subtle">No notes yet.</p>' }}
        />
      )}
    </div>
  );
}
