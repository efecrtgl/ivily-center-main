// Backend errors arrive as `{ code, message }` (src-tauri/src/error.rs).

/** @param {unknown} e */
export function errorCode(e) {
  return e && typeof e === 'object' && 'code' in e ? String(/** @type {any} */ (e).code) : 'unknown';
}

/** @param {unknown} e */
export function errorMessage(e) {
  if (e && typeof e === 'object' && 'message' in e) return String(/** @type {any} */ (e).message);
  return String(e);
}
