import { linearDir, radialEndingRadii, radialRayEnd } from './axis';
import type { BlockState, BlurRect, Gradient, Stop, Warning } from '../types';

/**
 * «Жёсткая кромка» blur-слоя: если rect слоя зажат внутри блока (кромка не
 * прижата к краю), а маска у этой кромки не доведена до α≈0 — на границе
 * rect видна резкая ступень backdrop-filter (за кромкой блюра нет, внутри —
 * есть, маска его не растворяет). Чистый анализ геометрии без канваса:
 * α маски сэмплируется вдоль внутренних кромок rect (linear — проекция
 * кромок на ось градиента, radial — дистанция до ending-shape через
 * radialEndingRadii, как в рендере/autofit; mask=null → α=1 по всей кромке).
 */

/** Порог α у внутренней кромки, выше которого граница считается жёсткой. */
const HARD_EDGE_ALPHA = 0.03;
/** Кромка «не прижата» к краю блока, если отступ больше этого, % блока. */
const EDGE_EPS = 0.01;
/** Сэмплов α на кромку (для linear хватает концов, radial ловим серединой). */
const EDGE_SAMPLES = 5;

/** Кусочно-линейная альфа стопов в позиции pos% (за краями — крайний стоп). */
function alphaAt(stops: Stop[], pos: number): number {
    if (stops.length === 0) return 1;
    const sorted = [...stops].sort((a, b) => a.pos - b.pos);
    if (pos <= sorted[0].pos) return sorted[0].alpha;
    if (pos >= sorted[sorted.length - 1].pos) return sorted[sorted.length - 1].alpha;
    for (let i = 1; i < sorted.length; i++) {
        if (pos <= sorted[i].pos) {
            const a = sorted[i - 1];
            const b = sorted[i];
            const f = (pos - a.pos) / (b.pos - a.pos);
            return a.alpha + (b.alpha - a.alpha) * f;
        }
    }
    return sorted[sorted.length - 1].alpha;
}

/**
 * α маски в точке кромки (px, py — % в системе координат rect слоя, ось/центр
 * градиента живут там же: CSS считает градиент от border-box элемента).
 */
function maskAlphaAt(mask: Gradient, px: number, py: number): number {
    if (mask.type === 'linear') {
        const dir = linearDir(mask.angle);
        // ось через центр rect (50,50), длина = проекция диагонали (как в CSS)
        const len = Math.abs(100 * dir.x) + Math.abs(100 * dir.y);
        const s = (((px - 50) * dir.x + (py - 50) * dir.y) / len + 0.5) * 100;
        return alphaAt(mask.stops, s);
    }
    const box = { x: 0, y: 0, w: 100, h: 100 };
    const dx = px - mask.cx;
    const dy = py - mask.cy;
    const radii = radialEndingRadii(mask, box);
    const end = radialRayEnd(dx, dy, radii);
    const t = end > 0 ? Math.hypot(dx, dy) / end : Infinity;
    return alphaAt(mask.stops, t * 100);
}

/** Внутренние кромки rect (не прижаты к соответствующему краю блока), %. */
interface InnerEdge {
    /** родительный падеж для сообщения: «левой», «правой», «верхней», «нижней» */
    label: string;
    from: [number, number];
    to: [number, number];
}

function innerEdges(rect: BlurRect): InnerEdge[] {
    const edges: InnerEdge[] = [];
    if (rect.x > EDGE_EPS) {
        edges.push({ label: 'левой', from: [0, 0], to: [0, 100] });
    }
    if (rect.x + rect.w < 100 - EDGE_EPS) {
        edges.push({ label: 'правой', from: [100, 0], to: [100, 100] });
    }
    if (rect.y > EDGE_EPS) {
        edges.push({ label: 'верхней', from: [0, 0], to: [100, 0] });
    }
    if (rect.y + rect.h < 100 - EDGE_EPS) {
        edges.push({ label: 'нижней', from: [0, 100], to: [100, 100] });
    }
    return edges;
}

/** Слой с жёсткой кромкой: max α маски у внутренних кромок превысил порог. */
export interface BlurEdgeIssue {
    /** индекс слоя в blur.layers */
    layer: number;
    /** max α у внутренних кромок (0..1) */
    maxAlpha: number;
    /** внутренние кромки, где α > порога (родительный падеж: «левой», «нижней») */
    edges: string[];
}

/**
 * Жёсткие кромки видимых слоёв blur (blur.enabled + layer.visible): для
 * каждого слоя с внутренними кромками rect сэмплирует α маски вдоль них и
 * отдаёт превышения порога. mask=null — слой без маски, α=1 везде.
 */
export function blurEdgeIssues(state: BlockState): BlurEdgeIssue[] {
    if (!state.blur.enabled) return [];
    const issues: BlurEdgeIssue[] = [];
    state.blur.layers.forEach((layer, i) => {
        if (!layer.visible) return;
        const edges = innerEdges(layer.rect);
        if (edges.length === 0) return;
        let maxAlpha = 0;
        const hard: string[] = [];
        for (const edge of edges) {
            let edgeMax = 0;
            for (let k = 0; k < EDGE_SAMPLES; k++) {
                const f = k / (EDGE_SAMPLES - 1);
                const px = edge.from[0] + (edge.to[0] - edge.from[0]) * f;
                const py = edge.from[1] + (edge.to[1] - edge.from[1]) * f;
                // mask=null → α=1 по всей кромке (маска не растворяет блюр вовсе)
                const a = layer.mask === null ? 1 : maskAlphaAt(layer.mask, px, py);
                if (a > edgeMax) edgeMax = a;
            }
            maxAlpha = Math.max(maxAlpha, edgeMax);
            if (edgeMax > HARD_EDGE_ALPHA) hard.push(edge.label);
        }
        if (hard.length > 0) {
            issues.push({ layer: i, maxAlpha, edges: hard });
        }
    });
    return issues;
}

/** Те же проблемы в формате Warning борт-контроля (GET /api/warnings). */
export function blurEdgeWarnings(state: BlockState): Warning[] {
    return blurEdgeIssues(state).map((issue) => ({
        code: 'blur-hard-edge',
        severity: 'warn',
        message: `blur-слой ${issue.layer + 1}: маска не доведена до прозрачности у ${issue.edges.join(' и ')} кромки rect — будет жёсткая граница; вытяни стоп до α0 за кромку (позиции стоп могут быть вне 0–100%)`,
    }));
}
