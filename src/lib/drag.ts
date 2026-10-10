import type { PointerEvent as ReactPointerEvent } from 'react';

export interface DragInfo {
    /** смещение от старта по X, px */
    dx: number;
    /** смещение от старта по Y, px */
    dy: number;
    /** абсолютные координаты указателя, px */
    x: number;
    y: number;
    ev: PointerEvent;
}

/**
 * Pointer-drag: захват указателя на исходном элементе, слушатели на window.
 * onMove/onEnd живут до pointerup/pointercancel.
 */
export function startPointerDrag(
    e: ReactPointerEvent,
    onMove: (info: DragInfo) => void,
    onEnd?: () => void
): void {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
        onMove({
            dx: ev.clientX - startX,
            dy: ev.clientY - startY,
            x: ev.clientX,
            y: ev.clientY,
            ev,
        });
    };
    const stop = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        if (target.hasPointerCapture(ev.pointerId)) {
            target.releasePointerCapture(ev.pointerId);
        }
        onEnd?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
}
