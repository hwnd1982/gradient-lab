/**
 * Юнит-тесты diff-анализа (src/lib/analysis.ts + autofit-сэмплеры):
 * document-мок с минимальным 2D-контекстом (fillRect + roundRect-клип,
 * drawImage только 3/5-арг — прочие арности кидают, ImageData), импорт
 * TS как есть через jiti. Контракт раннера — tests/run.mjs (npm test).
 *
 * Группы:
 * 1) got с radius-клипом vs ref с мусорными углами: прозрачные got-пиксели
 *    (α < 8) выпадают из метрик — углы не в residuals, matchPercent выше,
 *    чем без клипа; 2) реальное расхождение внутри зоны клипом не
 *    маскируется; 3) linear-rays: 8 параллельных линий, медиана; мусорная
 *    ось-линия игнорируется; 4) radial-лучи: фантом-фикс агрегата — выбывание
 *    ≤3/8 лучей не двигает медиану, позиции полного выбывания исключены;
 * 5) зона: got α<8 внутри зоны не считается, пустая зона — zoneFallback.
 */
import { createJiti } from 'jiti';

const ROOT = new URL('..', import.meta.url).pathname;
const jiti = createJiti(import.meta.url);

export let total = 0;
export let failed = 0;
function check(name, cond, extra = '') {
    total += 1;
    if (cond) console.log(`ok   ${name}`);
    else {
        failed += 1;
        console.error(`FAIL ${name} ${extra}`);
    }
}

// ── document/canvas-мок: только то, что реально трогают analysis/autofit ──
class MockImageData {
    constructor(w, h) {
        this.width = w;
        this.height = h;
        this.data = new Uint8ClampedArray(w * h * 4);
    }
}

function parseColor(str) {
    if (typeof str !== 'string' || !/^#[0-9a-f]{6}$/i.test(str)) {
        throw new Error(`mock: fillStyle не поддерживается: ${str}`);
    }
    return [
        parseInt(str.slice(1, 3), 16),
        parseInt(str.slice(3, 5), 16),
        parseInt(str.slice(5, 7), 16),
        255,
    ];
}

/** Центр пикселя внутри roundRect-пути (semantics canvas roundRect). */
function insidePath(p, px, py) {
    const { x, y, w, h } = p;
    const r = Math.max(0, Math.min(p.r, w / 2, h / 2));
    if (px < x || px > x + w || py < y || py > y + h) return false;
    if (r <= 0) return true;
    const nx = px < x + r ? x + r : px > x + w - r ? x + w - r : px;
    const ny = py < y + r ? y + r : py > y + h - r ? y + h - r : py;
    return (px - nx) ** 2 + (py - ny) ** 2 <= r * r;
}

function blendOver(dst, i, r, g, b, a) {
    const da = dst[i + 3];
    const oa = a + (da * (255 - a)) / 255;
    if (oa > 0) {
        dst[i] = (r * a + dst[i] * da * (1 - a / 255)) / oa;
        dst[i + 1] = (g * a + dst[i + 1] * da * (1 - a / 255)) / oa;
        dst[i + 2] = (b * a + dst[i + 2] * da * (1 - a / 255)) / oa;
    }
    dst[i + 3] = oa;
}

