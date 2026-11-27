import { describe, expect, it } from 'vitest';
import { groupByCategory, loadSettings, resetSetting, searchSettings, setSetting, settingsStore } from './settings.js';

const schema = [
  {
    key: 'appearance.theme', title: 'Theme', description: 'Colour theme', category: 'Appearance', type: 'enum',
    options: [{ value: 'pixel-dark', label: 'Pixel Dark' }], default: 'modern-dark', scopes: ['user'],
  },
  {
    key: 'appearance.uiFontSize', title: 'Interface font size', description: 'Base size', category: 'Appearance',
    type: 'integer', min: 10, max: 20, default: 13, scopes: ['user'],
  },
  {
    key: 'notifications.doNotDisturb', title: 'Do not disturb', description: 'Suppress pop-ups',
    category: 'Notifications', type: 'boolean', default: false, scopes: ['user'],
  },
];

describe('settings client', () => {
  it('searches across key, title, description, category and option labels', () => {
    expect(searchSettings(schema, 'theme').map((s) => s.key)).toEqual(['appearance.theme']);
    expect(searchSettings(schema, 'pixel').map((s) => s.key)).toEqual(['appearance.theme']);
    expect(searchSettings(schema, 'appearance size').map((s) => s.key)).toEqual(['appearance.uiFontSize']);
    expect(searchSettings(schema, '')).toHaveLength(3);
    expect(searchSettings(schema, 'nothing-matches')).toHaveLength(0);
  });

  it('filters @modified', () => {
    const values = { 'appearance.theme': { value: 'pixel-dark', source: 'user' } };
    expect(searchSettings(schema, '@modified', values).map((s) => s.key)).toEqual(['appearance.theme']);
  });

  it('groups by category in schema order', () => {
    expect(groupByCategory(schema).map((g) => [g.category, g.items.length])).toEqual([
      ['Appearance', 2],
      ['Notifications', 1],
    ]);
  });

  it('works offline with schema defaults (tests / browser preview)', async () => {
    await loadSettings(schema);
    expect(settingsStore.get().values['appearance.uiFontSize']).toEqual({ value: 13, source: 'default' });
    await setSetting('appearance.uiFontSize', 15);
    expect(settingsStore.get().values['appearance.uiFontSize']).toEqual({ value: 15, source: 'user' });
    await resetSetting('appearance.uiFontSize');
    expect(settingsStore.get().values['appearance.uiFontSize'].source).toBe('default');
  });
});
