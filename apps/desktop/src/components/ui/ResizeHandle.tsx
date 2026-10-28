import { cn } from '../../lib/cn';

/**
 * Vertical split handle. Pointer capture keeps the drag alive outside the 6px strip;
 * `edge` says which side of the pane the handle sits on.
 */
export function ResizeHandle({
  width,
  onResize,
  edge,
  label,
}: {
  width: number;
  onResize: (px: number) => void;
  edge: 'right' | 'left';
  label: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      className={cn(
        'group absolute top-0 bottom-0 z-10 w-1.5 cursor-col-resize',
        edge === 'right' ? '-right-[3px]' : '-left-[3px]',
      )}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = width;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
          const dx = ev.clientX - startX;
          onResize(edge === 'right' ? startW + dx : startW - dx);
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors duration-[120ms] group-hover:bg-line-strong" />
    </div>
  );
}
