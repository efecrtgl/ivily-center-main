import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../icons/Icon.jsx';
import { FileIcon } from '../../icons/FileIcon.jsx';
import { useStore } from '../../core/store.js';
import { openContextMenu } from '../../core/contextMenu.js';
import { confirmDialog, promptDialog } from '../../core/dialogs.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import * as ipc from '../../platform/ipc.js';
import { workspaceStore } from '../../workspace/store.js';
import { openDocument } from '../editor/model.js';
import {
  activeRepo, badgeOf, checkout, commit, createBranch, deleteBranch, discard, gitStore, historyOperation, loadRepos, refreshStatus, resetTo, stage,
  stashAction, stashPush, sync, toWorkspacePath, unstage,
} from './model.js';
import { openCommitDiff, openStatusDiff } from './DiffView.jsx';

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function FileRow({ root, f, staged, onStage, onUnstage, onDiscard }) {
  const repo = activeRepo();
  const wsPath = repo ? toWorkspacePath(repo, f.path) : null;
  const letter = staged ? (f.index === '.' ? 'M' : f.index) : badgeOf(f);
  const open = () => (f.conflicted && wsPath !== null ? openDocument({ root, path: wsPath }) : openStatusDiff(root, f, staged));
  return (
    <li
      className="scm-file"
      title={f.orig ? `${f.orig} → ${f.path}` : f.path}
      onClick={open}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: 'Open Changes', run: () => openStatusDiff(root, f, staged) },
          { label: 'Open File', disabled: wsPath === null || f.worktree === 'D', run: () => openDocument({ root, path: wsPath }) },
          { separator: true },
          staged ? { label: 'Unstage', run: () => onUnstage([f]) } : { label: f.conflicted ? 'Mark as Resolved (Stage)' : 'Stage', run: () => onStage([f]) },
          ...(!staged && !f.conflicted ? [{ label: 'Discard Changes…', danger: true, run: () => onDiscard([f]) }] : []),
          ...(f.untracked ? [{ label: 'Add to .gitignore', run: () => ipc.gitIgnore(root, f.path).then(refreshStatus, (e2) => notify({ severity: 'error', title: 'Could not update .gitignore', message: errorMessage(e2), source: 'git' })) }] : []),
        ])
      }
    >
      <FileIcon name={baseName(f.path)} kind="file" size={14} />
      <span className="scm-file__name">{baseName(f.path)}</span>
      <span className="scm-file__dir subtle">{dirName(f.path)}</span>
      <span className="scm-file__actions" onClick={(e) => e.stopPropagation()}>
        {!staged && !f.conflicted && <button type="button" className="btn btn--ghost btn--icon" title="Discard changes" aria-label="Discard changes" onClick={() => onDiscard([f])}>↺</button>}
        {staged ? (
          <button type="button" className="btn btn--ghost btn--icon" title="Unstage" aria-label="Unstage" onClick={() => onUnstage([f])}>−</button>
        ) : (
          <button type="button" className="btn btn--ghost btn--icon" title={f.conflicted ? 'Mark as resolved' : 'Stage'} aria-label="Stage" onClick={() => onStage([f])}>+</button>
        )}
      </span>
      <span className={`scm-file__letter scm-letter-${letter}`}>{letter}</span>
    </li>
  );
}

function Section({ title, count, actions, children }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="scm-section">
      <div className="scm-section__head" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
        <span className="section-title">{title}</span>
        <span className="badge scm-count">{count}</span>
        <span className="scm-section__actions" onClick={(e) => e.stopPropagation()}>{actions}</span>
      </div>
      {open && <ul className="scm-list">{children}</ul>}
    </section>
  );
}

