import { rectCoverageOnAxis } from './axis';
import { fmtNum } from './color';
import { readGradient, targetFromString } from '../targets';
import type { Analysis, BlockState, GradientTarget, Warning } from '../types';

/** Аспекты картинок (naturalWidth/naturalHeight); null — нет картинки или не загрузилась. */
export interface ImageAspects {
    base: number | null;
    ref: number | null;
}

/** Порог значимого расхождения аспектов (2%). */
const ASPECT_TOLERANCE = 0.02;
/** Отступ от границ coverage, внутри которого переход считается накрытым (%). */
const COVERAGE_MARGIN = 1;

/** Относительное расхождение двух аспектов. */
function aspectDiff(a: number, b: number): number {
    return Math.abs(a - b) / Math.abs(b);
}

/**
 * Размеры блока под аспект картинки с меньшей деформацией: сохраняется та
 * сторона, чья относительная правка меньше (вторая подгоняется под аспект).
 */
export function fitBlockToAspect(w: number, h: number, aspect: number): { w: number; h: number } {
    const keepW = { w, h: Math.round(w / aspect) };
    const keepH = { w: Math.round(h * aspect), h };
    return Math.abs(keepW.h - h) / h <= Math.abs(keepH.w - w) / w ? keepW : keepH;
}

/**
 * Борт-контроль старта: чистая проверка стейта на типовые ошибки подбора
 * (аспекты картинок, трансформ референса, покрытие переходов зоной blur,
 * дубли стопов, нулевой радиус). Результат уходит в UI и на GET /api/warnings.
 */
export function validateStart(
    state: BlockState,
    analysis: Analysis | null,
    imageAspect: ImageAspects,
    activeTarget?: GradientTarget
): Warning[] {
    const warnings: Warning[] = [];
    const blockAspect = state.w / state.h;

    // 1. аспект base-картинки против аспекта блока
    if (state.base.kind === 'image' && state.base.image !== null && imageAspect.base !== null) {
        const aspect = imageAspect.base;
        if (aspectDiff(aspect, blockAspect) > ASPECT_TOLERANCE) {
            const fix = fitBlockToAspect(state.w, state.h, aspect);
            const aspects = `аспект ${fmtNum(aspect)} против ${fmtNum(blockAspect)}`;
            if (state.base.fit === 'cover') {
                warnings.push({
                    code: 'base-image-crop',
                    severity: 'warn',
                    message: `картинка будет cover-кропнута (${aspects}); под аспект картинки — блок ${fix.w}×${fix.h}`,
                    fix,
                });
            } else if (state.base.fit === 'fill') {
                warnings.push({
                    code: 'base-image-stretch',
                    severity: 'warn',
                    message: `картинка растягивается (object-fit: fill; ${aspects}); под аспект картинки — блок ${fix.w}×${fix.h}`,
                    fix,
                });
            } else {
                warnings.push({
                    code: 'base-image-contain',
                    severity: 'info',
                    message: `картинка вписывается с полями (contain; ${aspects}); под аспект картинки — блок ${fix.w}×${fix.h}`,
                    fix,
                });
            }
        }
    }

    // 2–3. референс: трансформ ломает pure-сравнение, аспект — растягивается
    const compare = state.compare;
    if (compare.refImage !== null) {
        if (compare.x !== 0 || compare.y !== 0 || compare.scale !== 1) {
            warnings.push({
                code: 'ref-transformed',
                severity: 'warn',
                message:
                    'референс смещён/масштабирован — попиксельный дифф учитывает трансформ, для pure-сравнения сбрось (x=0, y=0, scale=1)',
            });
        }
        if (
            imageAspect.ref !== null &&
            aspectDiff(imageAspect.ref, blockAspect) > ASPECT_TOLERANCE
        ) {
            warnings.push({
                code: 'ref-aspect-fill',
                severity: 'warn',
                message: `референс растягивается (object-fit: fill; аспект ${fmtNum(imageAspect.ref)} против ${fmtNum(blockAspect)}) — сравнение искажено`,
            });
        }
    }

    // 4. переходы референса вне зоны blur (ступени, которые rect не накрывает)
    if (
        analysis !== null &&
        state.blur.enabled &&
        analysis.axisSpace === 'block' &&
        analysis.transitions.length > 0
    ) {
        const analysisTarget = targetFromString(analysis.target);
        const gradient = analysisTarget !== null ? readGradient(state, analysisTarget) : null;
        const angle = gradient?.type === 'linear' ? gradient.angle : 180;
        // у radial нет осевого угла — coverage считается на вертикальную ось
        // (фолбэк 180°), геометрически это приближение: помечаем в сообщении
        const radialApprox = gradient?.type === 'radial';
        const { c0, c1 } = rectCoverageOnAxis(
            state.blur.rect,
            { x: 0, y: 0, w: state.w, h: state.h },
            angle
        );
        const outside = analysis.transitions.filter(
            (t) => t.pos < c0 - COVERAGE_MARGIN || t.pos > c1 + COVERAGE_MARGIN
        );
        if (outside.length > 0) {
            const from = Math.min(...outside.map((t) => t.pos));
            const to = Math.max(...outside.map((t) => t.pos));
            warnings.push({
                code: 'blur-coverage',
                severity: 'warn',
                message: `зона эффекта не накрывает переходы: ступени на ${fmtNum(from)}–${fmtNum(to)}%, rect покрывает ${fmtNum(c0)}–${fmtNum(c1)}%${radialApprox ? ' (приближённая оценка для radial)' : ''}`,
            });
        }
    }

    // 5. дубли стопов (< 0.5% между соседями) — перехода не дают
    const stopTarget =
        activeTarget ?? (analysis !== null ? targetFromString(analysis.target) : null);
    const gradient = stopTarget !== null ? readGradient(state, stopTarget) : null;
    if (gradient !== null && gradient.stops.length > 1) {
        const sorted = [...gradient.stops].map((s) => s.pos).sort((a, b) => a - b);
        const dups: number[] = [];
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] - sorted[i - 1] < 0.5) {
                const last = dups[dups.length - 1];
                if (last === undefined || sorted[i - 1] - last >= 0.5) {
                    dups.push(sorted[i - 1]);
                }
            }
        }
        if (dups.length > 0) {
            warnings.push({
                code: 'dup-stops',
                severity: 'info',
                message: `дубли стопов на ${dups.map((p) => `${fmtNum(p)}%`).join(', ')} — зазор < 0.5% не даёт перехода`,
            });
        }
    }

    // 6. blur без радиуса
    if (state.blur.enabled && state.blur.radius <= 0) {
        warnings.push({
            code: 'blur-zero-radius',
            severity: 'warn',
            message: 'blur включён, радиус нулевой — backdrop-эффекта нет',
        });
    }

    return warnings;
}
