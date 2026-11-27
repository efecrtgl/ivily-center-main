import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App.jsx';
import { layoutStore, updateLayout } from '../core/layout.js';
import { settingsStore } from '../core/settings.js';
import { themeStore } from '../theme/engine.js';
import { executeCommand } from '../core/commands.js';

describe('App (outside Tauri)', () => {
  it('renders the workbench shell with title bar, views and status bar', async () => {
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.getByText('No folder open', { selector: '.titlebar__title' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Explorer' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Ivily Center' })).toBeTruthy();
    expect(screen.getByRole('contentinfo', { name: 'Status bar' })).toBeTruthy();
  });

  it('keyboard shortcuts run commands (Ctrl+J toggles the panel)', async () => {
    const before = layoutStore.get().panelVisible;
    await act(async () => {
      fireEvent.keyDown(window, { code: 'KeyJ', key: 'j', ctrlKey: true });
    });
    expect(layoutStore.get().panelVisible).toBe(!before);
    await act(async () => {
      fireEvent.keyDown(window, { code: 'KeyJ', key: 'j', ctrlKey: true });
    });
  });

  it('switching themes changes the visual system but keeps layout and other state', async () => {
    await act(async () => {
      updateLayout({ sidebarView: 'settings', sidebarVisible: true, sidebarWidth: 333 });
    });
    const layoutBefore = layoutStore.get();
    await act(async () => {
      await executeCommand('preferences.theme.pixel-dark');
    });
    expect(settingsStore.get().values['appearance.theme']?.value ?? themeStore.get().current.id).toBe('pixel-dark');
    expect(document.documentElement.dataset.style).toBe('pixel');
    expect(document.documentElement.dataset.iconPack).toBe('pixel');
    await act(async () => {
      await executeCommand('preferences.theme.retro-terminal');
    });
    expect(document.documentElement.dataset.style).toBe('retro');
    expect(layoutStore.get()).toEqual(layoutBefore);
  });
});
