import { uid } from '../schema';
import { linearAxis, radialCenter, radialEndingRadii, radialRayEnd, type AxisBox } from './axis';
import { rgbToHex } from './color';
import type { CompareSpec, RadialGradient, RadialSize, Stop } from '../types';

export interface Sample {
    /** 0..1 вдоль оси градиента -> pos% 0..100 */
    t: number;
    r: number;
    g: number;
    b: number;
    /** 0..255 */
    a: number;
}

interface BlockSize {
    /** px размер блока */
    w: number;
    h: number;
}

type Placement = Pick<CompareSpec, 'x' | 'y' | 'scale'>;

/**
 * Точка в системе координат блока (px, 0..w / 0..h) -> координаты картинки (px).
 * Инверсия отображения overlay: translate(x, y) scale(scale) от центра блока
 * (div размером с блок + img object-fit: fill).
 */
export function blockPointToImage(
    bx: number,
    by: number,
    block: BlockSize,
    compare: Placement,
    imgW: number,
    imgH: number
): { x: number; y: number } {
    const cx = block.w / 2;
    const cy = block.h / 2;
    const dx = (bx - compare.x - cx) / compare.scale + cx;
    const dy = (by - compare.y - cy) / compare.scale + cy;
    return { x: (dx / block.w) * imgW, y: (dy / block.h) * imgH };
}

/** Пиксель картинки в точке блока; координаты клампятся в границы картинки. */
function readSample(
    image: ImageData,
    t: number,
    bx: number,
    by: number,
    block: BlockSize,
    compare: Placement
): Sample {
    const w = image.width;
    const h = image.height;
    const p = blockPointToImage(bx, by, block, compare, w, h);
    const x = Math.min(w - 1, Math.max(0, Math.floor(p.x)));
    const y = Math.min(h - 1, Math.max(0, Math.floor(p.y)));
    const i = (y * w + x) * 4;
    return {
        t,
        r: image.data[i],
        g: image.data[i + 1],
        b: image.data[i + 2],
        a: image.data[i + 3],
    };
}

/**
 * Семплы вдоль оси линейного градиента: через центр блока по angle
 * (CSS: 0 = to top, 90 = to right), длина оси = |w·sin A| + |h·cos A|.
 * axisBox задаёт другую систему координат оси (для blur-таргетов — rect
 * blur-области); точки сэмплирования остаются в px блока.
 */
export function sampleAlongLinear(
    canvas: HTMLCanvasElement,
    opts: {
        block: BlockSize;
        compare: Placement;
        /** deg */
        angle: number;
        count?: number;
        /** система координат оси; по умолчанию — весь блок */
        axisBox?: AxisBox;
    }
): Sample[] {
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width === 0 || canvas.height === 0) return [];
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const n = Math.max(2, opts.count ?? 64);
    const axis = linearAxis(
        opts.angle,
        opts.axisBox ?? { x: 0, y: 0, w: opts.block.w, h: opts.block.h }
    );
    const out: Sample[] = [];
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        out.push(
            readSample(
                image,
                t,
                axis.cx + axis.dir.x * axis.len * (t - 0.5),
                axis.cy + axis.dir.y * axis.len * (t - 0.5),
                opts.block,
                opts.compare
            )
        );
    }
    return out;
}

/**
 * Агрегированный профиль по N параллельным линиям вдоль оси линейного
 * градиента: каждая линия идёт вдоль оси (та же длина, что у осевой) со
 * смещением поперёк зоны — равномерно, по центрам равных полос перпендикуляра
 * (в системе axisBox); на каждой позиции t берётся медиана по линиям поканально
 * (r/g/b/a). Осевая линия одна и часто попадает в неудачное место фото —
 * медиана линий видит всю зону. Возвращает обычный массив Sample (t = % оси) —
 * совместим с осевым профилем/transitions/suggestedStops.
 */
