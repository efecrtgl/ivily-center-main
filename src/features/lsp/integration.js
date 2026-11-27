// Connects the LSP manager to the editor model, trust changes and backend events.
import * as ipc from '../../platform/ipc.js';
import { allDocs, getDoc, keyForRef, onDocumentClosed, onDocumentLanguage, openDocument, setLspExtension, viewsOf } from '../editor/model.js';
import { workspaceStore } from '../../workspace/store.js';
import { registerSessionParticipant } from '../../workspace/session.js';
import { attachDocument, connectEditor, detachDocument, onServerExit, resetLsp } from './manager.js';
import { uriToRef } from './uri.js';

let installed = false;

export function installLsp() {
  if (installed) return;
  installed = true;
  const reattachAll = () => allDocs().forEach((d) => attachDocument(d));
  connectEditor({
    docText: (key) => getDoc(key)?.text ?? null,
    viewsOf,
    keyForUri: (uri) => {
      const ref = uriToRef(uri, workspaceStore.get().current?.folders ?? []);
      const key = ref ? keyForRef(ref) : null;
      return key && getDoc(key) ? key : null;
    },
    open: (ref) => openDocument(ref, { preview: false }),
    setLspExtension,
    reattachAll,
  });
  onDocumentLanguage((doc) => attachDocument(doc));
  onDocumentClosed((doc) => detachDocument(doc));
  ipc.onEvent('lsp://exit', onServerExit);
  // Trust granted later (or revoked): (re)attach open documents.
  let caps = '';
  workspaceStore.subscribe(() => {
    const next = (workspaceStore.get().current?.trust.capabilities ?? []).join(',');
    if (next !== caps) {
      const had = caps.includes('languageServers');
      caps = next;
      if (!had && next.includes('languageServers')) reattachAll();
    }
  });
  // Servers belong to a workspace: forget clients when it changes (the backend stops processes).
  registerSessionParticipant('lsp', { save: () => undefined, restore: () => {}, reset: resetLsp });
}
