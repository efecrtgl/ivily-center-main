# Language servers (LSP)

Implementation: `src-tauri/src/lsp/` and `commands/lsp.rs` (processes, framing),
`src/features/lsp/` (client, workspace adapter, integration), `@codemirror/lsp-client`.

## What you get

With a server installed and the workspace trusted for language servers:

| Feature | Shortcut / command |
|---|---|
| Completion | while typing, Ctrl+Space |
| Hover documentation | mouse hover |
| Signature help | while typing arguments, Ctrl+Shift+Space |
| Diagnostics | inline (wavy underline + gutter), and recorded for the Problems panel |
| Go to definition / type definition / implementation | F12, *Go to Type Definition*, *Go to Implementation* |
| Find references | Shift+F12 (reference panel) |
| Rename symbol | F2 (in the editor) |
| Format document | Shift+Alt+F |

Which features work depends on the server's capabilities.

## Supported servers

Ivily Center knows these servers and looks for them on `PATH` (it never installs them):
rust-analyzer, typescript-language-server, Pyright (or basedpyright), python-lsp-server, gopls,
clangd, vscode-html/css/json-language-server, yaml-language-server, bash-language-server,
lua-language-server, zls, taplo, marksman, csharp-ls, Intelephense, Solargraph,
dockerfile-language-server, terraform-ls, kotlin-language-server, svelte-language-server,
vue-language-server. **Languages & Tools → Language Servers** shows which are installed and the
exact install command to run yourself.

## Settings

| Setting | Scope | Meaning |
|---|---|---|
| `lsp.enabled` | user, workspace | Master switch |
| `lsp.disabledServers` | user, workspace | Server ids not to start |
| `lsp.serverPaths` | **user only** | `id=C:\full\path\server.exe` overrides (must be absolute, existing files) |
| `lsp.trace` | user | Log incoming messages (truncated) to the *Language Servers* output channel |

## Security and lifecycle

* Server executables and arguments come from a fixed table in the backend; the UI only passes a
  server id. Workspaces cannot configure server commands (only the user can, in user settings).
* Starting a server requires the **`languageServers`** trust capability, because servers execute
  workspace content (build scripts, `node_modules`, procedural macros). In Restricted Mode the
  status bar shows `{!}` and links to Workspace Trust; granting trust attaches servers immediately.
* Each server runs in its own Windows Job Object: stopping it, switching workspaces, or Ivily
  Center exiting (even by crash) terminates it **and all processes it started**.
* stderr goes to the *Language Servers* output channel (with secret redaction). A server that
  crashes three times within three minutes is not restarted automatically (*Restart Language
  Servers* command).
* Hover documentation HTML is sanitized with DOMPurify.

## Document synchronisation

Documents are opened on the server when the editor opens them and closed when their last tab
closes — not on every tab switch. Changes are sent incrementally (one minimal range per sync;
documents under 1 KB are sent in full by the client). Large-file mode disables LSP for that file.
Navigation to other files opens them in Ivily Center's editor; edits from the server (rename,
formatting) are applied through the editor.
