// Small token-level modes for languages without a CodeMirror grammar. They highlight keywords,
// strings, comments, numbers and a few language-specific tokens — nothing more (tier "basic").
import { StreamLanguage } from '@codemirror/language';
import { simpleMode } from '@codemirror/legacy-modes/mode/simple-mode';

const words = (list) => new RegExp(`(?:${list.split(' ').join('|')})\\b`);

export const zig = StreamLanguage.define(
  simpleMode({
    start: [
      { regex: /\/\/.*/, token: 'comment' },
      { regex: /\\\\.*/, token: 'string' },
      { regex: /"(?:[^"\\]|\\.)*"?/, token: 'string' },
      { regex: /'(?:[^'\\]|\\.)*'/, token: 'string' },
      { regex: /@[A-Za-z_]\w*/, token: 'builtin' },
      { regex: words('const var fn pub return if else while for switch break continue defer errdefer try catch orelse struct enum union error test comptime inline export extern packed align async await suspend resume nosuspend threadlocal usingnamespace and or unreachable anytype opaque'), token: 'keyword' },
      { regex: words('true false null undefined'), token: 'atom' },
      { regex: words('i8 u8 i16 u16 i32 u32 i64 u64 i128 u128 isize usize f16 f32 f64 f128 bool void noreturn type anyerror comptime_int comptime_float c_int c_uint c_long'), token: 'type' },
      { regex: /0x[0-9a-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/, token: 'number' },
      { regex: /[A-Za-z_]\w*(?=\s*\()/, token: 'def' },
      { regex: /[A-Za-z_]\w*/, token: 'variable' },
    ],
    languageData: { commentTokens: { line: '//' } },
  }),
);

export const hcl = StreamLanguage.define(
  simpleMode({
    start: [
      { regex: /(?:#|\/\/).*/, token: 'comment' },
      { regex: /\/\*/, token: 'comment', next: 'comment' },
      { regex: /"(?:[^"\\]|\\.)*"?/, token: 'string' },
      { regex: /<<-?\s*([A-Z]+)/, token: 'string' },
      { regex: words('resource data variable output module provider terraform locals for_each count depends_on lifecycle dynamic for in if'), token: 'keyword' },
      { regex: words('true false null'), token: 'atom' },
      { regex: /\d+(?:\.\d+)?/, token: 'number' },
      { regex: /[A-Za-z_][\w-]*(?=\s*=)/, token: 'property' },
      { regex: /[A-Za-z_][\w-]*/, token: 'variable' },
    ],
    comment: [
      { regex: /.*?\*\//, token: 'comment', next: 'start' },
      { regex: /.*/, token: 'comment' },
    ],
    languageData: { commentTokens: { line: '#', block: { open: '/*', close: '*/' } } },
  }),
);

export const graphql = StreamLanguage.define(
  simpleMode({
    start: [
      { regex: /#.*/, token: 'comment' },
      { regex: /"""/, token: 'string', next: 'block' },
      { regex: /"(?:[^"\\]|\\.)*"?/, token: 'string' },
      { regex: words('query mutation subscription fragment on type interface union enum input scalar schema extend implements directive repeatable'), token: 'keyword' },
      { regex: words('true false null'), token: 'atom' },
      { regex: /\$[A-Za-z_]\w*/, token: 'variableName.special' },
      { regex: /@[A-Za-z_]\w*/, token: 'meta' },
      { regex: /-?\d+(?:\.\d+)?/, token: 'number' },
      { regex: /[A-Z]\w*/, token: 'type' },
      { regex: /[A-Za-z_]\w*/, token: 'variable' },
    ],
    block: [
      { regex: /.*?"""/, token: 'string', next: 'start' },
      { regex: /.*/, token: 'string' },
    ],
    languageData: { commentTokens: { line: '#' } },
  }),
);

export const makefile = StreamLanguage.define(
  simpleMode({
    start: [
      { regex: /#.*/, token: 'comment' },
      { regex: /^(?:ifeq|ifneq|ifdef|ifndef|else|endif|include|-include|define|endef|export|override|vpath)\b/, token: 'keyword' },
      { regex: /^\.[A-Z]+(?=:)/, token: 'keyword' },
      { regex: /^[^\s:=#]+(?=\s*:(?!=))/, token: 'def' },
      { regex: /\$[({][^)}]*[)}]|\$[@<^?*%+]/, token: 'variableName.special' },
      { regex: /^[A-Za-z_][\w.-]*(?=\s*[:+?]?=)/, token: 'property' },
      { regex: /"(?:[^"\\]|\\.)*"?|'[^']*'?/, token: 'string' },
    ],
    languageData: { commentTokens: { line: '#' } },
  }),
);

export const batch = StreamLanguage.define(
  simpleMode({
    start: [
      { regex: /^\s*(?:rem\b|::).*/i, token: 'comment' },
      { regex: /^\s*:[A-Za-z_][\w]*/, token: 'labelName' },
      { regex: /%~?[\w]*%?|%%[A-Za-z]|![\w]+!/, token: 'variableName.special' },
      { regex: /"(?:[^"])*"?/, token: 'string' },
      { regex: /\b(?:echo|set|setlocal|endlocal|if|else|for|in|do|goto|call|exit|shift|pushd|popd|not|exist|defined|errorlevel|equ|neq|lss|leq|gtr|geq|cd|start|title|pause|cls)\b/i, token: 'keyword' },
      { regex: /@?echo\s+(?:off|on)\b/i, token: 'keyword' },
      { regex: /\d+/, token: 'number' },
    ],
    languageData: { commentTokens: { line: 'REM ' } },
  }),
);
