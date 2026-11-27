# Problems and output export

Implementation: `src/features/problems/`, `src/core/exportText.js`, `src-tauri/src/commands/export.rs`.

## Problems panel (Ctrl+Shift+M)

* Combines **language-server diagnostics** (`textDocument/publishDiagnostics`) and **task
  problems** (problem matchers, see docs/TASKS.md) in one list grouped by file; files with errors
  come first, problems are sorted by severity and position.
* Filter by text, file or code; toggle errors / warnings / infos (the toggles show the counts).
* Click or Enter opens the file at the problem; F8 / Shift+F8 go to the next / previous problem
  across the workspace (inside the editor, F8 first moves between diagnostics of that file).
* Context menu: copy the message or a `file:line:col: severity code: message` line.
* *Clear task problems* removes matcher results (language-server diagnostics belong to the
  servers and update by themselves). Task problems are reset when the task runs again.
* The status bar shows error and warning counts (click to open the panel) and the number of
  running tasks (click to stop one).

## Saving output

*Save Output As…* (Output panel toolbar or command) writes the whole selected channel to a `.log`
file chosen in a native dialog. Output is redacted for secrets when it is recorded. An existing
file is only replaced after confirmation; files are written atomically. The same backend command
(`save_text_dialog` / `save_text_confirm`) is used for other exports.
