import { useRef, useState } from 'react';

/**
 * Resize handle. Pointer drag or keyboard (arrows ±10px, Shift ±50px, Home/End to limits).
 * @param {{ orientation: 'vertical' | 'horizontal', value: number, min: number, max: number,
 *           invert?: boolean, label: string, onChange: (v: number) => void }} props
 *   `vertical` = a vertical bar resizing widths; `invert` when dragging towards the start grows the region.
 */
export function Splitter({ orientation, value, min, max, invert = false, label, onChange }) {
  const start = useRef(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (v) => Math.min(max, Math.max(min, Math.round(v)));
  const axis = orientation === 'vertical' ? 'clientX' : 'clientY';

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { pos: e[axis], value };
    setDragging(true);
  };
  const onPointerMove = (e) => {
    if (!start.current) return;
    const delta = e[axis] - start.current.pos;
    onChange(clamp(start.current.value + (invert ? -delta : delta)));
  };
  const end = () => {
    start.current = null;
    setDragging(false);
  };
  const onKeyDown = (e) => {
    const step = e.shiftKey ? 50 : 10;
    const grow = orientation === 'vertical' ? (invert ? 'ArrowLeft' : 'ArrowRight') : invert ? 'ArrowUp' : 'ArrowDown';
    const shrink = orientation === 'vertical' ? (invert ? 'ArrowRight' : 'ArrowLeft') : invert ? 'ArrowDown' : 'ArrowUp';
    let next = null;
    if (e.key === grow) next = value + step;
    else if (e.key === shrink) next = value - step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next !== null) {
      e.preventDefault();
      onChange(clamp(next));
    }
  };

  return (
    <div
      className={`splitter splitter--${orientation}${dragging ? ' splitter--dragging' : ''}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}
