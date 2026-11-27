// Theme bootstrap: register icon packs and built-in themes, apply the cached theme immediately
// (before settings load) to avoid a flash of the wrong theme.
import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/600.css';
import '@fontsource/vt323/400.css';
import '@fontsource/jetbrains-mono/400.css';
import { registerBuiltinIconPacks } from '../icons/index.js';
import { applyTheme, getTheme, registerTheme } from './engine.js';
import { BUILTIN_THEMES } from './themes/builtin.js';

export const DEFAULT_THEME = 'modern-dark';
const CACHE_KEY = 'ivily.theme'; // first-paint cache only; the setting in the DB is authoritative

let registered = false;
export function registerBuiltinThemes() {
  if (registered) return;
  registered = true;
  registerBuiltinIconPacks();
  for (const t of BUILTIN_THEMES) registerTheme(t);
}

function readCache() {
  try {
    return localStorage.getItem(CACHE_KEY);
  } catch {
    return null;
  }
}

/** Apply a theme by id and remember it for the next first paint. */
export function setActiveTheme(id) {
  const t = applyTheme(getTheme(id) ? id : DEFAULT_THEME);
  try {
    localStorage.setItem(CACHE_KEY, t.id);
  } catch {
    /* storage unavailable: harmless */
  }
  return t;
}

/** Called once at startup. */
export function initThemes() {
  registerBuiltinThemes();
  return setActiveTheme(readCache() || DEFAULT_THEME);
}

/** Motion preference → `data-motion` attribute consumed by the base CSS. */
export function applyMotionPreference(pref, root = document.documentElement) {
  const systemReduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.dataset.motion = pref === 'on' || (pref === 'system' && systemReduce) ? 'reduced' : 'full';
}

/** Interface font size (px) → root font size; every UI dimension is rem-based. */
export function applyUiFontSize(px, root = document.documentElement) {
  const n = Number(px);
  root.style.fontSize = `${Number.isFinite(n) ? Math.min(20, Math.max(10, n)) : 13}px`;
}
