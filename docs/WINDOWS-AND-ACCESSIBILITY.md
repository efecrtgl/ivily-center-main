# Multiple windows and accessibility

## Multiple windows

* *New Window* (Ctrl+Shift+N) opens another workbench window; the launcher's *Open in new window*
  opens a recent workspace in a new window.
* Every window has its own workspace, editors, session, file watcher, language servers, terminals,
  tasks and debug sessions. All workspace-scoped commands resolve the workspace from the calling
  window, so one window can never act on another window's files.
* **One window per workspace:** opening a workspace that is already open elsewhere brings that
  window to the front instead of opening it twice (two windows would fight over sessions, files and
  processes).
* The *main* window's workspace is the one restored at the next start; secondary windows start on
  the launcher and do not change it. Window position and size are remembered for the main window.
* Closing a secondary window releases its workspace and stops its language servers, terminals,
  debug adapters and watcher. Startup problems are reported once, in the main window.
* Secondary windows share the main window's capability (labels `w-*`): the same minimal
  permissions apply.

## Accessibility

* **Keyboard:** every command is reachable from the Command Palette (Ctrl+Shift+P / F1) and can be
  bound in the Keyboard Shortcuts editor; shortcuts use physical key positions, so they work on all
  layouts. Lists and trees (explorer, search results, problems, quick pick) are keyboard navigable;
  dialogs focus the safe option first and close with Escape.
* **Screen readers:** controls carry accessible names (an automated test renders the side-bar
  views, panels and pages and fails on any unnamed button, field, tab, option, tree item or
  unlabelled icon); status changes use `role="status"`/live regions; dialogs use
  `role="alertdialog"`; trees and tabs use their ARIA roles.
* **Visual:** visible focus outline everywhere (`:focus-visible`); Windows high-contrast mode
  (forced colors) keeps focus, selection, toggles, breakpoints and search matches visible with
  system colors; interface size is adjustable (Ctrl+= / Ctrl+-, setting *Interface font size*);
  *Reduce motion* follows Windows or can be forced on.
* **Themes:** light and dark themes; the retro and pixel themes are optional styles.

## Verification

Automated: accessible-name audit (13 tests), keyboard handling and dialogs in component tests,
one-window-per-workspace rule in Rust tests. Real app: a second window opened through the
shortcut showed the launcher with no errors in either window (inspected through the WebView2
DevTools protocol). A manual screen-reader pass (Narrator/NVDA) has not been done.