class MockCtx {
    constructor(canvas) {
        this.canvas = canvas;
        this.fillStyle = '#000000';
        this.globalAlpha = 1;
        this.globalCompositeOperation = 'source-over';
        this.filter = 'none';
        this.imageSmoothingEnabled = true;
        this._transform = [1, 0, 0, 1, 0, 0];
        this._clip = null;
        this._pending = null;
        this._stack = [];
    }
    save() {
        this._stack.push({
            fillStyle: this.fillStyle,
            alpha: this.globalAlpha,
            op: this.globalCompositeOperation,
            filter: this.filter,
            transform: [...this._transform],
            clip: this._clip,
        });
    }
    restore() {
        const s = this._stack.pop();
        if (s === undefined) return;
        this.fillStyle = s.fillStyle;
        this.globalAlpha = s.alpha;
        this.globalCompositeOperation = s.op;
        this.filter = s.filter;
        this._transform = s.transform;
        this._clip = s.clip;
    }
    beginPath() {
        this._pending = null;
    }
    roundRect(x, y, w, h, r) {
        this._pending = { x, y, w, h, r };
    }
    rect(x, y, w, h) {
        this._pending = { x, y, w, h, r: 0 };
    }
    clip() {
        this._clip = this._pending;
        this._pending = null;
    }
    setTransform(a, b, c, d, e, f) {
        this._transform = [a, b, c, d, e, f];
    }
    translate(tx, ty) {
        const [a, b, c, d, e, f] = this._transform;
        this._transform = [a, b, c, d, e + a * tx + c * ty, f + b * tx + d * ty];
    }
    scale(sx, sy) {
        const [a, b, c, d] = this._transform;
        this._transform = [a * sx, b * sx, c * sy, d * sy, this._transform[4], this._transform[5]];
    }
    fillRect(x, y, w, h) {
        const [r, g, b, a] = parseColor(this.fillStyle);
        const A = (a * this.globalAlpha) / 255;
        for (let py = Math.max(0, Math.floor(y)); py < Math.min(this.canvas.height, y + h); py++) {
            for (
                let px = Math.max(0, Math.floor(x));
                px < Math.min(this.canvas.width, x + w);
                px++
            ) {
                if (this._clip !== null && !insidePath(this._clip, px + 0.5, py + 0.5)) continue;
                blendOver(this.canvas._data, (py * this.canvas.width + px) * 4, r, g, b, A * 255);
            }
        }
    }
    createLinearGradient() {
        throw new Error('mock: градиенты не поддерживаются (тест на плоских цветах)');
    }
    createRadialGradient() {
        throw new Error('mock: градиенты не поддерживаются (тест на плоских цветах)');
    }
    drawImage(src, dx, dy, dw = src.width, dh = src.height) {
        // поддержаны только 3- и 5-арг формы: 9-арг (src-рект, edgeStretch)
        // молча съедался бы в неверную отрисовку — кричим сразу
        if (arguments.length !== 3 && arguments.length !== 5) {
            throw new Error(`mock: drawImage ${arguments.length} аргументов не поддерживается`);
        }
        const [a, b, c, d, e, f] = this._transform;
        if (b !== 0 || c !== 0) throw new Error('mock: только translate/scale');
        const X = a * dx + e;
        const Y = d * dy + f;
        const W = a * dw;
        const H = d * dh;
        if (W <= 0 || H <= 0) return;
        for (let py = Math.max(0, Math.floor(Y)); py < Math.min(this.canvas.height, Y + H); py++) {
            for (
                let px = Math.max(0, Math.floor(X));
                px < Math.min(this.canvas.width, X + W);
                px++
            ) {
                if (this._clip !== null && !insidePath(this._clip, px + 0.5, py + 0.5)) continue;
                const sx = Math.min(src.width - 1, Math.floor(((px - X) / W) * src.width));
                const sy = Math.min(src.height - 1, Math.floor(((py - Y) / H) * src.height));
                const si = (sy * src.width + sx) * 4;
                blendOver(
                    this.canvas._data,
                    (py * this.canvas.width + px) * 4,
                    src._data[si],
                    src._data[si + 1],
                    src._data[si + 2],
                    src._data[si + 3]
                );
            }
        }
    }
    getImageData(x, y, w, h) {
        const img = new MockImageData(w, h);
        for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
                const si = ((y + py) * this.canvas.width + (x + px)) * 4;
                const di = (py * w + px) * 4;
                for (let k = 0; k < 4; k++) img.data[di + k] = this.canvas._data[si + k];
            }
        }
        return img;
    }
    putImageData(img, dx, dy) {
        for (let py = 0; py < img.height; py++) {
            for (let px = 0; px < img.width; px++) {
                const di = ((dy + py) * this.canvas.width + (dx + px)) * 4;
                const si = (py * img.width + px) * 4;
                for (let k = 0; k < 4; k++) this.canvas._data[di + k] = img.data[si + k];
            }
        }
    }
    createImageData(w, h) {
        return new MockImageData(w, h);
    }
}