export function sampleAlongLinearRays(
    canvas: HTMLCanvasElement,
    opts: {
        block: BlockSize;
        compare: Placement;
        /** deg */
        angle: number;
        count?: number;
        /** число линий */
        rays?: number;
        /**
         * линии с α ниже порога (0..255) не участвуют в медиане: без маски —
         * по собственной α (got), с маской — по α маски в этой точке блока
         */
        dropAlphaBelow?: number;
        /** маска прозрачности для dropAlphaBelow (обычно got-канвас блока) */
        alphaMask?: HTMLCanvasElement;
        /** система координат оси; по умолчанию — весь блок */
        axisBox?: AxisBox;
    }
): Sample[] {
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width === 0 || canvas.height === 0) return [];
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const n = Math.max(2, opts.count ?? 64);
    const lineCount = Math.max(2, opts.rays ?? 8);
    const keep = lineFilter(opts.dropAlphaBelow ?? 0, opts.alphaMask);
    const box = opts.axisBox ?? { x: 0, y: 0, w: opts.block.w, h: opts.block.h };
    const axis = linearAxis(opts.angle, box);
    // перпендикуляр к оси (dir единичный) и полуширина зоны вдоль него
    const perp = { x: -axis.dir.y, y: axis.dir.x };
    const half = (Math.abs(box.w * perp.x) + Math.abs(box.h * perp.y)) / 2;
    const perLine: (Sample | null)[][] = [];
    for (let k = 0; k < lineCount; k++) {
        // линии по центрам равных полос: под крайними остаётся зона — ни одна
        // не вырождается в угол box на косых углах
        const off = -half + ((k + 0.5) / lineCount) * half * 2;
        const line: (Sample | null)[] = [];
        for (let i = 0; i < n; i++) {
            const t = i / (n - 1);
            const bx = axis.cx + perp.x * off + axis.dir.x * axis.len * (t - 0.5);
            const by = axis.cy + perp.y * off + axis.dir.y * axis.len * (t - 0.5);
            line.push(keep(readSample(image, t, bx, by, opts.block, opts.compare), bx, by));
        }
        perLine.push(line);
    }
    return aggregateByMedian(perLine, n);
}

/**
 * Семплы вдоль луча радиального градиента: из центра (cx, cy %) наружу до
 * ending-shape (в системе axisBox, по умолчанию — блока). t=1 лежит НА форме
 * (эллипс по CSS-правилам размера), поэтому t·100 = честный % радиуса для
 * стопов — на любом размере (explicit/keyword), а не только на corner-вариантах.
 */
export function sampleAlongRadial(
    canvas: HTMLCanvasElement,
    opts: {
        block: BlockSize;
        compare: Placement;
        /** % центра градиента */
        cx: number;
        cy: number;
        shape: RadialGradient['shape'];
        size: RadialSize;
        /** % при size='explicit' */
        rx: number;
        ry: number;
        count?: number;
        /** система координат оси; по умолчанию — весь блок */
        axisBox?: AxisBox;
    }
): Sample[] {
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width === 0 || canvas.height === 0) return [];
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const n = Math.max(2, opts.count ?? 64);
    const box = opts.axisBox ?? { x: 0, y: 0, w: opts.block.w, h: opts.block.h };
    const c = radialCenter(opts.cx, opts.cy, box);
    const radii = radialEndingRadii(opts, box);
    // направление луча: explicit — по +X (как раньше), keyword — к дальнему углу
    let dx: number;
    let dy: number;
    if (opts.size === 'explicit') {
        dx = 1;
        dy = 0;
    } else {
        dx = c.x < box.x + box.w / 2 ? 1 : -1;
        dy = c.y < box.y + box.h / 2 ? 1 : -1;
    }
    const end = radialRayEnd(dx, dy, radii);
    const out: Sample[] = [];
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        out.push(
            readSample(image, t, c.x + dx * end * t, c.y + dy * end * t, opts.block, opts.compare)
        );
    }
    return out;
}

/** Медиана чётного количества — среднее двух центральных (детерминированно). */
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Фильтр сэмплов линий/лучей по прозрачности: без порога — все; с порогом
 * без маски — своя α (got-сэмпл за клипом блока); с порогом и маской — α
 * маски в точке (bx, by) px блока (референс фильтруем по got-канвасу: где
 * блок не рисует, ref-линия не даёт данных в медиану).
 */
