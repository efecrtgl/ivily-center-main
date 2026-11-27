// Problem matchers: turn task output lines into problems (file, line, column, severity, message).
// Built in: rustc, tsc, gcc, eslint-compact, eslint-stylish, msCompile.

/** @typedef {{ file: string, line: number, col: number, severity: 'error' | 'warning' | 'info', message: string, code?: string, source: string }} Problem */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;

export const stripAnsi = (s) => s.replace(ANSI, '');

const sev = (s) => (/error/i.test(s) ? 'error' : /warn/i.test(s) ? 'warning' : 'info');

/** Single-line matchers: regex → problem. */
const SINGLE = {
  tsc: [
    [/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/, (m) => ({ file: m[1], line: +m[2], col: +m[3], severity: sev(m[4]), code: m[5], message: m[6] })],
    [/^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/, (m) => ({ file: m[1], line: +m[2], col: +m[3], severity: sev(m[4]), code: m[5], message: m[6] })],
  ],
  gcc: [[/^(.+?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*)$/, (m) => ({ file: m[1], line: +m[2], col: +m[3], severity: m[4] === 'note' ? 'info' : sev(m[4]), message: m[5] })]],
  'eslint-compact': [[/^(.+?): line (\d+), col (\d+), (Error|Warning) - (.+?)(?: \(([\w@/-]+)\))?$/, (m) => ({ file: m[1], line: +m[2], col: +m[3], severity: sev(m[4]), message: m[5], code: m[6] })]],
  msCompile: [
    [/^\s*(?:\d+>)?(\S.*?)\((\d+)(?:,(\d+))?(?:,\d+,\d+)?\)\s*:\s+(?:\w+\s+)?(error|warning)\s+(\w+\d+)\s*:\s*(.*)$/, (m) => ({ file: m[1], line: +m[2], col: +(m[3] ?? 1), severity: sev(m[4]), code: m[5], message: m[6] })],
  ],
};

/**
 * Create a stateful matcher for the given names. Feed it lines; it returns the problems that
 * became complete with each line.
 * @param {string[]} names
 */
export function createMatcher(names) {
  const active = names.filter((n) => n === 'rustc' || n === 'eslint-stylish' || SINGLE[n]);
  /** @type {{ severity: Problem['severity'], message: string, code?: string } | null} */
  let rustPending = null;
  /** @type {string | null} */
  let stylishFile = null;
  return {
    /** @param {string} raw @returns {Problem[]} */
    push(raw) {
      const line = stripAnsi(raw).replace(/\s+$/, '');
      const out = [];
      for (const name of active) {
        if (name === 'rustc') {
          const head = /^(error|warning)(?:\[(\w+)\])?: (.*)$/.exec(line);
          if (head && !/^(warning|error): (\d+ warnings? emitted|aborting due to|could not compile|build failed)/.test(line)) {
            rustPending = { severity: sev(head[1]), code: head[2], message: head[3] };
            continue;
          }
          const loc = /^\s*--> (.+?):(\d+):(\d+)$/.exec(line);
          if (loc && rustPending) {
            out.push({ file: loc[1], line: +loc[2], col: +loc[3], ...rustPending, source: 'rustc' });
            rustPending = null;
          }
          continue;
        }
        if (name === 'eslint-stylish') {
          const m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([\w@/-]+))?$/.exec(line);
          if (m && stylishFile) out.push({ file: stylishFile, line: +m[1], col: +m[2], severity: sev(m[3]), message: m[4], code: m[5], source: 'eslint' });
          else if (/^\S/.test(line) && !/problems?\s*\(/.test(line)) stylishFile = line.trim();
          else if (!line.trim()) stylishFile = null;
          continue;
        }
        for (const [re, map] of SINGLE[name]) {
          const m = re.exec(line);
          if (m) {
            out.push({ ...map(m), source: name });
            break;
          }
        }
      }
      return out;
    },
  };
}

/** Collapse `a\b\..\c` and `./` segments; keeps the drive or leading separator. */
export function normalizePath(p) {
  const parts = p.replace(/\//g, '\\').split('\\');
  const out = [];
  for (const seg of parts) {
    if (seg === '.' || (seg === '' && out.length)) continue;
    if (seg === '..' && out.length > 1) out.pop();
    else out.push(seg);
  }
  return out.join('\\');
}

/**
 * Map a matcher file name (relative to `cwd` or absolute) to a workspace reference.
 * @param {string} file
 * @param {string} cwd absolute working directory of the task
 * @param {{ path: string }[]} folders
 * @returns {{ root: number, path: string } | null}
 */
export function toWorkspaceRef(file, cwd, folders) {
  const abs = normalizePath(/^[A-Za-z]:[\\/]|^\\\\/.test(file) ? file : `${cwd}\\${file}`);
  const lower = abs.toLowerCase();
  for (let i = 0; i < folders.length; i++) {
    const root = folders[i].path.replace(/[\\/]+$/, '');
    if (lower.startsWith(`${root.toLowerCase()}\\`)) return { root: i, path: abs.slice(root.length + 1).replace(/\\/g, '/') };
  }
  return null;
}

/** Incremental UTF-8 → lines splitter for terminal output chunks. */
export function lineSplitter(onLine) {
  const dec = new TextDecoder();
  let buf = '';
  return {
    /** @param {Uint8Array} bytes */
    write(bytes) {
      buf += dec.decode(bytes, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(buf[i] === '\r' ? i + 2 : i + 1);
        // ConPTY may redraw with carriage returns; keep the last segment.
        onLine(raw.slice(raw.lastIndexOf('\r') + 1));
      }
      if (buf.length > 65536) buf = buf.slice(-65536);
    },
    end() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}
