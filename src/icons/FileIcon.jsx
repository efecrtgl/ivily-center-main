import { memo } from 'react';
import { useStore } from '../core/store.js';
import { themeStore } from '../theme/engine.js';
import { fileTypeOf, folderTypeOf } from './fileTypes.js';

/**
 * File / folder icon. The active icon pack decides the drawing style (smooth page vs. pixel
 * page); the file type supplies a badge and colour. `kind` is 'file', 'dir' or 'link'.
 * @param {{ name: string, kind: 'file' | 'dir' | 'link', open?: boolean, size?: number }} props
 */
function FileIconImpl({ name, kind, open = false, size = 16 }) {
  const pixel = useStore(themeStore, (s) => s.current?.iconPack === 'pixel');
  if (kind === 'dir') {
    const ft = folderTypeOf(name);
    const color = ft?.color ?? 'var(--color-fg-muted)';
    return (
      <svg className="file-icon" width={size} height={size} viewBox="0 0 16 16" shapeRendering={pixel ? 'crispEdges' : undefined} aria-hidden="true">
        {pixel ? (
          <path d={open ? 'M1 3h5l1 1h7v2H4l-2 7H1zM4 7h11l-2 6H2z' : 'M1 3h5l1 1h8v9H1z'} fill={color} opacity={open ? 0.9 : 0.85} />
        ) : (
          <path
            d={open ? 'M1.5 4.5a1 1 0 0 1 1-1h3.6l1.2 1.3h5.7a1 1 0 0 1 1 1V6H4.3L2.4 12.5H2.5a1 1 0 0 1-1-1zM4.6 7h10.2l-1.9 5.6H2.6z' : 'M1.5 4.5a1 1 0 0 1 1-1h3.6l1.2 1.3h6.2a1 1 0 0 1 1 1v6.7a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1z'}
            fill={color}
            opacity="0.9"
          />
        )}
        {ft?.label && !open && (
          <text x="8.5" y="11.6" textAnchor="middle" fontSize="4.2" fontWeight="700" fill="var(--color-bg)" fontFamily="var(--font-ui)">
            {ft.label}
          </text>
        )}
      </svg>
    );
  }
  const t = fileTypeOf(name);
  const label = t.label;
  const small = label.length > 3;
  return (
    <svg className="file-icon" width={size} height={size} viewBox="0 0 16 16" shapeRendering={pixel ? 'crispEdges' : undefined} aria-hidden="true">
      {pixel ? (
        <path d="M3 1h7l3 3v11H3zM10 1v3h3" fill="none" stroke="var(--color-fg-muted)" strokeWidth="1" />
      ) : (
        <path d="M4 1.5h5.5L12.5 4.5v9.5a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5zM9.5 1.5v3h3" fill="none" stroke="var(--color-fg-muted)" strokeWidth="1" strokeLinejoin="round" />
      )}
      {label ? (
        <>
          <rect x={pixel ? 1 : 1.5} y="8.5" width={pixel ? 14 : 13} height="6" rx={pixel ? 0 : 1.2} fill={t.color} />
          <text x="8" y="13.3" textAnchor="middle" fontSize={small ? 3.6 : 4.6} fontWeight="700" fill="#fff" fontFamily="var(--font-ui)" letterSpacing="-0.1">
            {label}
          </text>
        </>
      ) : null}
      {kind === 'link' && <path d="M10 10l3 3m0-3v3h-3" stroke="var(--color-info)" strokeWidth="1.2" fill="none" />}
    </svg>
  );
}

export const FileIcon = memo(FileIconImpl);
