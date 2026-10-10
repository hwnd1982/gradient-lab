import { blurRectBox, radialEndingRadii, rectCoverageOnAxis } from './axis';
import { readGradient, isAlphaTarget, targetAxisRect, targetToKey } from '../targets';
import type {
    Analysis,
    AnalysisAxisPoint,
    AnalysisResidual,
    AnalysisSuggestedStop,
    AnalysisTransition,
    BlendMode,
    BlockState,
    Gradient,
    GradientTarget,
    LinearGradient,
    RadialGradient,
} from '../types';
import {
    sampleAlongLinear,
    sampleAlongLinearRays,
    sampleAlongRadial,
    sampleAlongRadialRays,
} from './autofit';
import type { Sample } from './autofit';
import { parseRgba, rgbToHex, rgbaString } from './color';
import { getCanvas } from './imageCache';

/** Длинная сторона канваса анализа: держим попиксельный диф дешёвым. */
const MAX_SIDE = 240;
/** Порог «ступени» референса вдоль оси, 0..255. */
const TRANSITION_STEP = 12;
/** Минимальный зазор между предложенными стопами, %. */
const MIN_STOP_GAP = 2;
/**
 * Порог прозрачности got-пикселя/сэмпла (0..255): блок здесь ничего не
 * рисует (клип border-radius, blur.rect за краем) — расхождение фиктивно.
 */
const GOT_ALPHA_MIN = 8;

interface RectPx {
    x: number;
    y: number;
    w: number;
    h: number;
}

function clamp01(v: number): number {
    return Math.min(1, Math.max(0, v));
}