function ChangesTab({ root, st }) {
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const busy = useStore(gitStore, (s) => s.busy);
  const conflicts = st.files.filter((f) => f.conflicted);
  const staged = st.files.filter((f) => !f.conflicted && !f.untracked && f.index !== '.');
  const unstaged = st.files.filter((f) => !f.conflicted && (f.untracked || f.worktree !== '.'));
  const paths = (fs) => fs.map((f) => f.path);
  const doCommit = async () => {
    const ok = await commit(root, message, { amend, all: !staged.length && unstaged.some((f) => !f.untracked) });
    if (ok) {
      setMessage('');
      setAmend(false);
    }
  };
  const canCommit = (message.trim() || amend) && (staged.length || amend || unstaged.some((f) => !f.untracked)) && !conflicts.length;
  return (
    <>
      <div className="scm-commit">
        <textarea
          className="input scm-message"
          placeholder={`Message (Ctrl+Enter to commit on “${st.branch ?? 'HEAD'}”)`}
          aria-label="Commit message"
          value={message}
          rows={Math.min(8, Math.max(2, message.split('\n').length))}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.ctrlKey && canCommit) {
              e.preventDefault();
              doCommit();
            }
          }}
        />
        <div className="scm-commit__row">
          <label className="subtle scm-amend"><input type="checkbox" className="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> Amend</label>
          <button type="button" className="btn btn--primary" disabled={!canCommit || busy} onClick={doCommit} title={!staged.length && !amend ? 'Nothing staged: all tracked changes will be committed' : undefined}>
            <Icon name="check" size={13} /> Commit{!staged.length && !amend && unstaged.some((f) => !f.untracked) ? ' All' : ''}
          </button>
        </div>
      </div>
      {st.operation && (
        <div className="scm-operation">
          <Icon name="warning" size={13} /> A {st.operation} is in progress.
          {st.operation === 'merge' && <button type="button" className="btn btn--ghost" onClick={async () => (await confirmDialog({ title: 'Abort the merge?', message: 'The working tree returns to the state before the merge.', confirmLabel: 'Abort merge', danger: true })) && historyOperation(root, 'mergeAbort')}>Abort</button>}
          {st.operation === 'rebase' && (
            <>
              <button type="button" className="btn btn--ghost" onClick={() => historyOperation(root, 'rebaseContinue')}>Continue</button>
              <button type="button" className="btn btn--ghost" onClick={async () => (await confirmDialog({ title: 'Abort the rebase?', confirmLabel: 'Abort rebase', danger: true })) && historyOperation(root, 'rebaseAbort')}>Abort</button>
            </>
          )}
          {st.operation === 'cherry-pick' && <button type="button" className="btn btn--ghost" onClick={() => historyOperation(root, 'cherryPickAbort')}>Abort</button>}
        </div>
      )}
      {conflicts.length > 0 && (
        <Section title="Merge conflicts" count={conflicts.length}>
          {conflicts.map((f) => <FileRow key={`c${f.path}`} root={root} f={f} staged={false} onStage={(fs) => stage(root, paths(fs))} onUnstage={() => {}} onDiscard={() => {}} />)}
        </Section>
      )}
      {staged.length > 0 && (
        <Section title="Staged changes" count={staged.length} actions={<button type="button" className="btn btn--ghost btn--icon" title="Unstage all" aria-label="Unstage all" onClick={() => unstage(root, paths(staged))}>−</button>}>
          {staged.map((f) => <FileRow key={`s${f.path}`} root={root} f={f} staged onStage={() => {}} onUnstage={(fs) => unstage(root, paths(fs))} onDiscard={() => {}} />)}
        </Section>
      )}
      <Section
        title="Changes"
        count={unstaged.length}
        actions={
          <>
            <button type="button" className="btn btn--ghost btn--icon" title="Discard all changes…" aria-label="Discard all changes" disabled={!unstaged.length} onClick={() => discard(root, unstaged)}>↺</button>
            <button type="button" className="btn btn--ghost btn--icon" title="Stage all" aria-label="Stage all" disabled={!unstaged.length} onClick={() => stage(root, paths(unstaged))}>+</button>
          </>
        }
      >
        {unstaged.length === 0 && <li className="subtle scm-empty">No changes.</li>}
        {unstaged.map((f) => <FileRow key={`u${f.path}`} root={root} f={f} staged={false} onStage={(fs) => stage(root, paths(fs))} onUnstage={() => {}} onDiscard={(fs) => discard(root, fs)} />)}
      </Section>
    </>
  );
}

