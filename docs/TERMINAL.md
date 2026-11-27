# Integrated terminal

Implementation: `src-tauri/src/terminal/` + `commands/terminal.rs` (ConPTY via `portable-pty`),
`src/features/terminal/` (xterm.js).

## Profiles

Detected automatically: **PowerShell 7** (`pwsh`), **Windows PowerShell**, **Command Prompt**,
**Git Bash** (the Git for Windows `bash.exe`; `System32\bash.exe`, the WSL launcher, is never used)
and every **WSL distribution** (`wsl -l -q`). Custom profiles are a **user** setting
(`terminal.profiles`, one `Name|C:\full\path\shell.exe|arguments` per line). Workspaces cannot
define profiles. `terminal.defaultProfile` picks the default (else PowerShell 7, then Windows
PowerShell).

## Behaviour

* **Real terminal:** each tab runs a shell in a Windows pseudo console (ConPTY) — full VT
  sequences, colours, cursor addressing, resize, interactive programs.
* **Starts only on request:** *New Terminal* (Ctrl+Shift+`), *Toggle Terminal* (Ctrl+`, creates one
  if none exists), the panel's buttons, or *Install in terminal…* on the Tools page (after a
  confirmation that shows the exact command, source and scope). Opening a workspace never starts a
  shell, and terminals are not restarted automatically.
* **Working directory:** the first workspace folder (the user's home without a workspace).
* **Tabs and splits:** each tab holds one or two side-by-side terminals; rename (double-click),
  clear, kill from the tab context menu.
* **Clipboard:** Ctrl+C copies when text is selected, otherwise sends ^C; Ctrl+V pastes (bracketed
  paste); Ctrl+Shift+C/V always copy/paste; optional copy-on-select.
* **Search:** Ctrl+Shift+F in a terminal (incremental, Enter / Shift+Enter).
* **Links:** http(s) links open in the default browser (validated by the backend, no shell).
* **Shortcuts:** Ctrl+letter goes to the shell; other workbench shortcuts (Ctrl+`, Ctrl+Shift+…,
  Ctrl+Tab, …) are handled by Ivily Center.
* **Theme:** colours (including the 16 ANSI colours) come from the active theme's `terminal.*`
  tokens and update live; font family/size, cursor style and scrollback are settings.

## Process lifecycle

Each shell runs in a Windows Job Object: killing the terminal, switching workspaces, closing the
window or Ivily Center exiting (even by crash) terminates the shell and **every process started
from it**. Terminal sessions are not restored after a restart (starting programs must remain an
explicit action).