function round0(n: number): number {
    return Math.round(n);
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** Евклид по r,g,b,a (0..510), нормированный в 0..255. */
function pixelErr(dr: number, dg: number, db: number, da: number): number {
    return Math.sqrt(dr * dr + dg * dg + db * db + da * da) / 2;
}

/** Heat-карта: чёрный → красный → жёлтый → белый по величине расхождения (0..255). */
function heat(v: number): [number, number, number] {
    const t = Math.min(1, Math.max(0, v / 255));
    return [
        round0(Math.min(1, t / 0.4) * 255),
        round0(Math.min(1, Math.max(0, (t - 0.4) / 0.4)) * 255),
        round0(Math.min(1, Math.max(0, (t - 0.8) / 0.2)) * 255),
    ];
}

function blendToComposite(blend: BlendMode): GlobalCompositeOperation {
    return blend === 'normal' ? 'source-over' : (blend as GlobalCompositeOperation);
}

function applyStops(grad: CanvasGradient, g: Gradient): void {
    const stops = [...g.stops].sort((a, b) => a.pos - b.pos);
    if (stops.length === 0) {
        grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
        return;
    }
    // canvas требует offset 0..1; стопы вне диапазона клампим — за краем цвет
    // продолжается константно, как и в CSS
    for (const s of stops) {
        grad.addColorStop(clamp01(s.pos / 100), rgbaString(s.color, s.alpha));
    }
}

function paintLinear(ctx: CanvasRenderingContext2D, g: LinearGradient, rect: RectPx): void {
    const a = (g.angle * Math.PI) / 180;
    const dir = { x: Math.sin(a), y: -Math.cos(a) };
    const len = Math.abs(rect.w * dir.x) + Math.abs(rect.h * dir.y);
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const grad = ctx.createLinearGradient(
        cx - (dir.x * len) / 2,
        cy - (dir.y * len) / 2,
        cx + (dir.x * len) / 2,
        cy + (dir.y * len) / 2
    );
    applyStops(grad, g);
    ctx.fillStyle = grad;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
}

function paintRadial(ctx: CanvasRenderingContext2D, g: RadialGradient, rect: RectPx): void {
    const { rx, ry } = radialEndingRadii(g, rect);
    if (rx <= 0 || ry <= 0) return;
    const cx = rect.x + (g.cx / 100) * rect.w;
    const cy = rect.y + (g.cy / 100) * rect.h;
    ctx.save();
    if (Math.abs(rx - ry) < 0.001) {
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
        applyStops(grad, g);
        ctx.fillStyle = grad;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    } else {
        // эллипс через неравномерный масштаб: круг радиусом ry, растянутый по X в rx/ry
        const k = rx / ry;
        ctx.translate(cx, cy);
        ctx.scale(k, 1);
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
        applyStops(grad, g);
        ctx.fillStyle = grad;
        ctx.fillRect((rect.x - cx) / k, rect.y - cy, rect.w / k, rect.h);
    }
    ctx.restore();
}

function paintGradient(ctx: CanvasRenderingContext2D, g: Gradient, rect: RectPx): void {
    if (g.type === 'linear') {
        paintLinear(ctx, g, rect);
    } else {
        paintRadial(ctx, g, rect);
    }
}

/** Рисует fill, умноженный по альфе на маску (маска в координатах maskRect). */
function drawMasked(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    fill: (c: CanvasRenderingContext2D) => void,
    mask: Gradient,
    maskRect: RectPx
): void {
    const tmp = document.createElement('canvas');
    tmp.width = W;
    tmp.height = H;
    const tctx = tmp.getContext('2d');
    if (!tctx) {
        fill(ctx);
        return;
    }
    fill(tctx);
    tctx.save();
    tctx.globalCompositeOperation = 'destination-in';
    paintGradient(tctx, mask, maskRect);
    tctx.restore();
    ctx.drawImage(tmp, 0, 0);
}

/**
 * Clamp-to-edge: снапшот, обрамлённый полосами копий краевых пикселей шириной
 * pad — blur за краем блока сэмплит крайний цвет, а не прозрачность (как
 * backdrop root с isolation: isolate в реальном браузере).
 */
function edgeStretch(snapshot: HTMLCanvasElement, pad: number): HTMLCanvasElement | null {
    if (pad <= 0) return null;
    const W = snapshot.width;
    const H = snapshot.height;
    if (W === 0 || H === 0) return null;
    const padded = document.createElement('canvas');
    padded.width = W + pad * 2;
    padded.height = H + pad * 2;
    const pctx = padded.getContext('2d');
    if (!pctx) return null;
    pctx.imageSmoothingEnabled = false;
    // края: крайние ряд/колонка растягиваются в полосы; углы — 1×1 пиксели
    pctx.drawImage(snapshot, 0, 0, 1, H, 0, pad, pad, H); // left
    pctx.drawImage(snapshot, W - 1, 0, 1, H, pad + W, pad, pad, H); // right
    pctx.drawImage(snapshot, 0, 0, W, 1, pad, 0, W, pad); // top
    pctx.drawImage(snapshot, 0, H - 1, W, 1, pad, pad + H, W, pad); // bottom
    pctx.drawImage(snapshot, 0, 0, 1, 1, 0, 0, pad, pad); // nw
    pctx.drawImage(snapshot, W - 1, 0, 1, 1, pad + W, 0, pad, pad); // ne
    pctx.drawImage(snapshot, 0, H - 1, 1, 1, 0, pad + H, pad, pad); // sw
    pctx.drawImage(snapshot, W - 1, H - 1, 1, 1, pad + W, pad + H, pad, pad); // se
    pctx.drawImage(snapshot, pad, pad);
    return padded;
}

/**
 * Приближённый рендер блока в canvas W×H: база (цвет/градиент/картинка с
 * object-fit + вуаль base.gradient поверх неё) → градиентные слои
 * (opacity/blend) → underlay-затемнение → blur-слой → маска блока. Порядок
 * как в экспорте (base → layers → underlay ::before → blur ::after).
 * backdrop-filter эмулируем: подстилающие слои (база+слои+underlay) блюрятся
 * внутри blur.rect через ctx.filter (CSS блюрит и стейдж за блоком — мы
 * приближаем только содержимым блока); при stage.isolated за краем блока
 * блюр сэмплит копии краевых пикселей. Маска blur-слоя применяется к
 * элементу ЦЕЛИКОМ: backdrop-эффект идёт через destination-in с градиентом
 * маски ДО наложения заливки — вклад блюра пропорционален локальной альфе
 * маски (progressive blur), под ним просвечивает неразмытый контент, сверху
 * — маскированная заливка. clip-text canvas не умеет — в дифф попадает
 * «цветовая» часть блока.
 */
function renderBlock(state: BlockState, baseImg: HTMLCanvasElement | null): HTMLCanvasElement {
    const scale = Math.min(1, MAX_SIDE / Math.max(state.w, state.h));
    const W = Math.max(1, Math.round(state.w * scale));
    const H = Math.max(1, Math.round(state.h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return canvas;
    const block: RectPx = { x: 0, y: 0, w: W, h: H };

    // border-radius: CSS клипает весь контент блока — канва должна совпадать
    // с блоком по скруглению, иначе углы дают ложные остатки на кромке
    const radius = Math.min(round2(state.radius * scale), W / 2, H / 2);
    if (radius > 0) {
        ctx.beginPath();
        ctx.roundRect(0, 0, W, H, radius);
        ctx.clip();
    }

    if (state.base.kind === 'color') {
        ctx.fillStyle = state.base.color;
        ctx.fillRect(0, 0, W, H);
    } else if (state.base.kind === 'gradient') {
        paintGradient(ctx, state.base.gradient, block);
    } else if (baseImg !== null && baseImg.width > 0 && baseImg.height > 0) {
        if (state.base.fit === 'fill') {
            ctx.drawImage(baseImg, 0, 0, W, H);
        } else {
            const s =
                state.base.fit === 'cover'
                    ? Math.max(W / baseImg.width, H / baseImg.height)
                    : Math.min(W / baseImg.width, H / baseImg.height);
            const dw = baseImg.width * s;
            const dh = baseImg.height * s;
            ctx.drawImage(
                baseImg,
                (W - dw) * (state.base.posX / 100),
                (H - dh) * (state.base.posY / 100),
                dw,
                dh
            );
        }
        // вуаль базового градиента поверх картинки (как в превью/экспорте
        // multiple backgrounds — дифф видит затемнение от base.gradient)
        paintGradient(ctx, state.base.gradient, block);
    }

    for (const layer of state.layers) {
        if (!layer.visible) continue;
        // слой рисуется по своему rect (согласовано с cssgen/BlockBox):
        // градиент считается от border-box элемента, не от блока
        const rect = blurRectBox(layer.rect, block);
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = blendToComposite(layer.blend);
        paintGradient(ctx, layer.gradient, rect);
        ctx.restore();
    }

    // подложка затемнения: под blur-div, без маски и блюра, своя rect
    if (state.blur.underlay.enabled) {
        const underlay = state.blur.underlay;
        const rect: RectPx = {
            x: (underlay.rect.x / 100) * W,
            y: (underlay.rect.y / 100) * H,
            w: (underlay.rect.w / 100) * W,
            h: (underlay.rect.h / 100) * H,
        };
        if (underlay.gradient !== null) {
            paintGradient(ctx, underlay.gradient, rect);
        } else if (underlay.color !== null && parseRgba(underlay.color) !== null) {
            ctx.fillStyle = underlay.color;
            ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        }
    }

    if (state.blur.enabled) {
        const r = state.blur.rect;
        const rect: RectPx = {
            x: (r.x / 100) * W,
            y: (r.y / 100) * H,
            w: (r.w / 100) * W,
            h: (r.h / 100) * H,
        };
        // backdrop-эмуляция: снапшот подстилающих слоёв блюрится внутри rect
        // (радиус CSS в px блока -> px канваса через scale); blur у границ rect
        // сэмплит содержимое за его пределами — как настоящий backdrop-filter;
        // при isolated снапшот обрамляется clamp-to-edge полосами ≥ 3σ радиуса
        const rpx = round2(state.blur.radius * scale);
        if (rpx > 0) {
            const snapshot = document.createElement('canvas');
            snapshot.width = W;
            snapshot.height = H;
            const snapCtx = snapshot.getContext('2d');
            if (snapCtx !== null) {
                snapCtx.drawImage(canvas, 0, 0);
                let src: HTMLCanvasElement = snapshot;
                let off = 0;
                if (state.stage.isolated) {
                    // support гауссова blur(R) ≈ 3σ: полосы clamp-to-edge шириной
                    // σ+2 оставляли у кромки ~20–30% массы ядра на прозрачности;
                    // pad = 3σ + 2 закрывает ядро целиком
                    const pad = Math.ceil(3 * rpx) + 2;
                    const padded = edgeStretch(snapshot, pad);
                    if (padded !== null) {
                        src = padded;
                        off = pad;
                    }
                }
                // блюр в отдельный слой (не 'copy' в основной канвас): маска
                // должна применяться к backdrop-эффекту до наложения заливки
                const blurred = document.createElement('canvas');
                blurred.width = W;
                blurred.height = H;
                const blurCtx = blurred.getContext('2d');
                if (blurCtx !== null) {
                    blurCtx.save();
                    blurCtx.beginPath();
                    blurCtx.rect(rect.x, rect.y, rect.w, rect.h);
                    blurCtx.clip();
                    blurCtx.filter = `blur(${rpx}px)`;
                    blurCtx.drawImage(src, -off, -off);
                    blurCtx.restore();
                    let backdropLayer = blurred;
                    if (state.blur.mask !== null) {
                        backdropLayer = document.createElement('canvas');
                        backdropLayer.width = W;
                        backdropLayer.height = H;
                        const maskCtx = backdropLayer.getContext('2d');
                        if (maskCtx !== null) {
                            maskCtx.drawImage(blurred, 0, 0);
                            maskCtx.save();
                            maskCtx.globalCompositeOperation = 'destination-in';
                            paintGradient(maskCtx, state.blur.mask, rect);
                            maskCtx.restore();
                        }
                    }
                    ctx.drawImage(backdropLayer, 0, 0);
                }
            }
        }
        const fill = (c: CanvasRenderingContext2D) => {
            if (state.blur.gradient !== null) {
                paintGradient(c, state.blur.gradient, rect);
            } else if (
                state.blur.background !== null &&
                parseRgba(state.blur.background) !== null
            ) {
                c.fillStyle = state.blur.background;
                c.fillRect(rect.x, rect.y, rect.w, rect.h);
            }
        };
        if (state.blur.mask !== null) {
            drawMasked(ctx, W, H, fill, state.blur.mask, rect);
        } else {
            fill(ctx);
        }
    }

    if (state.mask.enabled) {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-in';
        paintGradient(ctx, state.mask.gradient, block);
        ctx.restore();
    }

    return canvas;
}

/**
 * Референс, перепроецированный в систему координат блока — тот же transform,
 * что у overlay сравнения (translate(x, y) scale(s) от центра, object-fit: fill).
 */
function projectRef(
    state: BlockState,
    refCanvas: HTMLCanvasElement,
    W: number,
    H: number,
    scale: number
): ImageData {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return new ImageData(W, H);
    const c = state.compare;
    ctx.setTransform(1, 0, 0, 1, W / 2 + c.x * scale, H / 2 + c.y * scale);
    ctx.scale(c.scale, c.scale);
    ctx.drawImage(refCanvas, -W / 2, -H / 2, W, H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return ctx.getImageData(0, 0, W, H);
}

/** Ближайший к pos% семпл по массиву (t — 0..1); null — сэмплов нет вовсе. */
function sampleAt(samples: Sample[], pos: number): Sample | null {
    let best: Sample | null = null;
    let bestD = Infinity;
    for (const s of samples) {
        const d = Math.abs(s.t * 100 - pos);
        if (d < bestD) {
            bestD = d;
            best = s;
        }
    }
    return best;
}

/** Число точек профиля (ось и колонковый профиль). */
const PROFILE_COUNT = 64;
/** Края оси/зоны, % — остатки здесь считаются «кромками». */
const EDGE_ZONE = 3;
/** Соседние сэмплы с err ≤ этого уровня — граница «чистая» (для кромки rect). */
const CLEAN_NEIGHBOR_ERR = 3;

interface RawStep {
    pos: number;
    level: number;
    step: number;
}

/**
 * «Ступени» профиля: позиции резкой смены уровня (> TRANSITION_STEP);
 * ступени ближе MIN_STOP_GAP% — шум одной границы, оставляем контрастнее.
 * Позиция берётся из самой точки (t сэмпла), а не из индекса массива —
 * после исключения позиций полного выбывания лучей/линий сетка неравномерна.
 */
function detectSteps(points: { pos: number; level: number }[]): RawStep[] {
    const steps: RawStep[] = [];
    for (let i = 1; i < points.length; i++) {
        const d = Math.abs(points[i].level - points[i - 1].level);
        if (d <= TRANSITION_STEP) continue;
        const next: RawStep = {
            pos: round1(points[i].pos),
            level: round0(points[i].level),
            step: d,
        };
        const prev = steps[steps.length - 1];
        if (prev !== undefined && next.pos - prev.pos < MIN_STOP_GAP) {
            if (next.step > prev.step) steps[steps.length - 1] = next;
            continue;
        }
        steps.push(next);
    }
    return steps;
}

/**
 * Колонковый профиль: P60 яркости (или альфы у PNG с прозрачностью) по
 * вертикальным колонкам — устойчив к горизонтальному дрейфу контента
 * (карусели): позиция = % по оси X. box ограничивает область сэмплирования
 * пикселями (для rect-таргетов — их rect): позиции тогда получаются в
 * системе координат rect (0..100 rect), как у осевого пути.
 */
function columnProfileLevels(
    data: ImageData,
    count: number,
    box?: { x0: number; y0: number; x1: number; y1: number }
): number[] {
    const { width: w, data: d } = data;
    const x0 = box?.x0 ?? 0;
    const y0 = box?.y0 ?? 0;
    const x1 = box?.x1 ?? w;
    const y1 = box?.y1 ?? data.height;
    if (x1 <= x0 || y1 <= y0) return [];
    let transparent = false;
    for (let i = 3; i < d.length; i += 397) {
        if (d[i] < 250) {
            transparent = true;
            break;
        }
    }
    const rowStep = Math.max(1, Math.floor((y1 - y0) / 200));
    const levels: number[] = [];
    for (let c = 0; c < count; c++) {
        const cx0 = Math.floor(x0 + (c / count) * (x1 - x0));
        const cx1 = Math.max(cx0 + 1, Math.floor(x0 + ((c + 1) / count) * (x1 - x0)));
        const vals: number[] = [];
        for (let y = y0; y < y1; y += rowStep) {
            for (let x = cx0; x < cx1; x++) {
                const i = (y * w + x) * 4;
                vals.push(
                    transparent ? d[i + 3] : 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
                );
            }
        }
        vals.sort((a, b) => a - b);
        const idx = Math.min(vals.length - 1, Math.floor(vals.length * 0.6));
        levels.push(vals[idx]);
    }
    return levels;
}

/** Классификация точек оси: кромка / зона blur / уровень. */
function classifyResiduals(
    axis: AnalysisAxisPoint[],
    coverage: { c0: number; c1: number } | null
): AnalysisResidual['kind'][] {
    return axis.map((p, i) => {
        const prev = axis[i - 1]?.err;
        const next = axis[i + 1]?.err;
        const neighborsClean =
            (prev === undefined || prev <= CLEAN_NEIGHBOR_ERR) &&
            (next === undefined || next <= CLEAN_NEIGHBOR_ERR);
        // кромки самой оси
        if (p.pos <= EDGE_ZONE || p.pos >= 100 - EDGE_ZONE) return 'edge';
        if (coverage !== null) {
            // граница rect-зоны при чистых соседях — артефакт геометрии, не цвета
            if (
                (Math.abs(p.pos - coverage.c0) <= EDGE_ZONE ||
                    Math.abs(p.pos - coverage.c1) <= EDGE_ZONE) &&
                neighborsClean
            ) {
                return 'edge';
            }
            if (p.pos > coverage.c0 && p.pos < coverage.c1) return 'blur';
        }
        return 'level';
    });
}

/** Человеческая сводка по топ-остаткам: что править в первую очередь. */
function buildVerdict(residuals: AnalysisResidual[], tolerance: number): string {
    const top = [...residuals].sort((a, b) => b.err - a.err).slice(0, 10);
    if (top.length === 0) {
        return `остатки в пределах допуска (err ≤ ${tolerance}) — совпадение полное`;
    }
    const n: Record<AnalysisResidual['kind'], number> = {
        edge: 0,
        blur: 0,
        level: 0,
        approx: 0,
    };
    for (const r of top) n[r.kind]++;
    const tail = ` (топ-${top.length}: кромки ${n.edge}, blur ${n.blur}, уровень ${n.level}, приблизительно ${n.approx})`;
    if (n.approx >= n.edge && n.approx >= n.blur && n.approx >= n.level) {
        return `остатки — приблизительная классификация (профиль по колонкам): сверяйтесь со ступенями и heat-картой${tail}`;
    }
    if (n.edge >= n.blur && n.edge >= n.level) {
        return `остатки — кромки: альфой не лечатся, правь геометрию/rect${tail}`;
    }
    if (n.blur >= n.level) {
        return `остатки в blur-зоне: крутите радиус/стопы маски${tail}`;
    }
    return `остатки уровня: примените suggestedStops${tail}`;
}

export interface AnalysisResult {
    data: Analysis;
    /** heat-карта расхождений (чёрный = совпадение), растягивается на блок */
    diff: HTMLCanvasElement;
}

/**
 * Diff-анализ блока против референса (Perfect Pixel): попиксельная heat-карта,
 * matchPercent (глобальный и в зоне эффекта), профиль вдоль оси активного
 * градиента (или по колонкам/лучам), «ступени» референса, предлагаемые стопы,
 * классификация остатков и вердикт.
 */
export async function computeAnalysis(
    state: BlockState,
    target: GradientTarget,
    refCanvas: HTMLCanvasElement,
    opts: { profile?: 'axis' | 'columns' | 'rays' } = {}
): Promise<AnalysisResult> {
    const scale = Math.min(1, MAX_SIDE / Math.max(state.w, state.h));
    const W = Math.max(1, Math.round(state.w * scale));
    const H = Math.max(1, Math.round(state.h * scale));
    const tolerance = state.compare.tolerance;

    let baseImg: HTMLCanvasElement | null = null;
    if (state.base.kind === 'image' && state.base.image !== null) {
        baseImg = await getCanvas(state.base.image);
    }
    const got = renderBlock(state, baseImg);
    const gotCtx = got.getContext('2d', { willReadFrequently: true });
    const gotData = gotCtx?.getImageData(0, 0, W, H) ?? new ImageData(W, H);
    const refData = projectRef(state, refCanvas, W, H, scale);

    // зона эффекта таргета, % блока: blur-таргеты — blur.rect, underlay — свой
    // rect, layer — rect слоя, остальные — весь блок; ось rect-таргетов тоже
    // в системе их rect (полный rect слоя нормализован в undefined — старое
    // поведение бит-в-бит)
    const axisRect = targetAxisRect(state, target);
    const zone = axisRect ?? { x: 0, y: 0, w: 100, h: 100 };
    const axisSpace: Analysis['axisSpace'] =
        axisRect === undefined
            ? 'block'
            : target.kind === 'underlay'
              ? 'underlay.rect'
              : target.kind === 'layer'
                ? 'layer.rect'
                : 'blur.rect';

    const diff = document.createElement('canvas');
    diff.width = W;
    diff.height = H;
    const diffCtx = diff.getContext('2d');
    const out = diffCtx?.createImageData(W, H) ?? new ImageData(W, H);
    const zx0 = Math.max(0, Math.floor((zone.x / 100) * W));
    const zy0 = Math.max(0, Math.floor((zone.y / 100) * H));
    const zx1 = Math.min(W, Math.ceil(((zone.x + zone.w) / 100) * W));
    const zy1 = Math.min(H, Math.ceil(((zone.y + zone.h) / 100) * H));
    let matched = 0;
    let accounted = 0;
    let maxError = 0;
    let zoneMatched = 0;
    let zoneTotal = 0;
    for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        out.data[j + 3] = 255;
        // прозрачный got (за клипом radius / blur.rect): сравниваем то, что
        // блок реально рисует — пиксель выпадает из matchPercent/maxError/
        // зоны, знаменатели считают только учтённые пиксели; в heat-карте
        // он остаётся чёрным (совпадение)
        if (gotData.data[j + 3] < GOT_ALPHA_MIN) continue;
        accounted++;
        const e = pixelErr(
            gotData.data[j] - refData.data[j],
            gotData.data[j + 1] - refData.data[j + 1],
            gotData.data[j + 2] - refData.data[j + 2],
            gotData.data[j + 3] - refData.data[j + 3]
        );
        if (e < tolerance) matched++;
        if (e > maxError) maxError = e;
        const x = i % W;
        const y = (i - x) / W;
        if (x >= zx0 && x < zx1 && y >= zy0 && y < zy1) {
            zoneTotal++;
            if (e < tolerance) zoneMatched++;
        }
        const [r, g, b] = heat(e);
        out.data[j] = r;
        out.data[j + 1] = g;
        out.data[j + 2] = b;
    }
    diffCtx?.putImageData(out, 0, 0);

    // профиль по оси активного градиента (fallback — первый слой / вертикаль);
    // rect-таргеты сэмплируем в системе их rect — градиент считается от
    // border-box элемента, позиции ступеней/стопов получаются честными
    const axisGradient = readGradient(state, target) ?? state.layers[0]?.gradient ?? null;
    const common = { block: { w: W, h: H } };
    const axisBox =
        axisRect !== undefined ? blurRectBox(axisRect, { x: 0, y: 0, w: W, h: H }) : undefined;
    // рендер блока уже в системе координат канваса — тождественное размещение;
    // референс сэмплируем через реальный placement (переведённый в px канваса)
    const identity = { x: 0, y: 0, scale: 1 };
    const placement = {
        x: state.compare.x * scale,
        y: state.compare.y * scale,
        scale: state.compare.scale,
    };
    let refSamples: Sample[] = [];
    let gotSamples: Sample[] = [];
    // «по лучам»: radial — медиана лучей из центра, linear — медиана
    // параллельных линий вдоль оси; ось-линия одна и слепа ко всему вне её
    const raysProfile = opts.profile === 'rays';
    if (axisGradient?.type === 'radial') {
        const radial = {
            cx: axisGradient.cx,
            cy: axisGradient.cy,
            shape: axisGradient.shape,
            size: axisGradient.size,
            rx: axisGradient.rx,
            ry: axisGradient.ry,
        };
        if (raysProfile) {
            // профиль по лучам: медиана 16 лучей из центра на нормированном
            // радиусе — ось-линия слепа к объектам вне линии, лучи видят всю
            // зону; ref-лучи фильтруем по got-маске: где блок не рисует
            // (клип radius/rect), ref-данные в медиану не идут
            refSamples = sampleAlongRadialRays(refCanvas, {
                ...common,
                compare: placement,
                ...radial,
                axisBox,
                dropAlphaBelow: GOT_ALPHA_MIN,
                alphaMask: got,
            });
            gotSamples = sampleAlongRadialRays(got, {
                ...common,
                compare: identity,
                ...radial,
                axisBox,
                dropAlphaBelow: GOT_ALPHA_MIN,
            });
        } else {
            refSamples = sampleAlongRadial(refCanvas, {
                ...common,
                compare: placement,
                ...radial,
                axisBox,
            });
            gotSamples = sampleAlongRadial(got, {
                ...common,
                compare: identity,
                ...radial,
                axisBox,
            });
        }
    } else {
        const angle = axisGradient?.type === 'linear' ? axisGradient.angle : 180;
        if (raysProfile) {
            // профиль по линиям: медиана 8 параллельных линий вдоль оси со
            // смещением поперёк зоны — ось-линия часто попадает в неудачное
            // место фото, медиана линий видит всю зону; ref-линии фильтруем
            // по got-маске (за клипом блока ref-данные в медиану не идут)
            refSamples = sampleAlongLinearRays(refCanvas, {
                ...common,
                compare: placement,
                angle,
                axisBox,
                dropAlphaBelow: GOT_ALPHA_MIN,
                alphaMask: got,
            });
            gotSamples = sampleAlongLinearRays(got, {
                ...common,
                compare: identity,
                angle,
                axisBox,
                dropAlphaBelow: GOT_ALPHA_MIN,
            });
        } else {
            refSamples = sampleAlongLinear(refCanvas, {
                ...common,
                compare: placement,
                angle,
                axisBox,
            });
            gotSamples = sampleAlongLinear(got, { ...common, compare: identity, angle, axisBox });
        }
    }

    const axis: AnalysisAxisPoint[] = [];
    for (let i = 0; i < refSamples.length; i++) {
        const rs = refSamples[i];
        const gs = gotSamples[i] ?? rs;
        axis.push({
            pos: round1(rs.t * 100),
            ref: [round0(rs.r), round0(rs.g), round0(rs.b), round0(rs.a)],
            got: [round0(gs.r), round0(gs.g), round0(gs.b), round0(gs.a)],
            // got-сэмпл за клипом (α < GOT_ALPHA_MIN): позиция выпадает из
            // остатков — блок здесь ничего не рисует, расхождение фиктивно
            err:
                gs.a < GOT_ALPHA_MIN
                    ? 0
                    : round1(pixelErr(rs.r - gs.r, rs.g - gs.g, rs.b - gs.b, rs.a - gs.a)),
        });
    }

    // «ступени» референса: уровень = альфа у PNG с прозрачностью, иначе luminance;
    // лучи/линии исключают позиции полного выбывания — фантомных a=0 здесь нет
    const maskTarget = isAlphaTarget(target.kind);
    const hasTransparency = refSamples.some((s) => s.a < 250);
    const level = (s: Sample): number =>
        hasTransparency ? s.a : 0.2126 * s.r + 0.7152 * s.g + 0.0722 * s.b;

    let transitions: AnalysisTransition[];
    let suggestedStops: AnalysisSuggestedStop[];
    if (opts.profile === 'columns') {
        // колонковый профиль: ступени/стопы по P60 яркости колонок (ось X),
        // устойчив к горизонтальному дрейфу каруселей; для rect-таргетов
        // сэмплируем колонки внутри rect и выдаём позиции в системе rect
        // (0..100 rect) — стопы применяются к градиенту элемента как есть
        const levels = columnProfileLevels(
            refData,
            PROFILE_COUNT,
            axisRect !== undefined ? { x0: zx0, y0: zy0, x1: zx1, y1: zy1 } : undefined
        );
        const steps = detectSteps(
            levels.map((lv, i) => ({ pos: (i / Math.max(1, levels.length - 1)) * 100, level: lv }))
        );
        transitions = steps.map(({ pos, level: lv }) => ({ pos, level: lv }));
        const positions: number[] = [0];
        for (const tr of transitions) {
            if (tr.pos - positions[positions.length - 1] >= MIN_STOP_GAP && tr.pos < 100) {
                positions.push(tr.pos);
            }
        }
        positions.push(100);
        suggestedStops = positions.slice(0, 12).map((pos) => {
            const idx = Math.min(levels.length - 1, Math.round((pos / 100) * (levels.length - 1)));
            const lv = levels[idx];
            if (maskTarget) return { pos, alpha: round2(lv / 255) };
            const gray = round0(lv);
            return { pos, color: rgbToHex(gray, gray, gray) };
        });
    } else {
        const steps = detectSteps(refSamples.map((s) => ({ pos: s.t * 100, level: level(s) })));
        transitions = steps.map(({ pos, level: lv }) => ({ pos, level: lv }));
        // предлагаемые стопы: края + позиции ступеней; значения — из референса
        const positions: number[] = [0];
        for (const tr of transitions) {
            if (tr.pos - positions[positions.length - 1] >= MIN_STOP_GAP && tr.pos < 100) {
                positions.push(tr.pos);
            }
        }
        positions.push(100);
        suggestedStops = positions.slice(0, 12).flatMap((pos): AnalysisSuggestedStop[] => {
            const s = sampleAt(refSamples, pos);
            if (s === null) return [];
            if (maskTarget || hasTransparency) {
                return [{ pos, alpha: round2(level(s) / 255) }];
            }
            return [{ pos, color: rgbToHex(s.r, s.g, s.b) }];
        });
    }

    // классификация остатков: кромки / зона blur / уровень + вердикт; в колонковом
    // режиме позиции residual (ось градиента) и ступени (ось X) живут в разных
    // системах координат — классификацию честно помечаем приблизительной (approx)
    let coverage: { c0: number; c1: number } | null = null;
    if (state.blur.enabled) {
        if (axisSpace === 'block') {
            coverage = rectCoverageOnAxis(
                state.blur.rect,
                { x: 0, y: 0, w: W, h: H },
                axisGradient?.type === 'linear' ? axisGradient.angle : 180
            );
        } else if (axisSpace === 'blur.rect') {
            // ось уже живёт внутри blur.rect — вся она «зона blur»
            coverage = { c0: 0, c1: 100 };
        } else if (axisSpace === 'layer.rect' && axisRect !== undefined && axisBox !== undefined) {
            // ось живёт в системе rect слоя: переводим blur.rect (% блока) в %
            // этой системы и проецируем на ось — классификация «зона blur»
            // продолжает работать для слоя с частичным rect
            const rel = {
                x: ((state.blur.rect.x - axisRect.x) / axisRect.w) * 100,
                y: ((state.blur.rect.y - axisRect.y) / axisRect.h) * 100,
                w: (state.blur.rect.w / axisRect.w) * 100,
                h: (state.blur.rect.h / axisRect.h) * 100,
            };
            coverage = rectCoverageOnAxis(
                rel,
                axisBox,
                axisGradient?.type === 'linear' ? axisGradient.angle : 180
            );
        }
    }
    const kinds: AnalysisResidual['kind'][] =
        opts.profile === 'columns'
            ? axis.map((): AnalysisResidual['kind'] => 'approx')
            : classifyResiduals(axis, coverage);
    const residuals: AnalysisResidual[] = [];
    for (let i = 0; i < axis.length; i++) {
        if (axis[i].err > tolerance) {
            residuals.push({ pos: axis[i].pos, err: axis[i].err, kind: kinds[i] });
        }
    }

    // знаменатель — только учтённые пиксели; полностью прозрачный got —
    // сравнивать нечего, считаем полным совпадением
    const matchPercent = accounted > 0 ? round1((matched / accounted) * 100) : 100;
    return {
        data: {
            matchPercent,
            zoneMatchPercent:
                zoneTotal > 0 ? round1((zoneMatched / zoneTotal) * 100) : matchPercent,
            // зона целиком в клипнутом углу (zoneTotal = 0): zoneMatchPercent
            // молча подставляет глобальный matchPercent — помечаем фолбэк
            ...(zoneTotal > 0 ? {} : { zoneFallback: true }),
            maxError: round0(maxError),
            tolerance,
            target: targetToKey(target),
            // фактический профиль сэмплирования: 'rays' честен на обоих типах
            // таргета (лучи radial / параллельные линии linear — raysProfile
            // покрывает оба), иначе осевой или колонковый
            profile: raysProfile ? 'rays' : opts.profile === 'columns' ? 'columns' : 'axis',
            axisSpace,
            zone: {
                x: round1(zone.x),
                y: round1(zone.y),
                w: round1(zone.w),
                h: round1(zone.h),
            },
            axis,
            transitions,
            suggestedStops,
            residuals,
            verdict: buildVerdict(residuals, tolerance),
            updatedAt: Date.now(),
        },
        diff,
    };
}