class MockCanvas {
    constructor(w = 300, h = 150) {
        this.width = w;
        this.height = h;
        this._data = new Uint8ClampedArray(w * h * 4);
        this._ctx = null;
    }
    getContext() {
        return (this._ctx ??= new MockCtx(this));
    }
}

globalThis.document = {
    createElement(tag) {
        if (tag === 'canvas') return new MockCanvas();
        throw new Error(`mock: createElement(${tag})`);
    },
};
globalThis.ImageData = MockImageData;

const { computeAnalysis } = await jiti.import(`${ROOT}src/lib/analysis.ts`);
const { sampleAlongLinear, sampleAlongLinearRays, sampleAlongRadialRays } = await jiti.import(
    `${ROOT}src/lib/autofit.ts`
);
const { defaultBlockState } = await jiti.import(`${ROOT}src/schema.ts`);

const BASE = [46, 110, 94]; // #2e6e5e
const GARBAGE = [255, 0, 0];
const R = 25; // radius-клип got
const W = 100;
const H = 100;
const roundPath = { x: 0, y: 0, w: W, h: H, r: R };

/** ref-канвас: внутри клипа BASE, снаружи — мусор (или своя перекраска). */
function makeRef(paint) {
    const c = new MockCanvas(W, H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const [r, g, b] = paint(x, y, insidePath(roundPath, x + 0.5, y + 0.5));
            c._data[i] = r;
            c._data[i + 1] = g;
            c._data[i + 2] = b;
            c._data[i + 3] = 255;
        }
    }
    return c;
}

function makeState(radius) {
    const s = defaultBlockState();
    s.w = W;
    s.h = H;
    s.radius = radius;
    s.base.kind = 'color';
    s.base.color = '#2e6e5e';
    s.compare.refImage = 'mock'; // computeAnalysis не читает, для чистоты стейта
    return s;
}

// ── 1. дифф игнорирует прозрачные got-пиксели (клип radius) ──
{
    const ref = makeRef((x, y, inside) => (inside ? BASE : GARBAGE));
    const target = { kind: 'base' }; // линейный таргет: base.gradient 180deg

    const withClip = (await computeAnalysis(makeState(R), target, ref, { profile: 'rays' })).data;
    check(
        'клип: matchPercent = 100 (углы ref-мусора выпали из знаменателя)',
        withClip.matchPercent === 100,
        `match=${withClip.matchPercent}`
    );
    check('клип: maxError = 0', withClip.maxError === 0, `maxErr=${withClip.maxError}`);
    check(
        'клип: углы не в residuals (got за клипом α<8 — не остаток)',
        withClip.residuals.length === 0,
        JSON.stringify(withClip.residuals.slice(0, 3))
    );
    check('клип: зона тоже без штрафа', withClip.zoneMatchPercent === 100);
    check(
        'профиль rays честен на linear-таргете',
        withClip.profile === 'rays' && withClip.axisSpace === 'block'
    );

    const noClip = (await computeAnalysis(makeState(0), target, ref, { profile: 'rays' })).data;
    check(
        'без клипа: matchPercent ниже (углы считаются)',
        noClip.matchPercent < withClip.matchPercent && noClip.matchPercent > 90,
        `match=${noClip.matchPercent}`
    );
    check(
        'без клипа: maxError видит мусор углов',
        noClip.maxError > 100,
        `maxErr=${noClip.maxError}`
    );
    check(
        'без клипа: углы попадают в residuals (пара pos 0/100)',
        noClip.residuals.length > 0 && noClip.residuals.some((r) => r.pos <= 1 || r.pos >= 99),
        JSON.stringify(noClip.residuals.map((r) => r.pos))
    );

    const axisMode = (await computeAnalysis(makeState(R), target, ref, { profile: 'axis' })).data;
    check('профиль axis остаётся собой', axisMode.profile === 'axis');
}

