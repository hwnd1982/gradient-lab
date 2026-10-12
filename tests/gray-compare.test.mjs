/**
 * Тест серого режима сравнения (compare.mode = 'gray', PerfectPixel-стек из
 * CompareOverlay: ref с mix-blend-mode: difference + плашка #808080 с
 * difference). html2canvas не нужен: браузерный difference-композит для
 * непрозрачных слоёв — это по-канальный |backdrop − source|, воспроизводим
 * его на мок-канве (fillRect с globalCompositeOperation) и сверяем с чистой
 * формулой |128 − |B − R||: совпадение = ровно #808080, любое отклонение —
 * строго темнее серого на 128 − |d − 128| (V-форма: d=0 → серый, d=128 →
 * чёрный, d=255 → почти серый; «ярче серого» не бывает). Импорт TS — jiti
 * (см. tests/run.mjs).
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

/** Мок 2D-контекста: буфер RGBA + fillRect с source-over / difference. */
class MockCtx {
    constructor(w, h) {
        this.w = w;
        this.h = h;
        this.buf = new Uint8ClampedArray(w * h * 4);
        this.globalCompositeOperation = 'source-over';
        this.fillStyle = '#000000';
    }

    parseColor() {
        const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(this.fillStyle);
        if (m === null) throw new Error(`мок не умеет цвет ${this.fillStyle}`);
        return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    }

    fillRect() {
        const src = this.parseColor();
        for (let i = 0; i < this.buf.length; i += 4) {
            if (this.globalCompositeOperation === 'difference') {
                // CSS mix-blend-mode: difference, непрозрачные слои
                this.buf[i] = Math.abs(this.buf[i] - src[0]);
                this.buf[i + 1] = Math.abs(this.buf[i + 1] - src[1]);
                this.buf[i + 2] = Math.abs(this.buf[i + 2] - src[2]);
            } else {
                this.buf[i] = src[0];
                this.buf[i + 1] = src[1];
                this.buf[i + 2] = src[2];
            }
            this.buf[i + 3] = 255;
        }
    }

    pixel(i) {
        return [this.buf[i * 4], this.buf[i * 4 + 1], this.buf[i * 4 + 2]];
    }
}

/** Стек серого режима на мок-канве: блок → ref (difference) → #808080 (difference). */
function grayStack(block, ref) {
    const c = new MockCtx(1, 1);
    c.fillStyle = block;
    c.fillRect();
    c.globalCompositeOperation = 'difference';
    c.fillStyle = ref;
    c.fillRect();
    c.fillStyle = '#808080';
    c.fillRect();
    return c.pixel(0);
}

/** Чистая формула того же стека: |128 − |B − R|| по каждой канале. */
function formula(block, ref) {
    const b = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(block);
    const r = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(ref);
    return [0, 1, 2].map((i) =>
        Math.abs(128 - Math.abs(parseInt(b[i + 1], 16) - parseInt(r[i + 1], 16)))
    );
}

const eq = (a, b) => a.every((v, i) => v === b[i]);

// совпадение блока и референса — ровно серый #808080 (128)
check('gray: совпадение → ровно 128 серый', eq(grayStack('#3c6e47', '#3c6e47'), [128, 128, 128]));

// малое отклонение — темнее серого на d; знак Δ невосстановим (±10 → оба 118)
check('gray: ref светлее на 10 → 118', eq(grayStack('#404040', '#4a4a4a'), [118, 118, 118]));
check('gray: ref темнее на 10 → 118', eq(grayStack('#4a4a4a', '#404040'), [118, 118, 118]));

// большое отклонение (|d| > 128) — ТОЖЕ темнее серого («ярче серого» не
// бывает: max 128 при совпадении); V-форма: |d|=128 → 0 (чёрный), |d|=255 →
// 127 (почти серый) — знак Δ и величина ближе к краям диапазона не видны
check('gray: |d|=192 → 64 (темнее серого)', eq(grayStack('#303030', '#f0f0f0'), [64, 64, 64]));

// поканальные отклонения считаются независимо
check(
    'gray: поканально (144/160/0 → 16/32/128)',
    eq(grayStack('#12c89b', '#a2289b'), [16, 32, 128])
);

// стек мока == чистая формула на наборе пар
const PAIRS = [
    ['#000000', '#000000'],
    ['#ffffff', '#7f7f7f'],
    ['#123456', '#654321'],
    ['#808080', '#808080'],
    ['#0a141e', '#e8d5c0'],
];
for (const [b, r] of PAIRS) {
    check(`gray: мок == формула |128−|B−R|| на ${b}/${r}`, eq(grayStack(b, r), formula(b, r)));
}

// порядок слоёв важен: плашка ДО референса совпадение серым не даёт
{
    const c = new MockCtx(1, 1);
    c.fillStyle = '#3c6e47';
    c.fillRect();
    c.globalCompositeOperation = 'difference';
    c.fillStyle = '#808080';
    c.fillRect();
    c.fillStyle = '#3c6e47';
    c.fillRect();
    check('gray: плашка после ref (порядок стека) — не серый', !eq(c.pixel(0), [128, 128, 128]));
}

// CompareSpec: режим 'gray' валиден схемой (enum), остальные на месте
const { CompareSpecSchema } = await jiti.import(`${ROOT}src/schema.ts`);
check(
    'schema: compare.mode enum принимает gray',
    CompareSpecSchema.safeParse({
        refImage: null,
        mode: 'gray',
        opacity: 0.5,
        x: 0,
        y: 0,
        scale: 1,
        splitPos: 50,
        splitDir: 'vertical',
        tolerance: 10,
    }).success
);
check(
    'schema: compare.mode режет левый режим',
    !CompareSpecSchema.safeParse({
        refImage: null,
        mode: 'perfect',
        opacity: 0.5,
        x: 0,
        y: 0,
        scale: 1,
        splitPos: 50,
        splitDir: 'vertical',
        tolerance: 10,
    }).success
);
