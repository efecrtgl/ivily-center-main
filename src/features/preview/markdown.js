// Markdown → sanitized HTML for previews and notes. Raw HTML in Markdown is sanitized with
// DOMPurify (no scripts, event handlers, forms, styles or frames); links are handled by the
// caller (external links open in the browser only after validation in the backend).
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style', 'srcset'],
  ALLOW_DATA_ATTR: false,
};

/** @param {string} text */
export function renderMarkdown(text) {
  const html = marked.parse(String(text ?? ''), { gfm: true, breaks: false, async: false });
  return DOMPurify.sanitize(/** @type {string} */ (html), PURIFY);
}

/**
 * Classify a link from rendered Markdown.
 * @param {string} href
 * @returns {{ kind: 'external', url: string } | { kind: 'anchor', id: string } | { kind: 'relative', path: string, line: number | null } | { kind: 'blocked' }}
 */
export function classifyLink(href) {
  const h = String(href ?? '').trim();
  if (/^https?:\/\//i.test(h)) return { kind: 'external', url: h };
  if (h.startsWith('#')) return { kind: 'anchor', id: decodeURIComponent(h.slice(1)) };
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//') || h.startsWith('\\\\')) return { kind: 'blocked' };
  const [path, frag] = h.split('#');
  const m = /^L(\d+)/.exec(frag ?? '');
  return { kind: 'relative', path: decodeURIComponent(path), line: m ? Number(m[1]) : null };
}

/** Resolve `rel` against the folder of `base` (both workspace-relative, `/`-separated). */
export function resolveRelative(base, rel) {
  const parts = rel.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}
