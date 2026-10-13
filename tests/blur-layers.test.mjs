/**
 * Юнит-тесты слоёв backdrop-blur (до двух, blur.layers[]): миграция плоского
 * легаси-формата через zod-preprocess, границы схемы (3 слоя — ошибка),
 * экспорт CSS/Sass (1 слой — байт-в-байт как до слоёв, 2 слоя — оба
 * элемента в DOM-порядке), хелпер жёсткой кромки (src/lib/blurEdges.ts),
 * layer-aware таргеты (ключи blurMask:N/blurBg:N) и резолв журнальных
 * α-стопов blur-семьи в hint. Импорт TS — jiti (см. tests/run.mjs).
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

const { BlockStateSchema, AnalysisSchema, defaultBlockState, defaultBlurLayer, uid } =
    await jiti.import(`${ROOT}src/schema.ts`);
const { stateToCssText, stateToSassText } = await jiti.import(`${ROOT}src/cssgen.ts`);
const { blurEdgeIssues, blurEdgeWarnings } = await jiti.import(`${ROOT}src/lib/blurEdges.ts`);
const { computeHint } = await jiti.import(`${ROOT}src/lib/hint.ts`);
const { targetToKey, targetFromString, readGradient, assignGradient, targetAxisRect } =
    await jiti.import(`${ROOT}src/targets.ts`);

const lin = (angle, stops) => ({ type: 'linear', angle, repeating: false, stops });

// ── 1. миграция плоского легаси-формата (zod-preprocess → layers[0]) ──
{
    const legacyOn = defaultBlockState();
    const flat = {
        enabled: true,
        radius: 18,
        background: 'rgba(0, 0, 0, 0.3)',
        gradient: lin(90, [
            { id: 'g1', pos: 0, color: '#101010', alpha: 0.2 },
            { id: 'g2', pos: 100, color: '#101010', alpha: 0 },
        ]),
        mask: lin(0, [
            { id: 'm1', pos: 0, color: '#000000', alpha: 1 },
            { id: 'm2', pos: 100, color: '#000000', alpha: 0 },
        ]),
        rect: { x: 0, y: 50, w: 100, h: 50 },
    };
    legacyOn.blur = flat;
    const parsedOn = BlockStateSchema.safeParse(legacyOn);
    check('миграция: старый blur (enabled) валиден', parsedOn.success);
    const b = parsedOn.success ? parsedOn.data.blur : null;
    check(
        'миграция: плоские поля завернуты в layers[0]',
        b !== null &&
            b.layers.length === 1 &&
            b.layers[0].radius === 18 &&
            b.layers[0].background === 'rgba(0, 0, 0, 0.3)' &&
            b.layers[0].gradient.stops[0].alpha === 0.2 &&
            b.layers[0].mask.stops[0].alpha === 1 &&
            b.layers[0].rect.y === 50 &&
            b.layers[0].visible === true &&
            b.enabled === true,
        JSON.stringify(b?.layers?.[0] ?? null)
    );
    check(
        'миграция: плоских полей в результате нет (канонический формат)',
        b !== null && !('radius' in b) && !('mask' in b) && !('rect' in b)
    );

    // выключенный blur тоже заворачивается: при включении тумблера слой готов
    const legacyOff = defaultBlockState();
    legacyOff.blur = { ...flat, enabled: false };
    const parsedOff = BlockStateSchema.safeParse(legacyOff);
    check(
        'миграция: старый blur (disabled) тоже заворачивается в layers[0]',
        parsedOff.success &&
            parsedOff.data.blur.layers.length === 1 &&
            parsedOff.data.blur.layers[0].radius === 18 &&
            parsedOff.data.blur.enabled === false
    );

    // старый формат без опциональных полей (gradient/rect были с дефолтами)
    const legacyMin = defaultBlockState();
    legacyMin.blur = { enabled: false, radius: 24, background: null, mask: null };
    const parsedMin = BlockStateSchema.safeParse(legacyMin);
    check(
        'миграция: минимум старых полей — дефолты слоя на месте',
        parsedMin.success &&
            parsedMin.data.blur.layers[0].gradient === null &&
            parsedMin.data.blur.layers[0].rect.w === 100
    );

    // новый формат с layers не трогается preprocess-ом
    const native = defaultBlockState();
    native.blur = {
        enabled: true,
        layers: [defaultBlurLayer()],
        underlay: native.blur.underlay,
    };
    const parsedNative = BlockStateSchema.safeParse(native);
    check(
        'схема: новый формат с layers валиден как есть',
        parsedNative.success && parsedNative.data.blur.layers[0].radius === 24
    );

    // стейт-мусор: layers И плоские легаси-ключи вместе — preprocess не
    // заворачивает (layers уже есть), zod strip молча отбрасывает плоские
    const mixed = defaultBlockState();
    const mixLayer = defaultBlurLayer();
    mixed.blur = {
        enabled: true,
        layers: [mixLayer],
        radius: 33,
        background: 'rgba(0, 0, 0, 0.5)',
        mask: lin(0, [
            { id: uid(), pos: 0, color: '#000000', alpha: 1 },
            { id: uid(), pos: 100, color: '#000000', alpha: 0 },
        ]),
        rect: { x: 0, y: 40, w: 100, h: 60 },
        underlay: mixed.blur.underlay,
    };
    const parsedMixed = BlockStateSchema.parse(mixed);
    check(
        'схема: layers + плоские легаси-ключи — канонично по layers, плоские отброшены',
        parsedMixed.blur.layers.length === 1 &&
            parsedMixed.blur.layers[0].id === mixLayer.id &&
            parsedMixed.blur.layers[0].radius === 24 &&
            !('radius' in parsedMixed.blur) &&
            !('background' in parsedMixed.blur) &&
            !('mask' in parsedMixed.blur) &&
            !('rect' in parsedMixed.blur)
    );
}

// ── 2. границы схемы: 3 слоя — ошибка; дефолтный стейт валиден ──
{
    const three = defaultBlockState();
    three.blur = {
        enabled: true,
        layers: [defaultBlurLayer(), defaultBlurLayer(), defaultBlurLayer()],
        underlay: three.blur.underlay,
    };
    check(
        'схема: 3 слоя blur — ошибка валидации',
        !BlockStateSchema.safeParse(three).success
    );
    const parsedDefault = BlockStateSchema.safeParse(defaultBlockState());
    check(
        'схема: defaultBlockState валиден (чистый холст, layers=[])',
        parsedDefault.success && parsedDefault.data.blur.layers.length === 0
    );
}

// ── 3. cssgen: 1 слой — байт-в-байт как до слоёв (зафиксированный вывод) ──
const BASE_A_CSS = `.gradient-block {
    position: relative;
    width: 360px;
    height: 480px;
    border-radius: 24px;
    overflow: hidden;
    isolation: isolate;
    background-color: #101010;
}

/* подложка затемнения под blur (::before): без блюра и маски, своя область */
.gradient-block__blur-underlay {
    position: absolute;
    left: 0%;
    top: 0%;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.45);
}

