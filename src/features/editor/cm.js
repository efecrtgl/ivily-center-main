// CodeMirror 6 configuration: extensions, compartments and the theme adapter.
//
// The editor theme and syntax colours reference theme tokens as CSS variables
// (`var(--editor-bg)`, `var(--syntax-keyword)`, …), so switching Ivily themes restyles open
// editors without reconfiguration. Everything that changes at runtime lives in a Compartment.
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightActiveLine, highlightWhitespace, highlightTrailingWhitespace,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  indentOnInput, syntaxHighlighting, bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentUnit,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';

export const compartments = {
  language: new Compartment(),
  tabs: new Compartment(),
  wrap: new Compartment(),
  whitespace: new Compartment(),
  readOnly: new Compartment(),
  gutter: new Compartment(),
  features: new Compartment(),
  font: new Compartment(),
  extra: new Compartment(),
  lsp: new Compartment(),
};

export const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: 'var(--syntax-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syntax-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--syntax-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syntax-function)' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName), t.tagName], color: 'var(--syntax-type)' },
  { tag: [t.variableName, t.propertyName, t.attributeName, t.labelName], color: 'var(--syntax-variable)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.angleBracket], color: 'var(--syntax-operator)' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--syntax-variable)', fontWeight: '500' },
  { tag: [t.heading], color: 'var(--syntax-keyword)', fontWeight: '700' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '700' },
  { tag: [t.link, t.url], color: 'var(--syntax-function)', textDecoration: 'underline' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: 'var(--syntax-type)' },
  { tag: [t.invalid], color: 'var(--color-danger)' },
  { tag: [t.inserted], color: 'var(--color-success)' },
  { tag: [t.deleted], color: 'var(--color-danger)' },
]);

/** Theme built from Ivily tokens. `dark` only affects CodeMirror's built-in defaults. */
export function editorTheme(dark) {
  return EditorView.theme(
    {
      '&': { color: 'var(--editor-fg)', backgroundColor: 'var(--editor-bg)', height: '100%' },
      '.cm-scroller': { fontFamily: 'var(--editor-font, var(--font-mono))', lineHeight: 'var(--editor-line-height, 1.5)' },
      '.cm-content': { caretColor: 'var(--editor-cursor)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--editor-cursor)', borderLeftWidth: '2px' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--editor-selection) !important' },
      '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--editor-lineHighlight) 60%, transparent)' },
      '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--editor-gutter-fg)', border: 'none' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--editor-fg)' },
      '.cm-foldPlaceholder': { backgroundColor: 'var(--color-surface-active)', border: 'none', color: 'var(--color-fg-muted)' },
      '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--color-accent) 18%, transparent)' },
      '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--color-accent) 28%, transparent)', outline: '1px solid color-mix(in srgb, var(--color-accent) 60%, transparent)' },
      '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--color-warning) 30%, transparent)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--color-warning) 55%, transparent)' },
      '.cm-panels': { backgroundColor: 'var(--color-bg-elevated)', color: 'var(--color-fg)', borderColor: 'var(--color-border)' },
      '.cm-panel input, .cm-panel button, .cm-textfield': { fontFamily: 'var(--font-ui)', fontSize: '0.92em' },
      '.cm-tooltip': { backgroundColor: 'var(--color-bg-elevated)', color: 'var(--color-fg)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--color-accent-muted)', color: 'var(--color-fg)' },
      '.cm-highlightSpace': { backgroundImage: 'radial-gradient(circle at 50% 55%, var(--editor-gutter-fg) 15%, transparent 5%)' },
      '.cm-trailingSpace': { backgroundColor: 'color-mix(in srgb, var(--color-danger) 25%, transparent)' },
      '.cm-diagnostic-error': { borderLeftColor: 'var(--color-danger)' },
      '.cm-diagnostic-warning': { borderLeftColor: 'var(--color-warning)' },
      '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--color-danger)', textUnderlineOffset: '3px' },
      '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--color-warning)', textUnderlineOffset: '3px' },
    },
    { dark },
  );
}

/**
 * @typedef {{ tabSize: number, insertSpaces: boolean, wordWrap: boolean, whitespace: 'none' | 'trailing' | 'all',
 *             lineNumbers: boolean, readOnly: boolean, large: boolean, dark: boolean }} EditorOptions
 */

export const tabsExt = (o) => [EditorState.tabSize.of(o.tabSize), indentUnit.of(o.insertSpaces ? ' '.repeat(o.tabSize) : '\t')];
export const wrapExt = (o) => (o.wordWrap ? EditorView.lineWrapping : []);
export const whitespaceExt = (o) => (o.whitespace === 'all' ? [highlightWhitespace(), highlightTrailingWhitespace()] : o.whitespace === 'trailing' ? highlightTrailingWhitespace() : []);
export const readOnlyExt = (o) => [EditorState.readOnly.of(o.readOnly), EditorView.editable.of(!o.readOnly)];
export const gutterExt = (o) => (o.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []);

/** Features that are disabled in large-file mode. */
export const featuresExt = (o) =>
  o.large
    ? []
    : [
        foldGutter({ markerDOM: (open) => Object.assign(document.createElement('span'), { className: 'cm-fold-marker', textContent: open ? '⌄' : '›' }) }),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: true }),
        highlightSelectionMatches(),
        indentOnInput(),
        syntaxHighlighting(highlightStyle, { fallback: true }),
      ];

/**
 * All extensions for a document state.
 * @param {EditorOptions} o
 * @param {import('@codemirror/state').Extension} language
 * @param {import('@codemirror/state').Extension[]} extra
 * @param {import('@codemirror/state').Extension} [lsp]
 */
export function buildExtensions(o, language, extra = [], lsp = []) {
  return [
    compartments.gutter.of(gutterExt(o)),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    search({ top: true }),
    compartments.features.of(featuresExt(o)),
    compartments.language.of(o.large ? [] : language),
    compartments.tabs.of(tabsExt(o)),
    compartments.wrap.of(wrapExt(o)),
    compartments.whitespace.of(whitespaceExt(o)),
    compartments.readOnly.of(readOnlyExt(o)),
    compartments.font.of(editorTheme(o.dark)),
    compartments.extra.of(extra),
    compartments.lsp.of(o.large ? [] : lsp),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
  ];
}
