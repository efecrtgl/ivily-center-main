// Style layers: the structural half of a theme.
//
// Colours come from a theme's tokens; *how components are built* — corners, borders, depth,
// typography, motion, decorative effects — comes from its style layer. Each layer is a CSS file
// scoped to `:root[data-style="<id>"]` plus token defaults declared here. Several themes can share
// a layer (Pixel Dark and Pixel Light share `pixel`), and no application feature knows which
// layer is active: features only use tokens and semantic class names.
import './layers/modern.css';
import './layers/pixel.css';
import './layers/retro.css';
import './layers/glass.css';

/**
 * @typedef {object} StyleLayer
 * @property {string} id
 * @property {string} name
 * @property {Record<string, string>} tokens  Token defaults for themes using this layer.
 */

/** @type {Map<string, StyleLayer>} */
const layers = new Map();

/** @param {StyleLayer} layer */
export function registerStyleLayer(layer) {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(layer.id)) throw new Error(`Invalid style layer id: ${layer.id}`);
  layers.set(layer.id, layer);
}

export const getStyleLayer = (id) => layers.get(id);
export const listStyleLayers = () => [...layers.values()];

registerStyleLayer({
  id: 'modern',
  name: 'Modern',
  tokens: {},
});

registerStyleLayer({
  id: 'pixel',
  name: 'Pixel',
  tokens: {
    'font.ui': "'Pixelify Sans', 'Segoe UI', sans-serif",
    'font.display': "'Pixelify Sans', 'Segoe UI', sans-serif",
    'font.scale': '1.08',
    'font.weight.strong': '600',
    'font.letterSpacing': '0.02em',
    'radius.sm': '0px',
    'radius.md': '0px',
    'radius.lg': '0px',
    'border.width': '2px',
    'motion.duration': '160ms',
    'motion.easing': 'steps(4, end)',
  },
});

registerStyleLayer({
  id: 'retro',
  name: 'Retro Terminal',
  tokens: {
    'font.ui': "'VT323', 'Cascadia Mono', Consolas, monospace",
    'font.display': "'VT323', 'Cascadia Mono', Consolas, monospace",
    'font.mono': "'VT323', 'Cascadia Mono', Consolas, monospace",
    'font.scale': '1.32',
    'font.weight.strong': '400',
    'font.letterSpacing': '0.04em',
    'radius.sm': '0px',
    'radius.md': '0px',
    'radius.lg': '0px',
    'border.width': '1px',
    'motion.duration': '0ms',
    'motion.easing': 'linear',
  },
});

registerStyleLayer({
  id: 'glass',
  name: 'Glass',
  tokens: {
    'radius.sm': '6px',
    'radius.md': '10px',
    'radius.lg': '16px',
    'surface.blur': '18px',
    'motion.duration': '200ms',
  },
});
