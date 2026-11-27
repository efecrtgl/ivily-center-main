# Git

Implementation: `src-tauri/src/git/` + `commands/git.rs` (system `git`), `src/features/git/`.

## Requirements and safety

* Uses the installed **Git for Windows** (`git` found on PATH or in Program Files), run by absolute
  path without a shell, with `GIT_TERMINAL_PROMPT=0` (Git Credential Manager can still show its own
  sign-in window) and no pager/colour. Output is parsed from machine formats only.
* **Trust:** a repository's configuration (hooks, `core.fsmonitor`, clean/smudge filters, external
  diff, `core.sshCommand`) can run programs even for read-only commands such as `git status`, and
  that configuration can arrive with a downloaded project. Git is therefore available only in
  workspaces trusted for **Use executables from workspace settings**; in Restricted Mode the Source
  Control view explains this and offers trust.
* **Never forced:** there is no force push in the code. Branch switching never uses `--force`
  (Git refuses when local changes would be overwritten).
* **Confirmations:** discarding changes, hard reset, deleting branches (a second confirmation for
  unmerged ones), dropping stashes, deleting tags, removing remotes, aborting merges/rebases,
  amending, rebasing, merging, cherry-picking and reverting all ask first.
* **Discard** restores tracked files; untracked files are moved to the **Recycle Bin**, never deleted.
* Input validation: ref names via `git check-ref-format`, commit ids, stash names, remote names and
  URLs (`ext::` and option-like values are refused), repository-relative paths (always after `--`).

## Source Control view (Ctrl+Shift+G)

* **Changes:** merge conflicts, staged and unstaged changes (untracked included) with stage /
  unstage / discard per file or all; click opens the diff (conflicted files open in the editor);
  *Add to .gitignore* for untracked files; commit message box (Ctrl+Enter) with **Amend**; *Commit
  All* when nothing is staged. In-progress merge / rebase / cherry-pick is shown with Abort /
  Continue.
* **Branch bar:** current branch (click to switch or create), Fetch, Pull (fast-forward only; Pull
  (rebase) from the context menu / command), Push (publishing a branch without upstream to
  `origin` asks first), ahead/behind counts.
* **History:** commit list with paging; expand a commit to see its files and open per-file diffs;
  context menu: copy id, create branch/tag here, cherry-pick, revert, reset (soft / mixed / hard).
* **Branches** (switch, track remote branches, merge into current, rebase onto, delete), **Stashes**
  (push with untracked files, apply, pop, drop), **Tags** (lightweight or annotated, delete),
  **Remotes** (add, remove; credentials in URLs are redacted in the UI and logs).
* Multi-root workspaces: one repository per workspace folder, selectable at the top.
* *Initialize Repository* for folders that are not repositories; *Clone Repository…* (URL, then a
  folder picker; the clone opens as the workspace in Restricted Mode until trusted).

## Diffs and conflicts

* Diff page: side-by-side (unchanged regions collapsed) or inline, previous/next change, syntax
  highlighting, *Open File*. Working tree vs index, index vs HEAD, untracked, deleted, and any
  commit vs its parent.
* Conflicts: files with conflict markers show **Accept Current / Accept Incoming / Accept Both**
  above every conflict block in the editor (two-way and diff3 markers). Nothing is resolved
  automatically; stage the file (*Mark as resolved*) when done.

## Integration

The explorer shows Git status letters (M, A, D, R, U, C) and dots on folders containing changes.
The status bar shows the branch, a `*` when there are changes and ahead/behind counts. Status
refreshes automatically on file changes (including inside `.git`). Every command run is logged to
the *Git* output channel.
