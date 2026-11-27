// Registers the built-in icon packs. Imported once at startup, before themes are registered.
import { registerIconPack } from './registry.js';
import { MODERN_PACK } from './packs/modern.js';
import { PIXEL_PACK } from './packs/pixel.js';

let done = false;
export function registerBuiltinIconPacks() {
  if (done) return;
  done = true;
  registerIconPack(MODERN_PACK);
  registerIconPack(PIXEL_PACK);
}
