// Context keys and `when` clauses.
//
// Commands and keybindings may declare a `when` expression that is evaluated against the
// current context (e.g. `panelVisible && activePanel == 'output'`). Grammar:
//
//   expr    := or
//   or      := and ('||' and)*
//   and     := unary ('&&' unary)*
//   unary   := '!' unary | compare
//   compare := primary (('==' | '!=') literal)?
//   primary := '(' expr ')' | 'true' | 'false' | key
//   literal := 'quoted' | "quoted" | bare-word | number
//
// Unknown keys are falsy. Malformed expressions evaluate to false (and are reported once).
import { createStore } from './store.js';

/** @type {import('./store.js').Store<Record<string, unknown>>} */
export const contextStore = createStore({});

/** @param {string} key @param {unknown} value */
export function setContext(key, value) {
  contextStore.set((c) => (c[key] === value ? c : { ...c, [key]: value }));
}

const TOKEN = /\s*(\(|\)|&&|\|\||!=|==|!|'[^']*'|"[^"]*"|[A-Za-z0-9_.\-:]+)/y;

/** @param {string} src */
function tokenize(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(src);
    if (!m) throw new SyntaxError(`Unexpected input at ${i} in when clause: ${src}`);
    out.push(m[1]);
    i = TOKEN.lastIndex;
  }
  return out;
}

/** @type {Map<string, (ctx: Record<string, unknown>) => boolean>} */
const cache = new Map();

/**
 * Compile a `when` expression into a predicate.
 * @param {string} src
 * @returns {(ctx: Record<string, unknown>) => boolean}
 */
export function compileWhen(src) {
  const hit = cache.get(src);
  if (hit) return hit;
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (t) => {
    if (next() !== t) throw new SyntaxError(`Expected '${t}' in when clause: ${src}`);
  };

  /** @returns {(c: Record<string, unknown>) => boolean} */
  const parseOr = () => {
    let left = parseAnd();
    while (peek() === '||') {
      next();
      const l = left;
      const r = parseAnd();
      left = (c) => l(c) || r(c);
    }
    return left;
  };
  const parseAnd = () => {
    let left = parseUnary();
    while (peek() === '&&') {
      next();
      const l = left;
      const r = parseUnary();
      left = (c) => l(c) && r(c);
    }
    return left;
  };
  const parseUnary = () => {
    if (peek() === '!') {
      next();
      const inner = parseUnary();
      return (c) => !inner(c);
    }
    return parseCompare();
  };
  const literal = () => {
    const t = next();
    if (t === undefined || ['(', ')', '&&', '||', '!', '==', '!='].includes(t)) {
      throw new SyntaxError(`Expected a value in when clause: ${src}`);
    }
    if (/^['"]/.test(t)) return t.slice(1, -1);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t;
  };
  const parseCompare = () => {
    const getter = parsePrimary();
    const op = peek();
    if (op === '==' || op === '!=') {
      next();
      const value = literal();
      const read = getter.read;
      return op === '==' ? (c) => read(c) === value : (c) => read(c) !== value;
    }
    return (c) => Boolean(getter.read(c));
  };
  /** @returns {{ read: (c: Record<string, unknown>) => unknown }} */
  const parsePrimary = () => {
    const t = next();
    if (t === '(') {
      const inner = parseOr();
      expect(')');
      return { read: inner };
    }
    if (t === 'true') return { read: () => true };
    if (t === 'false') return { read: () => false };
    if (t === undefined || /^['"]|^[()&|!=]/.test(t)) {
      throw new SyntaxError(`Expected a context key in when clause: ${src}`);
    }
    return { read: (c) => c[t] };
  };

  const fn = parseOr();
  if (pos !== tokens.length) throw new SyntaxError(`Unexpected '${tokens[pos]}' in when clause: ${src}`);
  cache.set(src, fn);
  return fn;
}

/**
 * Evaluate a `when` clause. An empty clause is always true; a malformed one is always false.
 * @param {string | undefined} when
 * @param {Record<string, unknown>} [ctx]
 */
export function evaluateWhen(when, ctx = contextStore.get()) {
  if (!when) return true;
  try {
    return compileWhen(when)(ctx);
  } catch (e) {
    console.warn(e);
    return false;
  }
}
