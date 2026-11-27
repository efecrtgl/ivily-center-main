import { describe, expect, it } from 'vitest';
import { languageForName, listLanguages, loadLanguage } from './registry.js';
import { registerBuiltinLanguages } from './builtin.js';

registerBuiltinLanguages();

describe('language registry', () => {
  it('covers the required languages with an honest tier', () => {
    const required = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'html', 'css', 'scss', 'sass', 'json', 'jsonc', 'vue', 'svelte',
      'markdown', 'rust', 'c', 'cpp', 'csharp', 'go', 'java', 'kotlin', 'swift', 'zig', 'asm', 'python', 'lua', 'php', 'ruby', 'shellscript',
      'powershell', 'perl', 'yaml', 'toml', 'xml', 'sql', 'dockerfile', 'terraform', 'graphql', 'makefile', 'ini'];
    const ids = new Set(listLanguages().map((l) => l.id));
    for (const id of required) expect(ids.has(id), id).toBe(true);
    for (const l of listLanguages()) expect(['structure', 'syntax', 'basic']).toContain(l.tier);
  });

  it('detects by name, compound extension and pattern', () => {
    expect(languageForName('main.rs').id).toBe('rust');
    expect(languageForName('Component.tsx').id).toBe('typescriptreact');
    expect(languageForName('types.d.ts').id).toBe('typescript');
    expect(languageForName('tsconfig.json').id).toBe('jsonc');
    expect(languageForName('Dockerfile').id).toBe('dockerfile');
    expect(languageForName('Dockerfile.prod').id).toBe('dockerfile');
    expect(languageForName('Makefile').id).toBe('makefile');
    expect(languageForName('.env.local').id).toBe('dotenv');
    expect(languageForName('build.zig').id).toBe('zig');
    expect(languageForName('main.tf').id).toBe('terraform');
    expect(languageForName('notes.unknownext')).toBeNull();
  });

  it('loads grammars lazily, including the basic modes', async () => {
    for (const name of ['a.rs', 'a.zig', 'a.graphql', 'a.tf', 'Makefile', 'a.bat', 'a.ps1', 'a.toml']) {
      const ext = await loadLanguage(languageForName(name));
      expect(ext, name).toBeTruthy();
    }
  });
});
