import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { useStore } from '../../core/store.js';
import { showPage } from '../../workspace/store.js';
import { getDoc } from '../editor/model.js';
import { renderMarkdown } from './markdown.js';
import { followLink, previewKind, previewStore } from './model.js';

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
