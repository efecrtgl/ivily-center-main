// Preview state and link handling (shared with the notes view; the preview page itself loads lazily).
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import * as ipc from '../../platform/ipc.js';
import { showPage } from '../../workspace/store.js';
import { activeEditor, openDocument, revealInDocument } from '../editor/model.js';
import { classifyLink, resolveRelative } from './markdown.js';

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
