import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake backend: two workspaces with their own sessions and settings.
const backend = vi.hoisted(() => {
  const trust = { level: 'restricted', capabilities: [], folders: [], needsDecision: false };
  const ws = (id, name) => ({
    record: { id, kind: 'folder', path: `C:\\code\\${name}`, name, favorite: false, group: '', createdAt: 0, lastOpenedAt: 0, openCount: 1 },
    folders: [{ name, path: `C:\\code\\${name}`, available: true }],
    file: null,
    trust,
  });
  return {
    A: ws('ws_000000000000000a', 'alpha'),
    B: ws('ws_000000000000000b', 'beta'),
    current: null,
    sessions: {},
    saved: [],
    theme: { 'ws_000000000000000a': 'pixel-dark', 'ws_000000000000000b': 'modern-dark' },
  };
});

vi.mock('../platform/ipc.js', () => ({
  isTauri: () => true,
  onEvent: () => () => {},
  events: {},
  outputAppend: vi.fn(async () => {}),
  workspaceOpenDialog: vi.fn(async () => null),
  workspaceOpenRecent: vi.fn(async (id) => {
    if (id === 'missing') throw { code: 'not_found', message: 'C:\\gone does not exist' };
    backend.current = id === backend.A.record.id ? backend.A : backend.B;
    return backend.current;
  }),
  workspaceClose: vi.fn(async () => {
    backend.current = null;
  }),
  sessionLoad: vi.fn(async () => ({ state: backend.sessions[backend.current.record.id] ?? null, recovered: false })),
  sessionSave: vi.fn(async (doc) => {
    backend.saved.push({ id: backend.current?.record.id, doc });
    backend.sessions[backend.current.record.id] = doc;
  }),
  settingsValues: vi.fn(async () => ({
    values: { 'appearance.theme': { value: backend.current ? backend.theme[backend.current.record.id] : 'modern-dark', source: 'workspace' } },
    invalid: [],
  })),
}));

const { workspaceStore, openRecent, openFolder, closeWorkspace, isCurrentEpoch } = await import('./store.js');
const { registerSessionParticipant, markSessionDirty, _resetSessionRegistry, collectSession, restoreSession } = await import('./session.js');
const { settingsStore } = await import('../core/settings.js');
const { contextStore } = await import('../core/context.js');
const { notificationStore, _resetNotifications } = await import('../core/notifications.js');
const ipc = await import('../platform/ipc.js');

describe('workspace switching', () => {
  /** A participant holding per-workspace state, like editor tabs will. */
  let notes;
  beforeEach(async () => {
    _resetSessionRegistry();
    // Re-install the sink configured by store.js (cleared by the reset above).
    const { setSessionSink } = await import('./session.js');
    setSessionSink({ canSave: () => workspaceStore.get().current !== null && !workspaceStore.get().busy, save: (d) => ipc.sessionSave(d), onError: () => {} });
    _resetNotifications();
    notes = { value: [], reset: vi.fn(), restored: [] };
    registerSessionParticipant('notes', {
      save: () => notes.value,
      restore: (d) => {
        notes.restored.push(d);
        notes.value = d ?? [];
      },
      reset: () => {
        notes.reset();
        notes.value = [];
      },
    });
    backend.sessions = { [backend.A.record.id]: { version: 1, participants: { notes: ['a1'] } } };
    backend.saved = [];
    backend.current = null;
    workspaceStore.set({ current: null, epoch: 0, busy: false, page: 'launcher', trustPrompt: false });
  });

  it('restores the opened workspace session, settings and context', async () => {
    expect(await openRecent(backend.A.record.id)).toBe(true);
    expect(workspaceStore.get().current.record.name).toBe('alpha');
    expect(workspaceStore.get().page).toBe('welcome');
    expect(notes.value).toEqual(['a1']);
    expect(settingsStore.get().values['appearance.theme'].value).toBe('pixel-dark');
    expect(contextStore.get().workspaceOpen).toBe(true);
    expect(contextStore.get().workspaceTrusted).toBe(false);
  });

  it('flushes the old session, resets participants and does not leak state into the next workspace', async () => {
    await openRecent(backend.A.record.id);
    notes.value = ['a1', 'a2'];
    const epochA = workspaceStore.get().epoch;
    await openRecent(backend.B.record.id);

    // A's latest state was saved under A before switching.
    expect(backend.saved.at(-1)).toEqual({ id: backend.A.record.id, doc: { version: 1, participants: { notes: ['a1', 'a2'] } } });
    expect(notes.reset).toHaveBeenCalled();
    expect(notes.restored.at(-1)).toBeUndefined(); // B has no session
    expect(notes.value).toEqual([]);
    expect(settingsStore.get().values['appearance.theme'].value).toBe('modern-dark');
    expect(isCurrentEpoch(epochA)).toBe(false);

    // Back to A: its state is intact.
    await openRecent(backend.A.record.id);
    expect(notes.value).toEqual(['a1', 'a2']);
  });

  it('a cancelled dialog changes nothing', async () => {
    await openRecent(backend.A.record.id);
    const before = workspaceStore.get();
    notes.reset.mockClear();
    expect(await openFolder()).toBe(false);
    expect(workspaceStore.get().current).toBe(before.current);
    expect(workspaceStore.get().epoch).toBe(before.epoch);
    expect(notes.reset).not.toHaveBeenCalled();
  });

  it('a failed open reports an error and keeps the current workspace', async () => {
    await openRecent(backend.A.record.id);
    expect(await openRecent('missing')).toBe(false);
    expect(workspaceStore.get().current.record.name).toBe('alpha');
    expect(notificationStore.get().items[0]).toMatchObject({ severity: 'error', title: 'Could not open workspace' });
    expect(workspaceStore.get().busy).toBe(false);
  });

  it('closing returns to the launcher and clears workspace context', async () => {
    await openRecent(backend.A.record.id);
    await closeWorkspace();
    expect(workspaceStore.get().current).toBeNull();
    expect(workspaceStore.get().page).toBe('launcher');
    expect(contextStore.get().workspaceOpen).toBe(false);
    expect(notes.value).toEqual([]);
  });

  it('serializes transitions', async () => {
    const first = openRecent(backend.A.record.id);
    const second = openRecent(backend.B.record.id);
    expect(await second).toBe(false);
    expect(await first).toBe(true);
    expect(workspaceStore.get().current.record.name).toBe('alpha');
  });

  it('debounced saves go to the workspace that is current', async () => {
    vi.useFakeTimers();
    try {
      await openRecent(backend.A.record.id);
      notes.value = ['x'];
      markSessionDirty();
      await vi.advanceTimersByTimeAsync(1000);
      expect(backend.saved.at(-1).id).toBe(backend.A.record.id);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('session documents', () => {
  beforeEach(() => _resetSessionRegistry());

  it('isolates failing participants and ignores unknown versions', () => {
    const good = { save: () => 1, restore: vi.fn() };
    registerSessionParticipant('good', good);
    registerSessionParticipant('bad', { save: () => { throw new Error('x'); }, restore: () => { throw new Error('y'); } });
    expect(collectSession()).toEqual({ version: 1, participants: { good: 1 } });
    restoreSession({ version: 1, participants: { good: 5 } });
    expect(good.restore).toHaveBeenLastCalledWith(5);
    restoreSession({ version: 99, participants: { good: 6 } });
    expect(good.restore).toHaveBeenLastCalledWith(undefined);
    expect(() => registerSessionParticipant('good', good)).toThrow();
  });
});