// ── 2. реальное расхождение внутри зоны клипом НЕ маскируется ──
{
    // красная полоса y∈[40,45) на всю ширину — внутри клипа
    const ref = makeRef((x, y, inside) => (!inside || (y >= 40 && y < 45) ? GARBAGE : BASE));
    const { data } = await computeAnalysis(makeState(R), { kind: 'base' }, ref, {
        profile: 'rays',
    });
    check('полоса: matchPercent < 100', data.matchPercent < 100, `match=${data.matchPercent}`);
    check('полоса: maxError > 100', data.maxError > 100, `maxErr=${data.maxError}`);
    check(
        'полоса: остатки в зоне полосы (pos 35..50)',
        data.residuals.length > 0 && data.residuals.every((r) => r.pos >= 35 && r.pos <= 50),
        JSON.stringify(data.residuals.map((r) => r.pos))
    );
}

// ── 3. linear-rays: 8 параллельных линий, медиана; ось-линия игнорируется ──
{
    // канвас: серый = номер ряда; ось при angle 90 — горизонталь y=50,
    // ряд 50 замусорен белым. Линии лучей на y = 6.25..93.75 (floor
    // 6,18,31,43,56,68,81,93) → медиана серых = (43+56)/2 = 49.5
    const c = new MockCanvas(W, H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const v = y === 50 ? 255 : y;
            const i = (y * W + x) * 4;
            c._data[i] = v;
            c._data[i + 1] = v;
            c._data[i + 2] = v;
            c._data[i + 3] = 255;
        }
    }
    const opts = { block: { w: W, h: H }, compare: { x: 0, y: 0, scale: 1 }, angle: 90 };
    const rays = sampleAlongLinearRays(c, opts);
    check('rays: 64 сэмпла по оси', rays.length === 64 && rays[63].t === 1);
    check(
        'rays: медиана 8 линий = 49.5 (ряды 6..93, мусор вне медианы)',
        rays.every((s) => s.r === 49.5 && s.g === 49.5 && s.b === 49.5 && s.a === 255),
        `r=${rays[0].r}`
    );
    const axis = sampleAlongLinear(c, opts);
    check(
        'ось-линия одна и видит мусор (255) — лучи её игнорируют',
        axis.every((s) => s.r === 255)
    );
    // мусор в крайней линии (ряд 93 — максимум): медианная пара не двигается
    const px = (x, y, v) => {
        const i = (y * W + x) * 4;
        c._data[i] = v;
        c._data[i + 1] = v;
        c._data[i + 2] = v;
    };
    for (let x = 0; x < W; x++) px(x, 93, 255);
    check(
        'rays: мусор в крайней линии не двигает медиану (49.5)',
        sampleAlongLinearRays(c, opts).every((s) => s.r === 49.5)
    );
    // мусор в 3 линиях из 8 (меньшинство): медиана — чистое значение 87
    // (пара 81+93 из оставшихся чистых линий), не 255
    for (let x = 0; x < W; x++) {
        px(x, 93, 93);
        px(x, 6, 255);
        px(x, 18, 255);
        px(x, 31, 255);
    }
    check(
        'rays: мусор в 3/8 линий — медиана чистая (87)',
        sampleAlongLinearRays(c, opts).every((s) => s.r === 87)
    );
}