/* blur-слой: ограниченная область + фон + блюр + маска на одном элементе */
.gradient-block__blur {
    position: absolute;
    left: 0%;
    top: 0%;
    width: 100%;
    height: 100%;
    -webkit-backdrop-filter: blur(20px);
    backdrop-filter: blur(20px);
    background: linear-gradient(0deg, rgba(16, 16, 16, 0.4) 0%, rgba(16, 16, 16, 0) 100%);
    -webkit-mask-image: linear-gradient(0deg, rgba(0, 0, 0, 1) 0%, rgba(0, 0, 0, 1) 60%, rgba(0, 0, 0, 0) 100%);
    mask-image: linear-gradient(0deg, rgba(0, 0, 0, 1) 0%, rgba(0, 0, 0, 1) 60%, rgba(0, 0, 0, 0) 100%);
}
`;
const BASE_A_SASS = `$blur-bg: linear-gradient(0deg, rgba(16, 16, 16, 0.4) 0%, rgba(16, 16, 16, 0) 100%)
$blur-mask: linear-gradient(0deg, rgba(0, 0, 0, 1) 0%, rgba(0, 0, 0, 1) 60%, rgba(0, 0, 0, 0) 100%)

.gradient-block
    position: relative
    width: 360px
    height: 480px
    border-radius: 24px
    overflow: hidden
    isolation: isolate
    background-color: #101010

    // подложка затемнения под blur (::before): без блюра и маски, своя область
    &__blur-underlay
        position: absolute
        left: 0%
        top: 0%
        width: 100%
        height: 100%
        background: rgba(0, 0, 0, 0.45)

    // blur-слой: ограниченная область + фон + блюр + маска на одном элементе
    &__blur
        position: absolute
        left: 0%
        top: 0%
        width: 100%
        height: 100%
        -webkit-backdrop-filter: blur(20px)
        backdrop-filter: blur(20px)
        background: $blur-bg
        -webkit-mask-image: $blur-mask
        mask-image: $blur-mask
