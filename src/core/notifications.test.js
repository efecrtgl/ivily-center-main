import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetNotifications, clearAll, dismiss, hideToast, markAllRead, notificationStore, notify, setNotificationPrefs,
  shouldToast, unreadCount,
} from './notifications.js';

describe('notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetNotifications();
  });
  afterEach(() => vi.useRealTimers());

  it('toast policy follows level and do-not-disturb', () => {
    expect(shouldToast('info', { level: 'info', doNotDisturb: false })).toBe(true);
    expect(shouldToast('info', { level: 'warning', doNotDisturb: false })).toBe(false);
    expect(shouldToast('error', { level: 'warning', doNotDisturb: false })).toBe(true);
    expect(shouldToast('warning', { level: 'info', doNotDisturb: true })).toBe(false);
    expect(shouldToast('error', { level: 'info', doNotDisturb: true })).toBe(true);
  });

  it('keeps suppressed notifications in the centre', () => {
    setNotificationPrefs({ doNotDisturb: true });
    notify({ title: 'quiet' });
    const [n] = notificationStore.get().items;
    expect(n.toast).toBe(false);
    expect(unreadCount(notificationStore.get())).toBe(1);
    markAllRead();
    expect(unreadCount(notificationStore.get())).toBe(0);
  });

  it('auto-hides info toasts, keeps errors sticky', () => {
    setNotificationPrefs({ timeoutSeconds: 3 });
    notify({ title: 'info' });
    notify({ severity: 'error', title: 'bad' });
    vi.advanceTimersByTime(3100);
    const items = notificationStore.get().items;
    expect(items.find((n) => n.title === 'info').toast).toBe(false);
    expect(items.find((n) => n.title === 'bad').toast).toBe(true);
    expect(items).toHaveLength(2);
  });

  it('collapses unread duplicates and counts them', () => {
    const a = notify({ title: 'same', source: 'x' });
    const b = notify({ title: 'same', source: 'x' });
    expect(a).toBe(b);
    expect(notificationStore.get().items[0].count).toBe(2);
  });

  it('limits visible toasts and supports hide / dismiss / clear', () => {
    for (let i = 0; i < 6; i++) notify({ title: `n${i}`, sticky: true });
    expect(notificationStore.get().items.filter((n) => n.toast)).toHaveLength(4);
    const id = notificationStore.get().items[0].id;
    hideToast(id);
    expect(notificationStore.get().items[0].toast).toBe(false);
    dismiss(id);
    expect(notificationStore.get().items).toHaveLength(5);
    clearAll();
    expect(notificationStore.get().items).toHaveLength(0);
  });

  it('sanitizes input', () => {
    notify({ severity: 'bogus', title: '' });
    const [n] = notificationStore.get().items;
    expect(n.severity).toBe('info');
    expect(n.title).toBe('Notification');
  });
});
