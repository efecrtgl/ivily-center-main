# Debugging (Debug Adapter Protocol)

Implementation: `src-tauri/src/dap/` + `commands/dap.rs`, `src/features/debug/`.

## Adapters

Ivily Center is a DAP client; it does not ship or install debuggers. It detects:

| Adapter | Detected when | Launch `type` |
|---|---|---|
| debugpy | `python` on PATH can import `debugpy` (probed with `-P` from the app data folder) | `python`, `debugpy` |
| lldb-dap | `lldb-dap` / `lldb-vscode` on PATH | `lldb`, `lldb-dap` |
| netcoredbg | `netcoredbg` on PATH | `coreclr`, `netcoredbg` |

Other adapters that speak DAP over stdio can be added in the setting *Additional debug adapters*
(`debug.adapters`, one per line: `type|C:\absolute\path\adapter.exe|arguments`). *Detect again*
in the Run and Debug view refreshes detection.

## Launch configurations

`.ivily/launch.json` or `.vscode/launch.json` (JSON with comments), `configurations[]` with
`name`, `type`, `request` (`launch` / `attach`) and adapter-specific fields, which are passed to
the adapter unchanged after variable substitution. *Debug: Add Configuration* creates
`.ivily/launch.json` from a template (never overwrites). Supported variables:
`${workspaceFolder}`, `${workspaceFolderBasename}`, `${file}`, `${fileBasename}`,
`${fileBasenameNoExtension}`, `${fileDirname}`, `${fileExtname}`, `${relativeFile}`,
`${pathSeparator}`; anything else (e.g. `${env:…}`, `${input:…}`) is refused.

## Safety

* Starting requires the workspace trust capability **Debugging**.
* The first start of a configuration shows the fully substituted configuration and the adapter and
  must be approved; the approval is bound to a hash of the workspace, configuration and resolved
  values (a change asks again). *Debug: Revoke Launch Approvals* resets them.
* Adapters run with piped stdio in a Job Object (stopping, closing the window or switching the
  workspace ends the adapter and the debuggee). Reverse requests such as `runInTerminal` are
  refused, so adapters cannot start extra processes through Ivily Center; use
  `"console": "internalConsole"` (debugpy) or the adapter's equivalent.

## Using the debugger

* **Run and Debug** view (Ctrl+Shift+D): configuration picker and Start (F5); while debugging a
  toolbar (Continue F5, Pause F6, Step Over F10, Step Into F11, Step Out Shift+F11, Restart
  Ctrl+Shift+F5, Stop Shift+F5), **Variables** (expandable), **Call Stack** (select a frame to
  inspect it) and **Breakpoints**.
* **Breakpoints**: click the breakpoint gutter or press F9. They follow edits, are saved with the
  workspace session and are sent to the adapter when a session starts or when changed; breakpoints
  the adapter could not bind are shown hollow.
* The stopped line is highlighted and revealed. **Debug Console** (panel) shows program and
  adapter output and evaluates expressions in the selected frame (↑/↓ history).

## Verification status

The DAP transport was tested against a scripted Node.js adapter (real process and framing), and the
UI session flow (approval, initialize/launch/initialized, breakpoints, configurationDone, stopped,
threads, stack, scopes, variables, evaluate, continue, terminated) against a scripted adapter.
No real debug adapter was installed on the development machine, so debugging a real program has
not been exercised.
