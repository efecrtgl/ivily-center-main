import { memo } from 'react';
import { useStore } from '../core/store.js';
import { themeStore } from '../theme/engine.js';
import { bitmapToPath, resolveIcon } from './registry.js';

const pathCache = new Map();

/**
 * Theme-aware icon. The active theme decides which pack draws it.
 * @param {{ name: string, size?: number, title?: string, className?: string }} props
 */
function IconImpl({ name, size = 16, title, className = '' }) {
  const pack = useStore(themeStore, (s) => s.current?.iconPack ?? 'modern');
  const spec = resolveIcon(pack, name);
  if (!spec) return null;
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true };
  if (spec.kind === 'bitmap') {
    let d = pathCache.get(spec);
    if (!d) pathCache.set(spec, (d = bitmapToPath(spec.rows)));
    const w = spec.rows[0].length;
    return (
      <svg className={`icon icon--bitmap ${className}`} width={size} height={size} viewBox={`0 0 ${w} ${spec.rows.length}`} shapeRendering="crispEdges" {...a11y}>
        {title && <title>{title}</title>}
        <path d={d} fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className={`icon icon--stroke ${className}`} width={size} height={size} viewBox={spec.viewBox} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...a11y}>
      {title && <title>{title}</title>}
      <path d={spec.d} />
    </svg>
  );
}

export const Icon = memo(IconImpl);
