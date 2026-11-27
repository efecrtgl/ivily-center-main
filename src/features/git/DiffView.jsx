import { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { MergeView, unifiedMergeView, goToNextChunk, goToPreviousChunk } from '@codemirror/merge';
import { syntaxHighlighting } from '@codemirror/language';
import { createStore, useStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import * as ipc from '../../platform/ipc.js';
import { showPage } from '../../workspace/store.js';
import { editorTheme, highlightStyle } from '../editor/cm.js';
import { languageForFile } from '../editor/languages.js';
import { themeStore } from '../../theme/engine.js';
import { openDocument } from '../editor/model.js';
import { activeRepo, gitStore, toRepoPath, toWorkspacePath } from './model.js';

/** @typedef {{ title: string, root: number, path: string, original: string, modified: string, openRef?: { root: number, path: string } | null }} DiffData */
export const diffStore = createStore(/** @type {DiffData | null} */ (null));

/**
 * Show the diff of a status entry. `staged`: HEAD ↔ index; otherwise index ↔ working tree.
 * @param {number} root @param {import('./model.js').FileStatus} f @param {boolean} staged
 */
export async function openStatusDiff(root, f, staged) {
  const repo = gitStore.get().repos.find((r) => r.root === root);
  if (!repo) return;
  const wsPath = toWorkspacePath(repo, f.path);
  try {
    let original = '';
    let modified = '';
    if (staged) {
      original = (await ipc.gitShow(root, 'HEAD', f.orig ?? f.path)) ?? '';
      modified = (await ipc.gitShow(root, ':0', f.path)) ?? '';
    } else {
      if (!f.untracked) original = (await ipc.gitShow(root, ':0', f.path)) ?? (await ipc.gitShow(root, 'HEAD', f.path)) ?? '';
      if (f.worktree !== 'D' && wsPath !== null) modified = (await ipc.docRead({ root, path: wsPath })).content;
    }
    diffStore.set({
      title: `${f.path} (${staged ? 'staged' : f.untracked ? 'untracked' : 'working tree'})`,
      root,
      path: f.path,
      original: original.replace(/\r\n/g, '\n'),
      modified: modified.replace(/\r\n/g, '\n'),
      openRef: wsPath !== null && f.worktree !== 'D' ? { root, path: wsPath } : null,
    });
    showPage('diff');
  } catch (e) {
    notify({ severity: 'error', title: 'Could not show the diff', message: errorMessage(e), source: 'git' });
  }
}

/** Diff of one file in a commit (parent ↔ commit). */
export async function openCommitDiff(root, sha, file) {
  const repo = gitStore.get().repos.find((r) => r.root === root) ?? activeRepo();
  try {
    const original = file.status === 'A' ? '' : ((await ipc.gitShow(root, `${sha}^`, file.orig ?? file.path)) ?? '');
    const modified = file.status === 'D' ? '' : ((await ipc.gitShow(root, sha, file.path)) ?? '');
    const wsPath = repo ? toWorkspacePath(repo, file.path) : null;
    diffStore.set({ title: `${file.path} @ ${sha.slice(0, 8)}`, root, path: file.path, original, modified, openRef: wsPath !== null ? { root, path: wsPath } : null });
    showPage('diff');
  } catch (e) {
    notify({ severity: 'error', title: 'Could not show the diff', message: errorMessage(e), source: 'git' });
  }
}

/** Side-by-side or inline diff page with chunk navigation. */
export function DiffView() {
  const data = useStore(diffStore);
  const dark = useStore(themeStore, (s) => s.current?.appearance !== 'light');
  const [inline, setInline] = useState(false);
  const host = useRef(null);
  const views = useRef([]);

  useEffect(() => {
    if (!data || !host.current) return;
    let cancelled = false;
    const el = host.current;
    (async () => {
      const lang = await languageForFile(data.path).catch(() => null);
      if (cancelled) return;
      const base = [lineNumbers(), editorTheme(dark), syntaxHighlighting(highlightStyle), EditorState.readOnly.of(true), EditorView.editable.of(false), lang?.support ?? []];
      el.innerHTML = '';
      if (inline) {
        const v = new EditorView({
          parent: el,
          state: EditorState.create({ doc: data.modified, extensions: [...base, unifiedMergeView({ original: data.original, mergeControls: false, gutter: true })] }),
        });
        views.current = [v];
      } else {
        const mv = new MergeView({
          parent: el,
          a: { doc: data.original, extensions: base },
          b: { doc: data.modified, extensions: base },
          gutter: true,
          collapseUnchanged: { margin: 3, minSize: 8 },
        });
        views.current = [mv.b, mv];
      }
    })();
    return () => {
      cancelled = true;
      for (const v of views.current) v.destroy?.();
      views.current = [];
    };
  }, [data, inline, dark]);

  if (!data) return <div className="empty-state">No diff selected.</div>;
  const nav = (fn) => {
    const v = views.current[0];
    if (v) fn(v);
  };
  return (
    <div className="diff-page">
      <div className="diff-toolbar">
        <strong className="diff-title" title={data.title}>{data.title}</strong>
        <button type="button" className="btn btn--ghost" onClick={() => nav(goToPreviousChunk)} title="Previous change">↑ Prev</button>
        <button type="button" className="btn btn--ghost" onClick={() => nav(goToNextChunk)} title="Next change">↓ Next</button>
        <button type="button" className="btn btn--ghost" aria-pressed={inline} onClick={() => setInline(!inline)}>{inline ? 'Side by side' : 'Inline'}</button>
        {data.openRef && <button type="button" className="btn btn--ghost" onClick={() => openDocument(data.openRef)}>Open File</button>}
        <button type="button" className="btn btn--ghost" onClick={() => showPage('editor')}>Close</button>
      </div>
      {!inline && (
        <div className="diff-labels subtle">
          <span>Original</span>
          <span>Modified</span>
        </div>
      )}
      <div className="diff-host" ref={host} />
    </div>
  );
}

export { toRepoPath };
