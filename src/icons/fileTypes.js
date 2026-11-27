// File and folder type registry for icons (and later language detection hints).
//
// Resolution order for files: exact file name → compound extension (`.d.ts`, `.test.js`) →
// extension → generic. Folders: special names (src, .git, node_modules, …) → generic.
// Icon packs draw the shape; the type supplies a short badge and a colour. Extensions (Phase 16)
// can register more types through `registerFileTypes`.

/** @typedef {{ id: string, label: string, color: string, category: string, extensions?: string[], names?: string[] }} FileType */

/** @type {FileType[]} */
const BUILTIN = [
  // Web & JavaScript ecosystem
  { id: 'javascript', label: 'JS', color: '#e8c33a', category: 'code', extensions: ['js', 'mjs', 'cjs'] },
  { id: 'jsx', label: 'JSX', color: '#5ccfe6', category: 'code', extensions: ['jsx'] },
  { id: 'typescript', label: 'TS', color: '#3b82d6', category: 'code', extensions: ['ts', 'mts', 'cts'] },
  { id: 'tsx', label: 'TSX', color: '#3b9bd6', category: 'code', extensions: ['tsx'] },
  { id: 'typescript-def', label: 'D.TS', color: '#2f6fb3', category: 'code', extensions: ['d.ts'] },
  { id: 'test', label: 'TEST', color: '#e5596b', category: 'code', extensions: ['test.js', 'test.ts', 'test.jsx', 'test.tsx', 'spec.js', 'spec.ts', 'spec.tsx'] },
  { id: 'html', label: 'HTML', color: '#e8663d', category: 'code', extensions: ['html', 'htm', 'xhtml'] },
  { id: 'css', label: 'CSS', color: '#4a8fe7', category: 'code', extensions: ['css'] },
  { id: 'scss', label: 'SCSS', color: '#d6609b', category: 'code', extensions: ['scss'] },
  { id: 'sass', label: 'SASS', color: '#d6609b', category: 'code', extensions: ['sass'] },
  { id: 'less', label: 'LESS', color: '#3b5c99', category: 'code', extensions: ['less'] },
  { id: 'vue', label: 'VUE', color: '#42b883', category: 'code', extensions: ['vue'] },
  { id: 'svelte', label: 'SV', color: '#ff3e00', category: 'code', extensions: ['svelte'] },
  { id: 'astro', label: 'AST', color: '#ff7a3d', category: 'code', extensions: ['astro'] },
  { id: 'json', label: '{ }', color: '#d4a72c', category: 'data', extensions: ['json', 'jsonc', 'json5', 'webmanifest'] },
  { id: 'graphql', label: 'GQL', color: '#e535ab', category: 'code', extensions: ['graphql', 'gql'] },
  // Systems & general purpose
  { id: 'rust', label: 'RS', color: '#de7a4a', category: 'code', extensions: ['rs'] },
  { id: 'c', label: 'C', color: '#5b8bd6', category: 'code', extensions: ['c'] },
  { id: 'cpp', label: 'C++', color: '#3f7fd0', category: 'code', extensions: ['cpp', 'cc', 'cxx', 'c++'] },
  { id: 'c-header', label: 'H', color: '#8b6fd6', category: 'code', extensions: ['h', 'hpp', 'hh', 'hxx', 'inl'] },
  { id: 'csharp', label: 'C#', color: '#9b4fd0', category: 'code', extensions: ['cs', 'csx'] },
  { id: 'fsharp', label: 'F#', color: '#378bba', category: 'code', extensions: ['fs', 'fsi', 'fsx'] },
  { id: 'go', label: 'GO', color: '#29beb0', category: 'code', extensions: ['go'] },
  { id: 'java', label: 'JAVA', color: '#e2703a', category: 'code', extensions: ['java'] },
  { id: 'kotlin', label: 'KT', color: '#a97bff', category: 'code', extensions: ['kt', 'kts'] },
  { id: 'scala', label: 'SC', color: '#dc322f', category: 'code', extensions: ['scala', 'sc'] },
  { id: 'swift', label: 'SWI', color: '#f05138', category: 'code', extensions: ['swift'] },
  { id: 'zig', label: 'ZIG', color: '#f7a41d', category: 'code', extensions: ['zig', 'zon'] },
  { id: 'asm', label: 'ASM', color: '#7f8c99', category: 'code', extensions: ['asm', 's', 'nasm'] },
  { id: 'python', label: 'PY', color: '#3d7ab8', category: 'code', extensions: ['py', 'pyw', 'pyi'] },
  { id: 'jupyter', label: 'IPY', color: '#f37726', category: 'code', extensions: ['ipynb'] },
  { id: 'lua', label: 'LUA', color: '#4a56c9', category: 'code', extensions: ['lua'] },
  { id: 'php', label: 'PHP', color: '#7a86b8', category: 'code', extensions: ['php', 'phtml'] },
  { id: 'ruby', label: 'RB', color: '#cc342d', category: 'code', extensions: ['rb', 'erb', 'gemspec'] },
  { id: 'perl', label: 'PL', color: '#5a7fa0', category: 'code', extensions: ['pl', 'pm'] },
  { id: 'dart', label: 'DART', color: '#2fb6f6', category: 'code', extensions: ['dart'] },
  { id: 'elixir', label: 'EX', color: '#8a62b3', category: 'code', extensions: ['ex', 'exs'] },
  { id: 'haskell', label: 'HS', color: '#8f6bb8', category: 'code', extensions: ['hs'] },
  { id: 'r', label: 'R', color: '#2c6db5', category: 'code', extensions: ['r'] },
  { id: 'julia', label: 'JL', color: '#9358a4', category: 'code', extensions: ['jl'] },
  { id: 'sql', label: 'SQL', color: '#e0a03a', category: 'code', extensions: ['sql'] },
  // Shell & scripting
  { id: 'shell', label: 'SH', color: '#7cbf5a', category: 'code', extensions: ['sh', 'bash', 'zsh', 'fish'] },
  { id: 'powershell', label: 'PS', color: '#3f8fd8', category: 'code', extensions: ['ps1', 'psm1', 'psd1'] },
  { id: 'batch', label: 'BAT', color: '#c1c13a', category: 'code', extensions: ['bat', 'cmd'] },
  // Config, data & docs
  { id: 'yaml', label: 'YML', color: '#cb4b4b', category: 'config', extensions: ['yml', 'yaml'] },
  { id: 'toml', label: 'TOML', color: '#9c4221', category: 'config', extensions: ['toml'] },
  { id: 'xml', label: 'XML', color: '#e57d3b', category: 'data', extensions: ['xml', 'xsd', 'xsl', 'plist', 'csproj', 'vcxproj', 'props', 'targets', 'resx'] },
  { id: 'ini', label: 'INI', color: '#8a96a3', category: 'config', extensions: ['ini', 'cfg', 'conf', 'properties'] },
  { id: 'env', label: 'ENV', color: '#e0c13c', category: 'config', extensions: ['env'], names: ['.env', '.env.local', '.env.development', '.env.production', '.env.example'] },
  { id: 'csv', label: 'CSV', color: '#3fa34d', category: 'data', extensions: ['csv', 'tsv'] },
  { id: 'markdown', label: 'MD', color: '#5c9ae6', category: 'doc', extensions: ['md', 'markdown', 'mdx'] },
  { id: 'text', label: 'TXT', color: '#8a96a3', category: 'doc', extensions: ['txt', 'text', 'rst', 'adoc'] },
  { id: 'log', label: 'LOG', color: '#7a8594', category: 'doc', extensions: ['log'] },
  { id: 'pdf', label: 'PDF', color: '#d9433f', category: 'doc', extensions: ['pdf'] },
  { id: 'office', label: 'DOC', color: '#2f6fd0', category: 'doc', extensions: ['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx'] },
  { id: 'license', label: 'LIC', color: '#d4a72c', category: 'doc', names: ['license', 'license.md', 'license.txt', 'licence', 'copying'] },
  { id: 'readme', label: 'READ', color: '#5c9ae6', category: 'doc', names: ['readme', 'readme.md', 'readme.txt'] },
  // Build & package files
  { id: 'npm', label: 'NPM', color: '#cb3837', category: 'package', names: ['package.json', 'package-lock.json', '.npmrc', '.npmignore'] },
  { id: 'yarn', label: 'YARN', color: '#2c8ebb', category: 'package', names: ['yarn.lock', '.yarnrc', '.yarnrc.yml'] },
  { id: 'pnpm', label: 'PNPM', color: '#f69220', category: 'package', names: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'] },
  { id: 'cargo', label: 'CARGO', color: '#de7a4a', category: 'package', names: ['cargo.toml', 'cargo.lock'] },
  { id: 'gomod', label: 'MOD', color: '#29beb0', category: 'package', names: ['go.mod', 'go.sum'] },
  { id: 'python-pkg', label: 'PIP', color: '#3d7ab8', category: 'package', names: ['requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'pipfile', 'pipfile.lock', 'poetry.lock', 'uv.lock'] },
  { id: 'maven', label: 'MVN', color: '#c71a36', category: 'package', names: ['pom.xml'] },
  { id: 'gradle', label: 'GRD', color: '#02303a', category: 'package', extensions: ['gradle'], names: ['build.gradle.kts', 'settings.gradle.kts', 'gradlew', 'gradlew.bat'] },
  { id: 'dotnet-sln', label: 'SLN', color: '#9b4fd0', category: 'package', extensions: ['sln', 'slnx'] },
  { id: 'composer', label: 'CMP', color: '#885630', category: 'package', names: ['composer.json', 'composer.lock'] },
  { id: 'gem', label: 'GEM', color: '#cc342d', category: 'package', names: ['gemfile', 'gemfile.lock'] },
  { id: 'make', label: 'MAKE', color: '#6d8a5a', category: 'build', names: ['makefile', 'gnumakefile'], extensions: ['mk'] },
  { id: 'cmake', label: 'CMK', color: '#3a7fd0', category: 'build', names: ['cmakelists.txt'], extensions: ['cmake'] },
  { id: 'docker', label: 'DKR', color: '#2496ed', category: 'build', names: ['dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', '.dockerignore'], extensions: ['dockerfile'] },
  { id: 'terraform', label: 'TF', color: '#7b42bc', category: 'config', extensions: ['tf', 'tfvars', 'hcl'] },
  { id: 'vite', label: 'VITE', color: '#9467ff', category: 'config', names: ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'] },
  { id: 'tauri', label: 'TAURI', color: '#24c8db', category: 'config', names: ['tauri.conf.json'] },
  { id: 'eslint', label: 'LINT', color: '#4b32c3', category: 'config', names: ['.eslintrc', '.eslintrc.js', '.eslintrc.json', 'eslint.config.js', 'eslint.config.mjs'] },
  { id: 'prettier', label: 'PRT', color: '#c596c7', category: 'config', names: ['.prettierrc', '.prettierrc.json', 'prettier.config.js', '.prettierignore'] },
  { id: 'editorconfig', label: 'EC', color: '#8a96a3', category: 'config', names: ['.editorconfig'] },
  { id: 'git', label: 'GIT', color: '#f05033', category: 'config', names: ['.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', '.mailmap'] },
  { id: 'ivily-workspace', label: 'IVY', color: '#8b7dff', category: 'config', extensions: ['ivily-workspace'] },
  // Media, archives, binaries
  { id: 'image', label: 'IMG', color: '#3fae8e', category: 'media', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tif', 'tiff', 'heic'] },
  { id: 'svg', label: 'SVG', color: '#ffb13b', category: 'media', extensions: ['svg'] },
  { id: 'video', label: 'VID', color: '#d14f8c', category: 'media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv'] },
  { id: 'audio', label: 'AUD', color: '#c46ad6', category: 'media', extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'] },
  { id: 'font', label: 'FNT', color: '#d36b6b', category: 'media', extensions: ['ttf', 'otf', 'woff', 'woff2', 'eot'] },
  { id: 'archive', label: 'ZIP', color: '#b08a4a', category: 'archive', extensions: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'jar', 'war', 'nupkg', 'whl'] },
  { id: 'executable', label: 'EXE', color: '#6b7a8a', category: 'binary', extensions: ['exe', 'msi', 'dll', 'so', 'dylib', 'bin', 'sys', 'appx', 'msix'] },
  { id: 'database', label: 'DB', color: '#c08f3a', category: 'data', extensions: ['db', 'sqlite', 'sqlite3', 'mdb', 'accdb'] },
  { id: 'key', label: 'KEY', color: '#d4a72c', category: 'secret', extensions: ['pem', 'key', 'crt', 'cer', 'pfx', 'p12', 'pub'] },
];

/** @type {Record<string, { variant: string, label?: string, color?: string }>} */
const FOLDERS = {
  src: { variant: 'code', label: 'SRC', color: '#5c9ae6' },
  source: { variant: 'code', label: 'SRC', color: '#5c9ae6' },
  lib: { variant: 'code', label: 'LIB', color: '#5c9ae6' },
  app: { variant: 'code', label: 'APP', color: '#5c9ae6' },
  test: { variant: 'test', label: 'TST', color: '#e5596b' },
  tests: { variant: 'test', label: 'TST', color: '#e5596b' },
  __tests__: { variant: 'test', label: 'TST', color: '#e5596b' },
  spec: { variant: 'test', label: 'TST', color: '#e5596b' },
  docs: { variant: 'docs', label: 'DOC', color: '#5c9ae6' },
  doc: { variant: 'docs', label: 'DOC', color: '#5c9ae6' },
  '.git': { variant: 'git', label: 'GIT', color: '#f05033' },
  '.github': { variant: 'git', label: 'GH', color: '#8a96a3' },
  node_modules: { variant: 'deps', label: 'NPM', color: '#cb3837' },
  vendor: { variant: 'deps', label: 'VND', color: '#8a96a3' },
  target: { variant: 'build', label: 'OUT', color: '#8a96a3' },
  dist: { variant: 'build', label: 'OUT', color: '#8a96a3' },
  build: { variant: 'build', label: 'OUT', color: '#8a96a3' },
  out: { variant: 'build', label: 'OUT', color: '#8a96a3' },
  bin: { variant: 'build', label: 'BIN', color: '#8a96a3' },
  obj: { variant: 'build', label: 'OBJ', color: '#8a96a3' },
  assets: { variant: 'media', label: 'AST', color: '#3fae8e' },
  public: { variant: 'media', label: 'PUB', color: '#3fae8e' },
  images: { variant: 'media', label: 'IMG', color: '#3fae8e' },
  img: { variant: 'media', label: 'IMG', color: '#3fae8e' },
  scripts: { variant: 'code', label: 'SCR', color: '#7cbf5a' },
  config: { variant: 'config', label: 'CFG', color: '#8a96a3' },
  '.vscode': { variant: 'config', label: 'CFG', color: '#3f8fd8' },
  '.ivily': { variant: 'config', label: 'IVY', color: '#8b7dff' },
  'src-tauri': { variant: 'code', label: 'TAU', color: '#24c8db' },
  components: { variant: 'code', label: 'CMP', color: '#5ccfe6' },
};

/** @type {Map<string, FileType>} */
const byName = new Map();
/** @type {Map<string, FileType>} */
const byExt = new Map();

/** @param {FileType[]} types */
export function registerFileTypes(types) {
  for (const t of types) {
    for (const n of t.names ?? []) byName.set(n.toLowerCase(), t);
    for (const e of t.extensions ?? []) byExt.set(e.toLowerCase(), t);
  }
}
registerFileTypes(BUILTIN);

export const GENERIC_FILE = { id: 'file', label: '', color: '#8a96a3', category: 'generic' };

/**
 * @param {string} fileName
 * @returns {FileType}
 */
export function fileTypeOf(fileName) {
  const lower = fileName.toLowerCase();
  const named = byName.get(lower);
  if (named) return named;
  // Longest matching (compound) extension first: "a.test.tsx" → test.tsx → tsx.
  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.');
    const t = byExt.get(ext);
    if (t) return t;
  }
  if (lower.startsWith('.env')) return byName.get('.env') ?? GENERIC_FILE;
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return byName.get('dockerfile') ?? GENERIC_FILE;
  return GENERIC_FILE;
}

/** @param {string} folderName */
export function folderTypeOf(folderName) {
  return FOLDERS[folderName.toLowerCase()] ?? null;
}
