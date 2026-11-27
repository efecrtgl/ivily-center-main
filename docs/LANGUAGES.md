# Language support and toolchains

Implementation: `src/languages/` (registry, built-in providers, basic modes),
`src-tauri/src/toolchains/` (tool discovery), *Languages & Tools* page (`tools.show`).

## Support levels

Every language has one of three editor support levels, shown in **Languages & Tools → Languages**
and in the language picker:

| Level | Meaning | Examples |
|---|---|---|
| Syntax + structure | Full incremental parser: highlighting, folding, indentation, structure-aware brackets | JavaScript, JSX, TypeScript, TSX, HTML, CSS, SCSS, Sass, Less, JSON, JSONC, Vue, Markdown, Rust, C, C++, Go, Java, PHP, Python, SQL, XML, YAML |
| Syntax highlighting | Token-based highlighting (CodeMirror stream mode), heuristic indentation | C#, Kotlin, Swift, Lua, Ruby, Perl, Bash, PowerShell, TOML, Dockerfile, Assembly (GNU), INI/Properties, CMake, and ~80 more |
| Basic highlighting | Keywords, strings, comments and numbers only (written for Ivily) | Zig, Terraform/HCL, GraphQL, Makefile, Batch |

Notes: **Svelte** uses the HTML grammar (approximate). **JSONC** uses the JSON grammar, so comments
are highlighted as errors. Code intelligence (completion, diagnostics, go to definition, …) is a
separate column provided by language servers (Phase 7) and is shown only when a server is running.

Grammars are loaded lazily the first time a file of that language is opened. Toggle comment
(Ctrl+/), auto-indentation and bracket matching use the language's own data where available.

## Adding a language

`registerLanguage({ id, name, extensions, filenames, pattern, tier, lspId, load })` in
`src/languages/registry.js`. `load` returns a CodeMirror extension (a Lezer `LanguageSupport` or a
`StreamLanguage`). Extensions add file associations to existing languages (see EXTENSIONS.md).

## Toolchain discovery

The *Toolchains* tab lists ~35 tools (Git, Node.js, npm, pnpm, Yarn, Bun, Deno, Rust, Cargo,
rustup, Python, pip, uv, Java, Maven, Gradle, Kotlin, Go, .NET, PHP, Composer, Ruby, gems, GCC,
Clang, CMake, Make, Zig, Lua, Perl, Docker, PowerShell 7, Windows PowerShell, Git Bash, WSL) with
version, location and status, and highlights the ones the open workspace uses (detected from marker
files such as `Cargo.toml`, `package.json` + lock files, `pyproject.toml`, `go.mod`, `*.csproj`).

Safety:

* Tools are located by Ivily Center itself on `PATH` and common install folders and run **by
  absolute path** — never as bare names (Windows would search the current directory first).
* Version probes run from Ivily Center's data folder, not from the workspace, so project files
  such as `rust-toolchain.toml` cannot trigger downloads. Each probe has a 5-second timeout and
  bounded output.
* Windows Store app execution aliases (e.g. the `python.exe` stub that opens the Store) are
  reported as "Store alias only" and never executed.
* Nothing is installed or changed. Missing tools offer **Download page** (opens the official site
  from a built-in list — the UI cannot pass arbitrary URLs) and **Copy winget command**.
* PATH is never modified. Results are cached until **Detect again**.