function HistoryTab({ root }) {
  const [commits, setCommits] = useState([]);
  const [open, setOpen] = useState(null);
  const [files, setFiles] = useState([]);
  const [done, setDone] = useState(false);
  const status = useStore(gitStore, (s) => s.status[root]);
  const load = async (reset) => {
    const skip = reset ? 0 : commits.length;
    const page = await ipc.gitLog(root, null, null, skip, 100).catch(() => []);
    setCommits(reset ? page : [...commits, ...page]);
    setDone(page.length < 100);
  };
  useEffect(() => {
    load(true);
  }, [root, status?.head]);
  const expand = async (c) => {
    if (open === c.sha) return setOpen(null);
    setOpen(c.sha);
    setFiles(await ipc.gitCommitFiles(root, c.sha).catch(() => []));
  };
  return (
    <ul className="scm-list scm-history">
      {commits.map((c) => (
        <li key={c.sha}>
          <div
            className="scm-commit-row"
            onClick={() => expand(c)}
            onContextMenu={(e) =>
              openContextMenu(e, [
                { label: 'Copy Commit Id', run: () => navigator.clipboard?.writeText(c.sha) },
                { label: 'Create Branch Here…', run: async () => { const n = await promptDialog({ title: 'Branch name', confirmLabel: 'Create' }); if (n) ipc.gitBranchCreate(root, n, c.sha, false).then(refreshStatus, (err) => notify({ severity: 'error', title: 'Could not create branch', message: errorMessage(err), source: 'git' })); } },
                { label: 'Create Tag Here…', run: async () => { const n = await promptDialog({ title: 'Tag name', confirmLabel: 'Create' }); if (n) ipc.gitTag(root, 'create', n, null, c.sha).then(refreshStatus, (err) => notify({ severity: 'error', title: 'Could not create tag', message: errorMessage(err), source: 'git' })); } },
                { separator: true },
                { label: 'Cherry-pick…', run: () => historyOperation(root, 'cherryPick', c.sha) },
                { label: 'Revert…', run: () => historyOperation(root, 'revert', c.sha) },
                { label: 'Reset Current Branch to Here…', danger: true, run: () => resetTo(root, c.sha) },
              ])
            }
          >
            <span className="scm-commit-row__subject">{c.subject}</span>
            {c.refs && <span className="launcher__chip launcher__chip--accent">{c.refs.split(',')[0]}</span>}
            <span className="subtle scm-commit-row__meta">{c.short} · {c.author} · {new Date(c.time * 1000).toLocaleDateString()}</span>
          </div>
          {open === c.sha && (
            <ul className="scm-list scm-commit-files">
              {files.map((f) => (
                <li key={f.path} className="scm-file" onClick={() => openCommitDiff(root, c.sha, f)}>
                  <FileIcon name={baseName(f.path)} kind="file" size={14} />
                  <span className="scm-file__name">{baseName(f.path)}</span>
                  <span className="scm-file__dir subtle">{dirName(f.path)}</span>
                  <span className={`scm-file__letter scm-letter-${f.status}`}>{f.status}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
      {!done && commits.length > 0 && <li><button type="button" className="btn btn--ghost" onClick={() => load(false)}>Load more…</button></li>}
      {commits.length === 0 && <li className="subtle scm-empty">No commits yet.</li>}
    </ul>
  );
}

function ListTab({ root, kind }) {
  const [items, setItems] = useState(null);
  const status = useStore(gitStore, (s) => s.status[root]);
  const reload = async () => {
    const fns = { branches: ipc.gitBranches, stashes: ipc.gitStashes, tags: ipc.gitTags, remotes: ipc.gitRemotes };
    setItems(await fns[kind](root).catch(() => []));
  };
  useEffect(() => {
    reload();
  }, [root, kind, status?.head, status?.branch]);
  if (!items) return <div className="subtle scm-empty">Loading…</div>;
  const header = {
    branches: <button type="button" className="btn btn--ghost" onClick={() => createBranch(root).then(reload)}>+ New branch</button>,
    stashes: <button type="button" className="btn btn--ghost" onClick={() => stashPush(root).then(reload)}>+ Stash changes</button>,
    tags: <button type="button" className="btn btn--ghost" onClick={async () => { const n = await promptDialog({ title: 'Tag name', placeholder: 'v1.0.0', confirmLabel: 'Create' }); if (n) { const m = await promptDialog({ title: 'Tag message (optional, creates an annotated tag)', value: '', confirmLabel: 'Create tag' }).catch(() => null); await ipc.gitTag(root, 'create', n, m, null).catch((e) => notify({ severity: 'error', title: 'Could not create tag', message: errorMessage(e), source: 'git' })); reload(); } }}>+ New tag</button>,
    remotes: <button type="button" className="btn btn--ghost" onClick={async () => { const n = await promptDialog({ title: 'Remote name', value: 'origin', confirmLabel: 'Next' }); if (!n) return; const u = await promptDialog({ title: `URL for “${n}”`, placeholder: 'https://github.com/owner/repo.git', confirmLabel: 'Add remote' }); if (u) { await ipc.gitRemote(root, 'add', n, u).catch((e) => notify({ severity: 'error', title: 'Could not add remote', message: errorMessage(e), source: 'git' })); reload(); } }}>+ Add remote</button>,
  }[kind];
  return (
    <div>
      <div className="scm-tab-actions">{header}</div>
      <ul className="scm-list">
        {items.length === 0 && <li className="subtle scm-empty">None.</li>}
        {kind === 'branches' && items.map((b) => (
          <li key={`${b.remote}${b.name}`} className="scm-file" onContextMenu={(e) => openContextMenu(e, [
            { label: 'Switch to Branch', disabled: b.current, run: () => ipc.gitSwitch(root, b.name, b.remote).then(refreshStatus, (err) => notify({ severity: 'error', title: 'Could not switch branch', message: errorMessage(err), source: 'git' })) },
            { label: 'Merge into Current Branch…', disabled: b.current, run: () => historyOperation(root, 'merge', b.name) },
            { label: 'Rebase Current Branch onto This…', disabled: b.current, run: () => historyOperation(root, 'rebase', b.name) },
            { separator: true },
            { label: 'Delete Branch…', danger: true, disabled: b.current || b.remote, run: () => deleteBranch(root, b.name).then(reload) },
          ])} onDoubleClick={() => !b.current && ipc.gitSwitch(root, b.name, b.remote).then(refreshStatus, (err) => notify({ severity: 'error', title: 'Could not switch branch', message: errorMessage(err), source: 'git' }))}>
            <Icon name="git" size={13} />
            <span className="scm-file__name">{b.name}</span>
            <span className="scm-file__dir subtle">{b.remote ? 'remote' : b.track || b.upstream || ''}</span>
            {b.current && <span className="launcher__chip launcher__chip--accent">current</span>}
          </li>
        ))}
        {kind === 'stashes' && items.map((s) => (
          <li key={s.name} className="scm-file" onContextMenu={(e) => openContextMenu(e, [
            { label: 'Apply', run: () => stashAction(root, s.name, 'apply').then(reload) },
            { label: 'Pop', run: () => stashAction(root, s.name, 'pop').then(reload) },
            { label: 'Drop…', danger: true, run: () => stashAction(root, s.name, 'drop').then(reload) },
          ])}>
            <span className="scm-file__name">{s.message}</span>
            <span className="scm-file__dir subtle">{s.name}</span>
            <button type="button" className="btn btn--ghost" onClick={() => stashAction(root, s.name, 'pop').then(reload)}>Pop</button>
          </li>
        ))}
        {kind === 'tags' && items.map((t) => (
          <li key={t.name} className="scm-file" onContextMenu={(e) => openContextMenu(e, [{ label: 'Delete Tag…', danger: true, run: async () => { if (await confirmDialog({ title: `Delete tag “${t.name}”?`, message: 'Only the local tag is deleted.', confirmLabel: 'Delete', danger: true })) { await ipc.gitTag(root, 'delete', t.name, null, null).catch(() => {}); reload(); } } }])}>
            <span className="scm-file__name">{t.name}</span>
            <span className="scm-file__dir subtle">{t.commit} {t.subject}</span>
          </li>
        ))}
        {kind === 'remotes' && items.map((r) => (
          <li key={r.name} className="scm-file" onContextMenu={(e) => openContextMenu(e, [{ label: 'Remove Remote…', danger: true, run: async () => { if (await confirmDialog({ title: `Remove remote “${r.name}”?`, message: 'Its remote-tracking branches are removed locally. Nothing changes on the server.', confirmLabel: 'Remove', danger: true })) { await ipc.gitRemote(root, 'remove', r.name, null).catch(() => {}); reload(); } } }])}>
            <span className="scm-file__name">{r.name}</span>
            <span className="scm-file__dir subtle mono">{r.fetch}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const TABS = [['changes', 'Changes'], ['history', 'History'], ['branches', 'Branches'], ['stashes', 'Stashes'], ['tags', 'Tags'], ['remotes', 'Remotes']];

/** Source Control sidebar view. */
export function ScmView() {
  const g = useStore(gitStore);
  const ws = useStore(workspaceStore, (s) => s.current);
  const [tab, setTab] = useState('changes');
  const repo = useMemo(() => g.repos.find((r) => r.root === g.activeRoot && r.top) ?? g.repos.find((r) => r.top), [g.repos, g.activeRoot]);
  const st = repo ? g.status[repo.root] : null;

  useEffect(() => {
    if (g.state === 'idle') loadRepos();
  }, [g.state, ws?.record.id]);

  if (!ws) return <div className="empty-state">Open a folder to use source control.</div>;
  if (g.state === 'blocked') {
    return (
      <div className="empty-state">
        <Icon name="shield" size={26} />
        <div>Git is disabled in Restricted Mode</div>
        <div className="subtle">A repository's configuration can run programs (hooks, filters, fsmonitor). Trust this workspace to use Git.</div>
        <button type="button" className="btn btn--primary" onClick={() => workspaceStore.set((s) => ({ ...s, trustPrompt: true }))}>Trust…</button>
      </div>
    );
  }
  if (g.state === 'missing') return <div className="empty-state"><div>Git is not installed.</div><div className="subtle">{g.message}</div></div>;
  if (g.state === 'error') return <div className="empty-state"><div className="sev-error">{g.message}</div><button type="button" className="btn" onClick={loadRepos}>Retry</button></div>;
  if (g.state === 'loading' && !g.repos.length) return <div className="empty-state">Loading…</div>;
  if (!repo) {
    return (
      <div className="empty-state">
        <div>This folder is not a Git repository.</div>
        <button type="button" className="btn btn--primary" onClick={async () => { if (await confirmDialog({ title: 'Initialize a Git repository?', message: `A .git folder is created in ${ws.folders[0].path}.`, confirmLabel: 'Initialize' })) { await ipc.gitInit(0).catch((e) => notify({ severity: 'error', title: 'git init failed', message: errorMessage(e), source: 'git' })); loadRepos(); } }}>Initialize Repository</button>
      </div>
    );
  }

  return (
    <div className="scm">
      <div className="scm-head">
        {g.repos.filter((r) => r.top).length > 1 && (
          <select className="select" aria-label="Repository" value={repo.root} onChange={(e) => gitStore.set((s) => ({ ...s, activeRoot: Number(e.target.value) }))}>
            {g.repos.filter((r) => r.top).map((r) => <option key={r.root} value={r.root}>{ws.folders[r.root]?.name}</option>)}
          </select>
        )}
        <button type="button" className="btn btn--ghost scm-branch" onClick={() => checkout(repo.root)} title="Switch branch">
          <Icon name="git" size={13} /> {st?.branch ?? (st?.detached ? `detached ${st.head?.slice(0, 8)}` : '…')}
        </button>
        <span className="scm-sync">
          <button type="button" className="btn btn--ghost btn--icon" title="Fetch" aria-label="Fetch" onClick={() => sync(repo.root, 'fetch')}><Icon name="refresh" size={13} /></button>
          <button type="button" className="btn btn--ghost" title="Pull (fast-forward only)" onClick={() => sync(repo.root, 'pull')} onContextMenu={(e) => openContextMenu(e, [{ label: 'Pull (rebase)', run: () => sync(repo.root, 'pullRebase') }])}>↓{st?.behind ? ` ${st.behind}` : ''}</button>
          <button type="button" className="btn btn--ghost" title={st?.upstream ? 'Push' : 'Publish branch'} onClick={() => sync(repo.root, 'push')}>↑{st?.ahead ? ` ${st.ahead}` : ''}</button>
        </span>
      </div>
      <div className="scm-tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`scm-tab${tab === id ? ' scm-tab--active' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div className="scm-body">
        {tab === 'changes' && st && <ChangesTab root={repo.root} st={st} />}
        {tab === 'history' && <HistoryTab root={repo.root} />}
        {['branches', 'stashes', 'tags', 'remotes'].includes(tab) && <ListTab root={repo.root} kind={tab} />}
      </div>
    </div>
  );
}
