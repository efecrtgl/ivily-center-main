# Tasks

Implementation: `src-tauri/src/tasks/` + `commands/tasks.rs`, `src/features/tasks/`.

## Sources

| Source | Tasks |
|---|---|
| `.ivily/tasks.json` | Workspace tasks (format below). *Tasks: Configure Tasks* creates the file (never overwrites) and opens it with a template as an unsaved edit. |
| `.vscode/tasks.json` | Common subset: `label`, `type` (`shell`, `process`, `npm`, `cargo`), `command`, `args`, `options.cwd`, `windows` overrides, `group`, `dependsOn`, `dependsOrder`, `problemMatcher` (names), `detail`. |
| `package.json` | One task per npm script (`npm: <name>`); names with characters other than letters, digits and `:-_.@/+` are skipped. |
| `Cargo.toml` | `cargo build`, `check`, `test`, `run`, `clippy` (with the rustc problem matcher). |

A workspace task with the same label as a detected one in the same folder replaces it. Files are
JSON with comments and trailing commas; files over 1 MB are ignored.

```jsonc
{
  "version": 1,
  "tasks": [
    { "label": "build", "command": "npm run build", "group": "build", "problemMatcher": "$tsc" },
    { "label": "lint", "type": "process", "command": "npx.cmd", "args": ["eslint", "-f", "compact", "src"], "problemMatcher": "eslint-compact" },
    { "label": "ci", "dependsOn": ["lint", "build"], "dependsOrder": "sequence" }
  ]
}
```

Variables: `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}`. Any other
`${…}` makes the task unavailable (shown with the reason) rather than running a half-substituted
command. `options.cwd` must stay inside the workspace folder.

## Safety

* Running requires the workspace trust capability **Run tasks** (`taskExecution`); in Restricted
  Mode tasks are listed but not run.
* **Approval on first run:** before a task runs for the first time, the exact command line,
  source and working directory are shown and must be approved. The approval is bound to a hash of
  the workspace, task id, command and working directory, so a changed command asks again. The
  backend re-reads the task files and enforces trust and approval itself; the UI cannot run a
  command that was not approved. *Tasks: Revoke Task Approvals* forgets them.
* Shell tasks run in PowerShell (7 when installed, else Windows PowerShell; setting
  `tasks.shell`) through `-EncodedCommand`, so no quoting is reinterpreted, and the exit code is
  propagated. With `tasks.shell = cmd`, commands containing double quotes are refused.
* Process tasks start the program directly (no shell). Every task runs in its own terminal tab
  inside a Job Object: closing the tab or *Terminate Task* ends the whole process tree.

## Running

*Run Task…*, *Run Build Task* (Ctrl+Shift+B), *Run Test Task*, *Rerun Last Task*, *Terminate
Task…*, *Show Task History* (last 30 runs with result, exit code and duration, stored as UI state).
Dependencies run first — in sequence (default; the chain stops at the first failure) or in
parallel (`"dependsOrder": "parallel"`).

## Problem matchers

`rustc`, `tsc`, `gcc`, `eslint-compact`, `eslint-stylish`, `msCompile` (a leading `$` is accepted).
Output is decoded, stripped of terminal escape sequences and matched line by line; file names are
resolved against the task's working directory and mapped to workspace files. Results feed the
Problems panel. Custom matcher objects from VS Code are ignored.