function lineFilter(
    dropBelow: number,
    mask: HTMLCanvasElement | undefined
): (s: Sample, bx: number, by: number) => Sample | null {
    if (dropBelow <= 0) return (s) => s;
    if (mask === undefined) return (s) => (s.a < dropBelow ? null : s);
    const ctx = mask.getContext('2d');
    if (ctx === null || mask.width === 0 || mask.height === 0) {
        return (s) => (s.a < dropBelow ? null : s);
    }
    const { width: mw, height: mh } = mask;
    const data = ctx.getImageData(0, 0, mw, mh).data;
    return (s, bx, by) => {
        const x = Math.min(mw - 1, Math.max(0, Math.floor(bx)));
        const y = Math.min(mh - 1, Math.max(0, Math.floor(by)));
        return data[(y * mw + x) * 4 + 3] < dropBelow ? null : s;
    };
}

/**
 * Медиана по лучам/линиям на каждой позиции оси, поканально (r/g/b/a) —
 * общий агрегат для sampleAlongRadialRays и sampleAlongLinearRays.
 * Прозрачные линии в агрегат не идут (null); позиция, где не осталось ни
 * одной, исключается целиком: нулевой сэмпл рождал фантомную прозрачность
 * (hasTransparency уходил в alpha-режим даже у непрозрачного PNG, detectSteps
 * видел ложную ступень 255→0). t = i/(n-1) — как строились линии.
 */
function aggregateByMedian(lines: (Sample | null)[][], n: number): Sample[] {
    const out: Sample[] = [];
    for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0;
        const rs: number[] = [];
        const gs: number[] = [];
        const bs: number[] = [];
        const as: number[] = [];
        for (const line of lines) {
            const s = line[i];
            if (s === null) continue;
            rs.push(s.r);
            gs.push(s.g);
            bs.push(s.b);
            as.push(s.a);
        }
        if (rs.length === 0) continue;
        out.push({ t, r: median(rs), g: median(gs), b: median(bs), a: median(as) });
    }
    return out;
}

/**
 * Агрегированный профиль по N лучам радиального градиента: лучи равномерно по
 * кругу из центра (cx, cy %), каждый — от центра до ending-shape; на каждом
 * нормированном радиусе t берётся медиана по лучам поканально (r/g/b/a).
 * Возвращает обычный массив Sample (t = % радиуса в системе axisSpace) —
 * совместим с осевым профилем/transitions/suggestedStops.
 */
export function sampleAlongRadialRays(
    canvas: HTMLCanvasElement,
    opts: {
        block: BlockSize;
        compare: Placement;
        /** % центра градиента */
        cx: number;
        cy: number;
        shape: RadialGradient['shape'];
        size: RadialSize;
        /** % при size='explicit' */
        rx: number;
        ry: number;
        count?: number;
        /** число лучей */
        rays?: number;
        /**
         * лучи с α ниже порога (0..255) не участвуют в медиане: без маски —
         * по собственной α (got), с маской — по α маски в этой точке блока
         */
        dropAlphaBelow?: number;
        /** маска прозрачности для dropAlphaBelow (обычно got-канвас блока) */
        alphaMask?: HTMLCanvasElement;
        /** система координат оси; по умолчанию — весь блок */
        axisBox?: AxisBox;
    }
): Sample[] {
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width === 0 || canvas.height === 0) return [];
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const n = Math.max(2, opts.count ?? 64);
    const rayCount = Math.max(3, opts.rays ?? 16);
    const keep = lineFilter(opts.dropAlphaBelow ?? 0, opts.alphaMask);
    const box = opts.axisBox ?? { x: 0, y: 0, w: opts.block.w, h: opts.block.h };
    const c = radialCenter(opts.cx, opts.cy, box);
    const radii = radialEndingRadii(opts, box);
    const perRay: (Sample | null)[][] = [];
    for (let k = 0; k < rayCount; k++) {
        const angle = (k / rayCount) * Math.PI * 2;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        const end = radialRayEnd(dx, dy, radii);
        const ray: (Sample | null)[] = [];
        for (let i = 0; i < n; i++) {
            const t = i / (n - 1);
            const bx = c.x + dx * end * t;
            const by = c.y + dy * end * t;
            ray.push(keep(readSample(image, t, bx, by, opts.block, opts.compare), bx, by));
        }
        perRay.push(ray);
    }
    return aggregateByMedian(perRay, n);
}

