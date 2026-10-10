import type { BlurRect, RadialGradient } from '../types';

/** Прямоугольник в px (стейджа или канваса анализа). */
export interface AxisBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Поля radial-градиента, задающие ending-shape (радиусы). */
export type RadialShapeSpec = Pick<RadialGradient, 'cx' | 'cy' | 'shape' | 'size' | 'rx' | 'ry'>;

/**
 * Радиусы ending-shape radial-градиента по CSS-правилам размеров (px,
 * в системе координат box). Единый источник для рендера (paint) и сэмплеров
 * (ось/лучи): стопы и сэмплы обязаны мериться от одной и той же формы.
 */
export function radialEndingRadii(g: RadialShapeSpec, box: AxisBox): { rx: number; ry: number } {
    if (g.size === 'explicit') {
        return { rx: (g.rx / 100) * box.w, ry: (g.ry / 100) * box.h };
    }
    const cx = box.x + (g.cx / 100) * box.w;
    const cy = box.y + (g.cy / 100) * box.h;
    const sideX = Math.min(cx - box.x, box.x + box.w - cx);
    const sideY = Math.min(cy - box.y, box.y + box.h - cy);
    const farX = Math.max(cx - box.x, box.x + box.w - cx);
    const farY = Math.max(cy - box.y, box.y + box.h - cy);
    if (g.shape === 'circle') {
        switch (g.size) {
            case 'closest-side': {
                const r = Math.min(sideX, sideY);
                return { rx: r, ry: r };
            }
            case 'farthest-side': {
                const r = Math.max(farX, farY);
                return { rx: r, ry: r };
            }
            case 'closest-corner': {
                const r = Math.hypot(sideX, sideY);
                return { rx: r, ry: r };
            }
            default: {
                const r = Math.hypot(farX, farY);
                return { rx: r, ry: r };
            }
        }
    }
    switch (g.size) {
        case 'closest-side':
            return { rx: sideX, ry: sideY };
        case 'farthest-side':
            return { rx: farX, ry: farY };
        // corner-кейворды: точное CSS-правило corner-эллипса — берём аспект
        // side-эллипса (rx/ry = sideX/sideY) и масштабируем до угла на
        // диагонали (×√2); эллипс проходит через угол box
        case 'closest-corner':
            return { rx: sideX * Math.SQRT2, ry: sideY * Math.SQRT2 };
        default:
            return { rx: farX * Math.SQRT2, ry: farY * Math.SQRT2 };
    }
}

/**
 * Дистанция от центра до ending-shape вдоль направления (dx, dy)
 * (нормировать не обязательно): эллипс rx×ry, круг при rx ≈ ry.
 */
export function radialRayEnd(dx: number, dy: number, radii: { rx: number; ry: number }): number {
    if (radii.rx <= 0 || radii.ry <= 0) return 0;
    const len = Math.hypot(dx, dy);
    if (len === 0) return radii.rx;
    const nx = dx / len;
    const ny = dy / len;
    // точка на эллипсе вдоль луча: (t·nx/rx)² + (t·ny/ry)² = 1
    return 1 / Math.sqrt((nx * nx) / (radii.rx * radii.rx) + (ny * ny) / (radii.ry * radii.ry));
}

/** Направление оси линейного градиента (CSS: 0 = to top, 90 = to right). */
export function linearDir(angleDeg: number): { x: number; y: number } {
    const a = (angleDeg * Math.PI) / 180;
    return { x: Math.sin(a), y: -Math.cos(a) };
}

/**
 * Ось линейного градиента в системе координат box: через центр box,
 * длина |w·sin A| + |h·cos A| (проекция диагонали на ось, как в CSS).
 */
export function linearAxis(
    angleDeg: number,
    box: AxisBox
): {
    dir: { x: number; y: number };
    len: number;
    cx: number;
    cy: number;
    p1: { x: number; y: number };
    p2: { x: number; y: number };
} {
    const dir = linearDir(angleDeg);
    const len = Math.abs(box.w * dir.x) + Math.abs(box.h * dir.y);
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    return {
        dir,
        len,
        cx,
        cy,
        p1: { x: cx - (dir.x * len) / 2, y: cy - (dir.y * len) / 2 },
        p2: { x: cx + (dir.x * len) / 2, y: cy + (dir.y * len) / 2 },
    };
}

/** Центр radial-градиента (% в системе box) -> px. */
export function radialCenter(cxPct: number, cyPct: number, box: AxisBox): { x: number; y: number } {
    return { x: box.x + (cxPct / 100) * box.w, y: box.y + (cyPct / 100) * box.h };
}

/** Точка px -> % в системе box (значения могут выходить за 0..100). */
export function pxToBoxPct(px: number, py: number, box: AxisBox): { x: number; y: number } {
    return { x: ((px - box.x) / box.w) * 100, y: ((py - box.y) / box.h) * 100 };
}

/** rect покрывает весь блок — эквивалентен отсутствию rect (inset: 0). */
export function isFullRect(rect: BlurRect): boolean {
    return rect.x === 0 && rect.y === 0 && rect.w === 100 && rect.h === 100;
}

/** px-рамка blur-области: rect в % от блока -> px в системе блока/стейджа. */
export function blurRectBox(rect: BlurRect, box: AxisBox): AxisBox {
    return {
        x: box.x + (rect.x / 100) * box.w,
        y: box.y + (rect.y / 100) * box.h,
        w: (rect.w / 100) * box.w,
        h: (rect.h / 100) * box.h,
    };
}

/**
 * Проекция rect (% блока) на ось линейного градиента angle — интервал [c0, c1]
 * в % вдоль оси (0..100 = вся ось через центр box). Для проверки, попадают ли
 * позиции (ступени референса) в зону, накрываемую rect-областью.
 */
export function rectCoverageOnAxis(
    rect: BlurRect,
    box: AxisBox,
    angleDeg: number
): { c0: number; c1: number } {
    const a = (angleDeg * Math.PI) / 180;
    const dir = { x: Math.sin(a), y: -Math.cos(a) };
    const len = Math.abs(box.w * dir.x) + Math.abs(box.h * dir.y);
    if (len <= 0) return { c0: 0, c1: 100 };
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let lo = Infinity;
    let hi = -Infinity;
    const corners: [number, number][] = [
        [rect.x, rect.y],
        [rect.x + rect.w, rect.y],
        [rect.x, rect.y + rect.h],
        [rect.x + rect.w, rect.y + rect.h],
    ];
    for (const [px, py] of corners) {
        const x = box.x + (px / 100) * box.w;
        const y = box.y + (py / 100) * box.h;
        const s = (((x - cx) * dir.x + (y - cy) * dir.y) / len + 0.5) * 100;
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
    }
    return { c0: lo, c1: hi };
}