// ── 4. radial-лучи: фантом-фикс агрегата (позиции полного выбывания) ──
{
    // круг r=50 из центра, везде серый 120/α255; дырка r<5 у центра — там
    // выбывают ВСЕ лучи (позиция обязана исчезнуть, а не стать {a:0});
    // полуполосы вдоль лучей 0°/45°/90° за r>10 прозрачны — выбывают 3 из 8,
    // медиана из 5 чистых лучей не двигается
    const c = new MockCanvas(W, H);
    const garbageRays = [0, 1, 2].map((k) => ({
        dx: Math.cos((k * Math.PI) / 4),
        dy: Math.sin((k * Math.PI) / 4),
    }));
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const vx = x + 0.5 - 50;
            const vy = y + 0.5 - 50;
            const r = Math.hypot(vx, vy);
            const band =
                r > 10 &&
                garbageRays.some(
                    ({ dx, dy }) => Math.abs(vx * dy - vy * dx) < 3 && vx * dx + vy * dy > 0
                );
            const i = (y * W + x) * 4;
            c._data[i] = 120;
            c._data[i + 1] = 120;
            c._data[i + 2] = 120;
            c._data[i + 3] = r < 5 || band ? 0 : 255;
        }
    }
    const rays = sampleAlongRadialRays(c, {
        block: { w: W, h: H },
        compare: { x: 0, y: 0, scale: 1 },
        cx: 50,
        cy: 50,
        shape: 'ellipse',
        size: 'explicit',
        rx: 50,
        ry: 50,
        rays: 8,
        dropAlphaBelow: 8,
    });
    check(
        'radial rays: выбывание 3/8 лучей не двигает медиану (серый 120, α255)',
        rays.every((s) => s.r === 120 && s.g === 120 && s.b === 120 && s.a === 255),
        `r0=${rays[0]?.r} a0=${rays[0]?.a}`
    );
    check(
        'radial rays: полное выбывание — позиция исключена (нет фантомных {a:0})',
        rays.length < 64 && rays[0].t > 0,
        `n=${rays.length} t0=${rays[0]?.t}`
    );
}

// ── 5. зона: got α<8 внутри зоны не считается; пустая зона — zoneFallback ──
{
    // blurBg-таргет (зона = blur.rect в углу), blur.radius 0 и без заливок —
    // рендер blur ничего не рисует, зона живёт только в метриках
    const ref = makeRef((x, y, inside) => (inside ? BASE : GARBAGE));
    const s = makeState(R);
    s.blur.enabled = true;
    s.blur.radius = 0;
    s.blur.rect = { x: 0, y: 0, w: 25, h: 25 };
    const part = (await computeAnalysis(s, { kind: 'blurBg' }, ref)).data;
    check(
        'зона: got α<8 в зоне не считается (мусор клипнутого угла не роняет zoneMatch)',
        part.zoneMatchPercent === 100 && part.zoneFallback === undefined,
        `zone=${part.zoneMatchPercent} fallback=${part.zoneFallback}`
    );

    // зона ЦЕЛИКОМ в клипнутом углу (6×6 при radius 25): учтённых пикселей
    // в зоне нет → zoneFallback: true, zoneMatchPercent = глобальному
    const ref2 = makeRef((x, y, inside) => (!inside || (y >= 40 && y < 45) ? GARBAGE : BASE));
    const s2 = makeState(R);
    s2.blur.enabled = true;
    s2.blur.radius = 0;
    s2.blur.rect = { x: 0, y: 0, w: 6, h: 6 };
    const empty = (await computeAnalysis(s2, { kind: 'blurBg' }, ref2)).data;
    check(
        'пустая зона: zoneFallback=true, zoneMatchPercent = matchPercent (< 100)',
        empty.zoneFallback === true &&
            empty.zoneMatchPercent === empty.matchPercent &&
            empty.matchPercent < 100,
        `zone=${empty.zoneMatchPercent} match=${empty.matchPercent} fallback=${empty.zoneFallback}`
    );
}