/** Сценарий «подбор цвета»: референс считается непрозрачным, альфа стопов = 1. */
export function samplesForColorTarget(samples: Sample[]): Sample[] {
    return samples.map((s) => ({ ...s, a: 255 }));
}

/**
 * Сценарий «подбор маски»: у PNG с прозрачностью берём альфа-канал,
 * у полностью непрозрачного референса — luminance (0.2126r + 0.7152g + 0.0722b).
 * Цвет стопов чёрный — работает только альфа.
 */
export function samplesForMaskTarget(samples: Sample[]): Sample[] {
    const hasTransparency = samples.some((s) => s.a < 250);
    return samples.map((s) => ({
        t: s.t,
        r: 0,
        g: 0,
        b: 0,
        a: hasTransparency ? s.a : 0.2126 * s.r + 0.7152 * s.g + 0.0722 * s.b,
    }));
}

function toStop(s: Sample): Stop {
    return {
        id: uid(),
        pos: Math.round(s.t * 1000) / 10,
        color: rgbToHex(s.r, s.g, s.b),
        alpha: Math.round((s.a / 255) * 100) / 100,
    };
}

/**
 * Жадная аппроксимация: 2 стопа по краям, дальше на каждой итерации добавляем
 * стоп в точке максимального отклонения сэмплов от кусочно-линейной интерполяции
 * (Евклид по r,g,b + альфа с весом ×3), пока ошибка > tolerance (в 0..255)
 * или не упрёмся в maxStops.
 */
export function fitStops(
    samples: Sample[],
    opts: { maxStops?: number; tolerance?: number } = {}
): { stops: Stop[]; error: number } {
    const maxStops = Math.max(2, opts.maxStops ?? 8);
    const tolerance = opts.tolerance ?? 10;
    if (samples.length === 0) return { stops: [], error: 0 };

    const pts = [...samples].sort((a, b) => a.t - b.t);
    if (pts.length === 1) return { stops: [toStop(pts[0])], error: 0 };

    // индексы сэмплов, ставших узлами интерполяции (всегда отсортированы)
    let knots = [0, pts.length - 1];

    const errAt = (i: number): number => {
        const s = pts[i];
        let lo = 0;
        while (lo < knots.length && pts[knots[lo]].t <= s.t) lo++;
        const right = knots[Math.min(lo, knots.length - 1)];
        const left = knots[Math.max(lo - 1, 0)];
        const tl = pts[left].t;
        const tr = pts[right].t;
        const f = tr === tl ? 0 : (s.t - tl) / (tr - tl);
        const l = pts[left];
        const r = pts[right];
        const dr = l.r + (r.r - l.r) * f - s.r;
        const dg = l.g + (r.g - l.g) * f - s.g;
        const db = l.b + (r.b - l.b) * f - s.b;
        const da = l.a + (r.a - l.a) * f - s.a;
        return Math.sqrt(dr * dr + dg * dg + db * db + 9 * da * da);
    };

    for (;;) {
        let maxErr = 0;
        let maxIdx = -1;
        for (let i = 0; i < pts.length; i++) {
            const e = errAt(i);
            if (e > maxErr) {
                maxErr = e;
                maxIdx = i;
            }
        }
        if (maxErr <= tolerance || knots.length >= maxStops || maxIdx === -1) {
            return { stops: knots.map((k) => toStop(pts[k])), error: maxErr };
        }
        knots = [...knots, maxIdx].sort((x, y) => x - y);
    }
}
