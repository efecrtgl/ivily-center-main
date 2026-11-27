import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { createStore, useStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import * as ipc from '../../platform/ipc.js';
import { showPage } from '../../workspace/store.js';
import { activeEditor, getDoc, openDocument, revealInDocument } from '../editor/model.js';
import { classifyLink, renderMarkdown, resolveRelative } from './markdown.js';

/** Which document the preview page shows. */
export const previewStore = createStore(/** @type {{ key: string | null }} */ ({ key: null }));

export const previewKind = (name) => (/\.(md|markdown|mdx)$/i.test(name) ? 'markdown' : /\.html?$/i.test(name) ? 'html' : null);

/** Open the preview for the active editor (Markdown or HTML). */
export function openPreview() {
  const ed = activeEditor();
  if (!ed?.doc || !previewKind(ed.doc.name)) {
    notify({ severity: 'info', title: 'Preview is available for Markdown and HTML files', source: 'preview' });
    return;
  }
  previewStore.set({ key: ed.key });
  showPage('preview');
}

/** Follow a link clicked in rendered Markdown. */
export function followLink(href, doc, container) {
  const link = classifyLink(href);
  if (link.kind === 'external') {
    ipc.openExternalUrl(link.url).catch(() => notify({ severity: 'warning', title: 'Could not open the link', message: link.url, source: 'preview' }));
  } else if (link.kind === 'anchor') {
    const target = [...container.querySelectorAll('[id]')].find((el) => el.id === link.id);
    target?.scrollIntoView?.({ block: 'start' });
  } else if (link.kind === 'relative' && doc?.ref && 'root' in doc.ref) {
    const path = resolveRelative(doc.ref.path, link.path);
    if (path === null) return;
    const ref = { root: doc.ref.root, path };
    if (link.line) revealInDocument(ref, link.line);
    else openDocument(ref);
  }
}

/** Live text of a document (re-read when the editor content object changes). */
function useDocText(key) {
  const [text, setText] = useState(() => getDoc(key)?.text ?? null);
  useEffect(() => {
    const t = setInterval(() => {
      const next = getDoc(key)?.text ?? null;
      setText((cur) => (cur === next ? cur : next));
    }, 250);
    return () => clearInterval(t);
  }, [key]);
  return text;
}

/** Preview page: rendered Markdown, or an HTML file in a sandbox without scripts. */
export function PreviewView() {
  const { key } = useStore(previewStore);
  const doc = key ? getDoc(key) : null;
  const textObj = useDocText(key);
  const text = useMemo(() => (textObj ? textObj.toString() : ''), [textObj]);
  const kind = doc ? previewKind(doc.name) : null;
  const html = useMemo(() => (kind === 'markdown' ? renderMarkdown(text) : ''), [kind, text]);
  const ref = useRef(null);

  if (!doc || !kind) {
    return (
      <div className="tools-page">
        <div className="empty-state subtle">The document is no longer open.</div>
      </div>
    );
  }
  const onClick = (e) => {
    const a = /** @type {HTMLElement} */ (e.target).closest?.('a');
    if (!a) return;
    e.preventDefault();
    followLink(a.getAttribute('href'), doc, ref.current);
  };
  return (
    <div className="preview-page">
      <div className="preview-bar">
        <Icon name="files" size={14} /> <span>{doc.name}</span>
        <span className="subtle">{kind === 'html' ? 'HTML preview — scripts, forms and external content are disabled' : 'Markdown preview'}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn--ghost" onClick={() => showPage('editor')}>Back to editors</button>
      </div>
      {kind === 'markdown' ? (
        // eslint-disable-next-line react/no-danger -- sanitized by DOMPurify in renderMarkdown
        <article ref={ref} className="markdown-body selectable" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <iframe className="preview-frame" title={`Preview of ${doc.name}`} sandbox="" referrerPolicy="no-referrer" srcDoc={text} />
      )}
    </div>
  );
}
