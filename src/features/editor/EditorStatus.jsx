import { useStore } from '../../core/store.js';
import { useSetting } from '../../core/settings.js';
import { quickPick } from '../../core/quickPick.js';
import { activeEditor, cursorStore, docsStore, editorStore, setDocLanguage, setEncoding, setEol } from './model.js';
import { availableLanguages } from './languages.js';
import { languageIntelStore } from '../tools/ToolsView.jsx';
import { showPage } from '../../workspace/store.js';

export const ENCODINGS = [
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'utf-8-bom', label: 'UTF-8 with BOM' },
  { id: 'utf-16le', label: 'UTF-16 LE' },
  { id: 'utf-16be', label: 'UTF-16 BE' },
  { id: 'windows-1252', label: 'Western (Windows 1252)' },
];

export async function pickEncoding() {
  const ed = activeEditor();
  if (!ed?.doc) return;
  const item = await quickPick({ placeholder: 'Save with encoding', items: ENCODINGS, activeId: ed.doc.encoding });
  if (item) setEncoding(ed.key, item.id);
}

export async function pickEol() {
  const ed = activeEditor();
  if (!ed?.doc) return;
  const item = await quickPick({
    placeholder: 'Select end of line sequence',
    items: [
      { id: 'lf', label: 'LF', description: 'Unix, macOS, Git default' },
      { id: 'crlf', label: 'CRLF', description: 'Windows' },
    ],
    activeId: ed.doc.eol,
  });
  if (item) setEol(ed.key, item.id);
}

export async function pickLanguage() {
  const ed = activeEditor();
  if (!ed?.doc) return;
  const langs = availableLanguages();
  const item = await quickPick({
    placeholder: 'Select language mode',
    items: [{ id: '__plain', label: 'Plain Text' }, ...langs.map((l) => ({ id: l.name, label: l.name, description: l.tier }))],
    activeId: ed.doc.languageName,
  });
  if (!item) return;
  if (item.id === '__plain') return setDocLanguage(ed.key, { name: 'Plain Text', support: [] });
  const l = langs.find((x) => x.name === item.id);
  if (l) setDocLanguage(ed.key, await l.load());
}

/** Status bar items for the active editor. */
export function EditorStatus() {
  const s = useStore(editorStore);
  const key = s.groups.find((g) => g.id === s.activeGroup)?.active;
  const meta = useStore(docsStore, (d) => (key ? d[key] : null));
  const cur = useStore(cursorStore);
  const tabSize = useSetting('editor.tabSize') ?? 4;
  const spaces = useSetting('editor.insertSpaces') !== false;
  const intel = useStore(languageIntelStore, (i) => (meta?.languageId ? i[meta.languageId] : null));
  if (!meta) return null;
  const enc = ENCODINGS.find((e) => e.id === meta.encoding)?.label ?? meta.encoding;
  return (
    <>
      <span className="statusbar__item" title="Cursor position">
        Ln {cur.line}, Col {cur.col}
        {cur.selected > 0 ? ` (${cur.selected} selected)` : ''}
        {cur.selections > 1 ? ` · ${cur.selections} cursors` : ''}
      </span>
      <span className="statusbar__item" title="Indentation (change in Settings)">{spaces ? `Spaces: ${tabSize}` : `Tab Size: ${tabSize}`}</span>
      <button type="button" className="statusbar__item" title="Select encoding" onClick={pickEncoding}>{enc}</button>
      <button type="button" className="statusbar__item" title={meta.mixedEol ? 'Mixed line endings — choose one to normalize' : 'Select end of line sequence'} onClick={pickEol}>
        {meta.eol.toUpperCase()}
        {meta.mixedEol ? '*' : ''}
      </button>
      <button type="button" className="statusbar__item" title="Select language mode" onClick={pickLanguage}>{meta.languageName}</button>
      {intel && (
        <button type="button" className={`statusbar__item lsp-status lsp-status--${intel.state}`} title={`${intel.server}: ${intel.state}${intel.state === 'blocked' ? ' — trust the workspace for language servers to enable it' : ''}`} onClick={() => showPage(intel.state === 'blocked' ? 'trust' : 'tools')}>
          {intel.state === 'running' ? '{ }' : intel.state === 'starting' ? '{…}' : '{!}'}
        </button>
      )}
    </>
  );
}