`;
const BASE_B_CSS = `.gradient-block {
    position: relative;
    width: 360px;
    height: 480px;
    border-radius: 24px;
    overflow: hidden;
    isolation: isolate;
    background-color: #101010;
}

/* blur-слой: ограниченная область + фон + блюр + маска на одном элементе */
.gradient-block__blur {
    position: absolute;
    left: 0%;
    top: 68.75%;
    width: 100%;
    height: 31.25%;
    -webkit-backdrop-filter: blur(12.5px);
    backdrop-filter: blur(12.5px);
}
`;
const BASE_B_SASS = `
.gradient-block
    position: relative
    width: 360px
    height: 480px
    border-radius: 24px
    overflow: hidden
    isolation: isolate
    background-color: #101010

    // blur-слой: ограниченная область + фон + блюр + маска на одном элементе
    &__blur
        position: absolute
        left: 0%
        top: 68.75%
        width: 100%
        height: 31.25%
        -webkit-backdrop-filter: blur(12.5px)
        backdrop-filter: blur(12.5px)
`;

/** Кейс A/B одним слоем (нативный формат). */
function singleLayerState() {
    const s = defaultBlockState();
    s.w = 360;
    s.h = 480;
    s.blur.enabled = true;
    s.blur.layers = [
        {
            id: uid(),
            visible: true,
            radius: 20,
            background: 'rgba(255, 255, 255, 0.2)',
            gradient: lin(0, [
                { id: uid(), pos: 0, color: '#101010', alpha: 0.4 },
                { id: uid(), pos: 100, color: '#101010', alpha: 0 },
            ]),
            mask: lin(0, [
                { id: uid(), pos: 0, color: '#000000', alpha: 1 },
                { id: uid(), pos: 60, color: '#000000', alpha: 1 },
                { id: uid(), pos: 100, color: '#000000', alpha: 0 },
            ]),
            rect: { x: 0, y: 0, w: 100, h: 100 },
        },
    ];
    s.blur.underlay.enabled = true;
    s.blur.underlay.color = 'rgba(0, 0, 0, 0.45)';
    return s;
}

{
    const a = singleLayerState();
    check(
        'cssgen: 1 слой CSS — байт-в-байт как до слоёв (кейс A)',
        stateToCssText(a) === BASE_A_CSS
    );
    check(
        'cssgen: 1 слой Sass — байт-в-байт как до слоёв (кейс A)',
        stateToSassText(a) === BASE_A_SASS
    );

    // тот же кейс плоским легаси-форматом: миграция не меняет вывод
    const aLegacy = singleLayerState();
    const layer = aLegacy.blur.layers[0];
    aLegacy.blur = {
        enabled: true,
        radius: layer.radius,
        background: layer.background,
        gradient: layer.gradient,
        mask: layer.mask,
        rect: layer.rect,
        underlay: aLegacy.blur.underlay,
    };
    const aMigrated = BlockStateSchema.parse(aLegacy);
    check(
        'cssgen: легаси-стейт после миграции даёт тот же CSS',
        stateToCssText(aMigrated) === BASE_A_CSS
    );
    check(
        'cssgen: легаси-стейт после миграции даёт тот же Sass',
        stateToSassText(aMigrated) === BASE_A_SASS
    );

    // кейс B: частичный rect, без маски/заливки
    const b = defaultBlockState();
    b.w = 360;
    b.h = 480;
    b.blur.enabled = true;
    b.blur.layers = [
        {
            id: uid(),
            visible: true,
            radius: 12.5,
            background: null,
            gradient: null,
            mask: null,
            rect: { x: 0, y: 68.75, w: 100, h: 31.25 },
        },
    ];
    check('cssgen: 1 слой CSS — кейс B (частичный rect)', stateToCssText(b) === BASE_B_CSS);
    check('cssgen: 1 слой Sass — кейс B (частичный rect)', stateToSassText(b) === BASE_B_SASS);
}

// ── 4. cssgen: 2 слоя — оба элемента, DOM-порядок, комментарий о паре ──
{
    const s = singleLayerState();
    s.blur.layers.push({
        id: uid(),
        visible: true,
        radius: 50,
        background: null,
        gradient: null,
        mask: lin(90, [
            { id: uid(), pos: 0, color: '#000000', alpha: 1 },
            { id: uid(), pos: 100, color: '#000000', alpha: 0 },
        ]),
        rect: { x: 0, y: 0, w: 100, h: 40 },
    });
    const css = stateToCssText(s);
    const sass = stateToSassText(s);
    const blurPos = css.indexOf('.gradient-block__blur {');
    const blur2Pos = css.indexOf('.gradient-block__blur-2 {');
    check('cssgen: 2 слоя — оба класса в CSS', blurPos >= 0 && blur2Pos > blurPos);
    check(
        'cssgen: слой 0 раньше слоя 1 (слой 1 поверх в DOM)',
        blurPos >= 0 && blur2Pos > blurPos && css.includes('top: 0%;') && css.includes('height: 40%;')
    );
    check(
        'cssgen: комментарий о паре ::before/::after',
        css.includes('пара ::before/::after или два div') && sass.includes('пара ::before/::after')
    );
    check(
        'cssgen: радиусы по слоям (20 и 50)',
        css.includes('blur(20px)') && css.includes('blur(50px)')
    );
    // слой 0 — заливка + маска ($blur-bg/$blur-mask), слой 1 — только маска
    check(
        'sass: переменные $blur-bg/$blur-mask и $blur-2-mask',
        sass.includes('$blur-bg:') &&
            sass.includes('$blur-mask:') &&
            sass.includes('$blur-2-mask:') &&
            !sass.includes('$blur-2-bg:')
    );
    check('sass: классы &__blur и &__blur-2', sass.includes('&__blur') && sass.includes('&__blur-2'));
    // невидимый слой не экспортируется
    const hidden = singleLayerState();
    hidden.blur.layers.push({
        ...structuredClone(hidden.blur.layers[0]),
        id: uid(),
        visible: false,
    });
    const cssHidden = stateToCssText(hidden);
    check(
        'cssgen: невидимый слой не экспортируется',
        cssHidden.includes('.gradient-block__blur {') && !cssHidden.includes('__blur-2')
    );
    // мастер-тумблер глушит секцию blur целиком — даже при видимых слоях;
    // underlay выключен, чтобы не ловить подстроку в __blur-underlay
    const masterOff = defaultBlockState();
    masterOff.blur.enabled = false;
    masterOff.blur.layers = [defaultBlurLayer()];
    check(
        'cssgen: blur.enabled=false — секции __blur в CSS нет вовсе',
        !stateToCssText(masterOff).includes('gradient-block__blur')
    );
}

// ── 5. blurEdges: жёсткая кромка rect при невыраженной маске ──
/** Стейт с одним blur-слоем (rect + маска). */
function edgeState(rect, mask) {
    const s = defaultBlockState();
    s.blur.enabled = true;
    s.blur.layers = [
        {
            id: uid(),
            visible: true,
            radius: 20,
            background: null,
            gradient: null,
            mask,
            rect,
        },
    ];
    return s;
}

{
    // кромка без маски: rect зажат внутри, mask=null → α=1 у кромки → warning
    const noMask = edgeState({ x: 10, y: 0, w: 80, h: 100 }, null);
    const issuesNoMask = blurEdgeIssues(noMask);
    check(
        'edges: rect внутри блока без маски — жёсткая кромка (α=1)',
        issuesNoMask.length === 1 &&
            issuesNoMask[0].layer === 0 &&
            issuesNoMask[0].maxAlpha === 1 &&
            issuesNoMask[0].edges.includes('левой') &&
            issuesNoMask[0].edges.includes('правой'),
        JSON.stringify(issuesNoMask)
    );
    const warnNoMask = blurEdgeWarnings(noMask);
    check(
        'edges: warning борт-контроля (код + номер слоя + совет)',
        warnNoMask.length === 1 &&
            warnNoMask[0].code === 'blur-hard-edge' &&
            warnNoMask[0].severity === 'warn' &&
            warnNoMask[0].message.includes('blur-слой 1') &&
            warnNoMask[0].message.includes('вне 0–100%'),
        JSON.stringify(warnNoMask)
    );

    // α>порога у кромки: маска на верхней кромке не растворяется
    const hardMask = edgeState(
        { x: 0, y: 10, w: 100, h: 80 },
        lin(180, [
            { id: uid(), pos: 0, color: '#000000', alpha: 1 },
            { id: uid(), pos: 100, color: '#000000', alpha: 0 },
        ])
    );
    // 180° = книзу: верхняя кромка rect (маска pos 0) — α=1 → жёсткая
    check(
        'edges: α маски > порога у кромки — warning',
        blurEdgeIssues(hardMask).length === 1 &&
            blurEdgeIssues(hardMask)[0].edges.includes('верхней'),
        JSON.stringify(blurEdgeIssues(hardMask))
    );

    // α≈0 у кромки: маска растворяется к обоим внутренним краям — чисто
    const softMask = edgeState(
        { x: 10, y: 0, w: 80, h: 100 },
        lin(90, [
            { id: uid(), pos: 0, color: '#000000', alpha: 0 },
            { id: uid(), pos: 50, color: '#000000', alpha: 1 },
            { id: uid(), pos: 100, color: '#000000', alpha: 0 },
        ])
    );
    check('edges: α≈0 у внутренних кромок — нет warning', blurEdgeIssues(softMask).length === 0);

    // radial: ending-shape кончается внутри — кромки в α0
    const radMask = (stops) => ({
        type: 'radial',
        cx: 50,
        cy: 50,
        shape: 'ellipse',
        size: 'farthest-side',
        rx: 50,
        ry: 50,
        repeating: false,
        stops,
    });
    const radSoft = edgeState(
        { x: 0, y: 10, w: 100, h: 80 },
        radMask([
            { id: uid(), pos: 0, color: '#000000', alpha: 1 },
            { id: uid(), pos: 100, color: '#000000', alpha: 0 },
        ])
    );
    check('edges: radial, α0 на ending-shape — нет warning', blurEdgeIssues(radSoft).length === 0);
    const radHard = edgeState(
        { x: 0, y: 10, w: 100, h: 80 },
        radMask([
            { id: uid(), pos: 0, color: '#000000', alpha: 0 },
            { id: uid(), pos: 100, color: '#000000', alpha: 1 },
        ])
    );
    check(
        'edges: radial, α растёт наружу — warning у кромок',
        blurEdgeIssues(radHard).length === 1 && blurEdgeIssues(radHard)[0].maxAlpha > 0.03,
        JSON.stringify(blurEdgeIssues(radHard))
    );

    // полный rect: внутренних кромок нет — маска не важна
    check(
        'edges: rect на весь блок — внутренних кромок нет',
        blurEdgeIssues(edgeState({ x: 0, y: 0, w: 100, h: 100 }, null)).length === 0
    );

    // выключенный blur и невидимые слои не проверяются; слой 2 нумеруется
    const off = edgeState({ x: 10, y: 0, w: 80, h: 100 }, null);
    off.blur.enabled = false;
    check('edges: blur выключен — пусто', blurEdgeIssues(off).length === 0);
    const two = edgeState({ x: 10, y: 0, w: 80, h: 100 }, null);
    two.blur.layers.push({ ...structuredClone(two.blur.layers[0]), id: uid() });
    const warnTwo = blurEdgeWarnings(two);
    check(
        'edges: два слоя — два warning с номерами 1 и 2',
        warnTwo.length === 2 &&
            warnTwo[0].message.includes('blur-слой 1') &&
            warnTwo[1].message.includes('blur-слой 2')
    );
}

// ── 6. таргеты: layer-aware ключи и чтение/запись градиентов ──
{
    check(
        'targets: слой 0 — канонический ключ без суффикса',
        targetToKey({ kind: 'blurMask', layer: 0 }) === 'blurMask'
    );
    check(
        'targets: слой 0 (blurBg) — без суффикса',
        targetToKey({ kind: 'blurBg', layer: 0 }) === 'blurBg'
    );
    check(
        'targets: слой 1 — ключ с суффиксом',
        targetToKey({ kind: 'blurMask', layer: 1 }) === 'blurMask:1'
    );
    check(
        'targets: строка → таргет с layer',
        JSON.stringify(targetFromString('blurBg:1')) === JSON.stringify({ kind: 'blurBg', layer: 1 })
    );
    check(
        'targets: строка слоя 0 — как раньше',
        JSON.stringify(targetFromString('blurMask')) === JSON.stringify({
            kind: 'blurMask',
            layer: 0,
        })
    );
    check('targets: левый ключ — null', targetFromString('blurMask:x') === null);

    const s = defaultBlockState();
    s.blur.enabled = true;
    s.blur.layers = [defaultBlurLayer(), defaultBlurLayer()];
    s.blur.layers[1].gradient = lin(45, [
        { id: uid(), pos: 0, color: '#101010', alpha: 0.1 },
        { id: uid(), pos: 100, color: '#101010', alpha: 0 },
    ]);
    s.blur.layers[1].rect = { x: 0, y: 0, w: 100, h: 40 };
    check(
        'targets: readGradient blurBg layer 1 — заливка слоя 1',
        readGradient(s, { kind: 'blurBg', layer: 1 }).stops[0].alpha === 0.1
    );
    check(
        'targets: readGradient blurMask layer 1 — маска слоя 1',
        readGradient(s, { kind: 'blurMask', layer: 1 }) !== null &&
            readGradient(s, { kind: 'blurMask', layer: 1 }).stops[0].alpha === 1
    );
    check(
        'targets: targetAxisRect blurBg layer 1 — rect слоя',
        targetAxisRect(s, { kind: 'blurBg', layer: 1 }).h === 40
    );
    const g = lin(0, [
        { id: 'x1', pos: 0, color: '#000000', alpha: 1 },
        { id: 'x2', pos: 100, color: '#000000', alpha: 0 },
    ]);
    assignGradient(s, { kind: 'blurMask', layer: 1 }, g);
    check(
        'targets: assignGradient пишет маску в слой 1',
        s.blur.layers[1].mask.stops[0].id === 'x1' && s.blur.layers[0].mask.stops[0].id !== 'x1'
    );
    check(
        'targets: слой за диапазоном — null без броска',
        readGradient(s, { kind: 'blurBg', layer: 5 }) === null
    );
}

// ── 7. hint: журнальные α-стопы blur-семьи резолвят слой из таргета ──
{
    const analysis = AnalysisSchema.parse({
        matchPercent: 90,
        zoneMatchPercent: 95,
        maxError: 40,
        tolerance: 10,
        target: 'blurBg:1',
        profile: 'axis',
        axisSpace: 'blur.rect',
        zone: { x: 0, y: 0, w: 100, h: 40 },
        axis: [],
        transitions: [],
        suggestedStops: [],
        residuals: [{ pos: 50, err: 44, kind: 'blur' }],
        verdict:
            'остатки в blur-зоне: крутите радиус/стопы маски (топ-10: кромки 0, blur 6, уровень 2, приблизительно 0)',
        updatedAt: Date.now(),
    });
    const entry = (fields, beforeZm, afterZm) => ({
        id: Math.random(),
        ts: Date.now(),
        fields,
        before: beforeZm === null ? null : { zoneMatch: beforeZm, maxErr: 40, verdict: 'x' },
        after: afterZm === null ? null : { zoneMatch: afterZm, maxErr: 35, verdict: 'y' },
    });

    const s = defaultBlockState();
    s.blur.layers = [defaultBlurLayer(), defaultBlurLayer()];
    s.blur.layers[1].gradient = lin(45, [
        { id: uid(), pos: 0, color: '#101010', alpha: 0.1 },
        { id: 'stop-1', pos: 100, color: '#101010', alpha: 0 },
    ]);
    const ctx = {
        state: s,
        target: { kind: 'blurBg', layer: 1 },
        selectedStopId: 'stop-1',
    };
    check(
        'hint: журнал blur.layers.1 + таргет blurBg layer 1 → нейтральный совет (маркер слоя не даёт листа)',
        computeHint(
            analysis,
            [
                entry(['blur.layers.1'], 90.0, 94.0),
                entry(['blur.layers.1'], 94.0, 95.1),
                entry(['blur.layers.1'], 95.1, 95.2),
            ],
            ctx
        ) ===
            'Ручка внутри blur-слоя ещё движется — продолжай итерации; для динамики доступен POST /api/sweep по точному листу слоя (radius или gradient.stops[i].alpha — что крутишь)'
    );
    check(
        'hint: легаси-журнал blur.gradient.stops резолвит слой из таргета',
        computeHint(
            analysis,
            [
                entry(['blur.gradient.stops'], 90.0, 94.0),
                entry(['blur.gradient.stops'], 94.0, 95.1),
                entry(['blur.gradient.stops'], 95.1, 95.2),
            ],
            ctx
        ) ===
            'Параметр blur.layers.1.gradient.stops[1].alpha ещё движется — прогони динамику: POST /api/sweep {field:"blur.layers.1.gradient.stops[1].alpha"}'
    );
    // правило 2, честная атрибуция: журнальный маркер blur-слоя не даёт
    // точного листа — при живых дельтах совет нейтральный, без stops[i].alpha
    const s0 = defaultBlockState();
    s0.blur.layers = [defaultBlurLayer(), defaultBlurLayer()];
    s0.blur.layers[0].gradient = lin(45, [
        { id: uid(), pos: 0, color: '#101010', alpha: 0.1 },
        { id: 'stop-0', pos: 100, color: '#101010', alpha: 0 },
    ]);
    const ctx0 = {
        state: s0,
        target: { kind: 'blurBg', layer: 0 },
        selectedStopId: 'stop-0',
    };
    const neutralHint = computeHint(
        analysis,
        [
            entry(['blur.layers.0'], 0.4, 0.9),
            entry(['blur.layers.0'], 0.9, 0.95),
            entry(['blur.layers.0'], 0.95, 1.0),
        ],
        ctx0
    );
    check(
        'hint: маркер blur-слоя с живыми дельтами — нейтральный совет без листа',
        // нейтральный совет сам упоминает stops[i] (буквальный i) — честная
        // атрибуция значит: НЕТ конкретного индекса stops[0]/stops[1]/...
        neutralHint.startsWith('Ручка внутри blur-слоя') && !/stops\[\d/.test(neutralHint),
        neutralHint
    );
    check(
        'hint: слой журнала не совпал с таргетом — префикс не резолвится',
        computeHint(
            analysis,
            [
                entry(['blur.layers.0'], 90.0, 94.0),
                entry(['blur.layers.0'], 94.0, 95.1),
                entry(['blur.layers.0'], 95.1, 95.2),
            ],
            ctx
        ) === 'Крути blur.radius и форму blur.mask'
    );

    // плато радиуса: журнальная форма blur.layers.0 + все дельты < 0.5
    check(
        'hint: плато по журналу blur.layers.0 — совет с разбивкой на два слоя',
        computeHint(
            analysis,
            [
                entry(['blur.layers.0'], 97.0, 97.2),
                entry(['blur.layers.0'], 97.2, 97.3),
                entry(['blur.layers.0'], 97.3, 97.1),
            ],
            ctx
        ).startsWith('Blur-ручка на плато (F2 exit)') &&
            computeHint(
                analysis,
                [
                    entry(['blur.layers.0'], 97.0, 97.2),
                    entry(['blur.layers.0'], 97.2, 97.3),
                    entry(['blur.layers.0'], 97.3, 97.1),
                ],
                ctx
            ).includes('разбей на два слоя')
    );
}
