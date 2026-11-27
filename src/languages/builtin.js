// Built-in language providers. Grammars are loaded lazily (separate chunks).
import { LanguageDescription } from '@codemirror/language';
import { languages as cmLanguages } from '@codemirror/language-data';
import { registerLanguage } from './registry.js';

/** Languages in @codemirror/language-data that use a full Lezer grammar. */
const LEZER = new Set([
  'C', 'C++', 'CSS', 'Go', 'HTML', 'Java', 'JavaScript', 'JSON', 'JSX', 'LESS', 'Liquid', 'Jinja', 'Markdown', 'PHP', 'Python', 'Rust', 'Sass',
  'SCSS', 'SQL', 'TSX', 'TypeScript', 'WebAssembly', 'XML', 'YAML', 'Vue', 'Angular Template', 'MySQL', 'PostgreSQL', 'SQLite', 'MS SQL', 'MariaDB SQL', 'PLSQL', 'CQL',
]);

const cm = (name) => () => {
  const d = LanguageDescription.matchLanguageName(cmLanguages, name, false);
  if (!d) return Promise.reject(new Error(`grammar '${name}' not available`));
  return d.load();
};
const basic = (name) => () => import('./basicModes.js').then((m) => m[name]);

/** The languages Ivily Center supports explicitly (others from language-data are added below). */
const BUILTIN = [
  { id: 'javascript', name: 'JavaScript', extensions: ['js', 'mjs', 'cjs'], tier: 'structure', load: cm('JavaScript') },
  { id: 'javascriptreact', name: 'JavaScript React (JSX)', extensions: ['jsx'], tier: 'structure', load: cm('JSX') },
  { id: 'typescript', name: 'TypeScript', extensions: ['ts', 'mts', 'cts', 'd.ts'], tier: 'structure', load: cm('TypeScript') },
  { id: 'typescriptreact', name: 'TypeScript React (TSX)', extensions: ['tsx'], tier: 'structure', load: cm('TSX') },
  { id: 'html', name: 'HTML', extensions: ['html', 'htm', 'xhtml'], tier: 'structure', load: cm('HTML') },
  { id: 'css', name: 'CSS', extensions: ['css'], tier: 'structure', load: cm('CSS') },
  { id: 'scss', name: 'SCSS', extensions: ['scss'], tier: 'structure', load: cm('SCSS') },
  { id: 'sass', name: 'Sass', extensions: ['sass'], tier: 'structure', load: cm('Sass') },
  { id: 'less', name: 'Less', extensions: ['less'], tier: 'structure', load: cm('LESS') },
  { id: 'json', name: 'JSON', extensions: ['json', 'webmanifest', 'map'], tier: 'structure', load: cm('JSON') },
  {
    id: 'jsonc', name: 'JSON with Comments', extensions: ['jsonc', 'json5'], tier: 'structure', note: 'JSON grammar; comments are highlighted as errors',
    filenames: ['tsconfig.json', 'jsconfig.json', '.eslintrc', '.eslintrc.json', 'settings.json', 'launch.json', 'tasks.json', 'devcontainer.json', '.babelrc'],
    load: cm('JSON'),
  },
  { id: 'vue', name: 'Vue', extensions: ['vue'], tier: 'structure', load: cm('Vue') },
  { id: 'svelte', name: 'Svelte', extensions: ['svelte'], tier: 'structure', note: 'approximate: highlighted with the HTML grammar', load: cm('HTML') },
  { id: 'markdown', name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'mkd'], tier: 'structure', load: cm('Markdown') },
  { id: 'rust', name: 'Rust', extensions: ['rs'], tier: 'structure', load: cm('Rust') },
  { id: 'c', name: 'C', extensions: ['c', 'h'], tier: 'structure', load: cm('C') },
  { id: 'cpp', name: 'C++', extensions: ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'inl', 'ipp'], tier: 'structure', load: cm('C++') },
  { id: 'csharp', name: 'C#', extensions: ['cs', 'csx'], tier: 'syntax', load: cm('C#') },
  { id: 'go', name: 'Go', extensions: ['go'], tier: 'structure', load: cm('Go') },
  { id: 'java', name: 'Java', extensions: ['java'], tier: 'structure', load: cm('Java') },
  { id: 'kotlin', name: 'Kotlin', extensions: ['kt', 'kts'], tier: 'syntax', load: cm('Kotlin') },
  { id: 'swift', name: 'Swift', extensions: ['swift'], tier: 'syntax', load: cm('Swift') },
  { id: 'zig', name: 'Zig', extensions: ['zig', 'zon'], tier: 'basic', load: basic('zig') },
  { id: 'asm', name: 'Assembly', extensions: ['s', 'asm', 'nasm', 'inc'], tier: 'syntax', note: 'GNU assembler syntax', load: cm('Gas') },
  { id: 'python', name: 'Python', extensions: ['py', 'pyw', 'pyi'], filenames: ['sconstruct', 'sconscript'], tier: 'structure', load: cm('Python') },
  { id: 'lua', name: 'Lua', extensions: ['lua'], tier: 'syntax', load: cm('Lua') },
  { id: 'php', name: 'PHP', extensions: ['php', 'phtml'], tier: 'structure', load: cm('PHP') },
  { id: 'ruby', name: 'Ruby', extensions: ['rb', 'gemspec', 'rake'], filenames: ['gemfile', 'rakefile'], tier: 'syntax', load: cm('Ruby') },
  { id: 'shellscript', name: 'Shell Script (Bash)', extensions: ['sh', 'bash', 'zsh', 'ksh'], filenames: ['.bashrc', '.zshrc', '.profile'], tier: 'syntax', load: cm('Shell') },
  { id: 'powershell', name: 'PowerShell', extensions: ['ps1', 'psm1', 'psd1'], tier: 'syntax', load: cm('PowerShell') },
  { id: 'bat', name: 'Batch', extensions: ['bat', 'cmd'], tier: 'basic', load: basic('batch') },
  { id: 'perl', name: 'Perl', extensions: ['pl', 'pm', 't'], tier: 'syntax', load: cm('Perl') },
  { id: 'yaml', name: 'YAML', extensions: ['yml', 'yaml'], tier: 'structure', load: cm('YAML') },
  { id: 'toml', name: 'TOML', extensions: ['toml'], filenames: ['cargo.lock', 'poetry.lock', 'uv.lock'], tier: 'syntax', load: cm('TOML') },
  { id: 'xml', name: 'XML', extensions: ['xml', 'xsd', 'xsl', 'xslt', 'svg', 'plist', 'csproj', 'vcxproj', 'fsproj', 'props', 'targets', 'resx', 'xaml', 'manifest', 'nuspec', 'config'], tier: 'structure', load: cm('XML') },
  { id: 'sql', name: 'SQL', extensions: ['sql'], tier: 'structure', load: cm('SQL') },
  { id: 'dockerfile', name: 'Dockerfile', extensions: ['dockerfile'], filenames: ['dockerfile', 'containerfile'], pattern: /^dockerfile\./, tier: 'syntax', load: cm('Dockerfile') },
  { id: 'terraform', name: 'Terraform / HCL', extensions: ['tf', 'tfvars', 'hcl'], tier: 'basic', load: basic('hcl') },
  { id: 'graphql', name: 'GraphQL', extensions: ['graphql', 'gql', 'graphqls'], tier: 'basic', load: basic('graphql') },
  { id: 'makefile', name: 'Makefile', extensions: ['mk', 'mak'], filenames: ['makefile', 'gnumakefile'], tier: 'basic', load: basic('makefile') },
  { id: 'ini', name: 'INI / Properties', extensions: ['ini', 'cfg', 'conf', 'properties', 'editorconfig', 'gitconfig'], filenames: ['.editorconfig', '.gitconfig', '.npmrc'], tier: 'syntax', load: cm('Properties files') },
  { id: 'dotenv', name: 'Environment File', filenames: ['.env'], pattern: /^\.env(\.|$)/, tier: 'syntax', load: cm('Properties files') },
  { id: 'cmake', name: 'CMake', extensions: ['cmake'], filenames: ['cmakelists.txt'], tier: 'syntax', load: cm('CMake') },
  { id: 'diff', name: 'Diff', extensions: ['diff', 'patch'], tier: 'syntax', load: cm('diff') },
  { id: 'ignore', name: 'Ignore File', filenames: ['.gitignore', '.dockerignore', '.npmignore', '.prettierignore', '.eslintignore'], tier: 'syntax', load: cm('Shell') },
];

let done = false;
export function registerBuiltinLanguages() {
  if (done) return;
  done = true;
  for (const p of BUILTIN) registerLanguage(/** @type {any} */ (p));
  // Everything else in language-data, with its own extensions.
  const taken = new Set(BUILTIN.flatMap((p) => p.extensions ?? []));
  for (const d of cmLanguages) {
    const id = `cm-${d.name.toLowerCase().replace(/[^a-z0-9+#]+/g, '-')}`;
    const exts = d.extensions.map((e) => e.toLowerCase()).filter((e) => !taken.has(e));
    if (!exts.length && !d.filename) continue;
    registerLanguage({
      id,
      name: d.name,
      extensions: exts,
      pattern: d.filename ? new RegExp(d.filename.source, 'i') : undefined,
      tier: LEZER.has(d.name) ? 'structure' : 'syntax',
      load: () => d.load(),
    });
  }
}
