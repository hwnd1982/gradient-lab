/**
 * Юнит-тесты универсального sweep-пути: белый список полей (SWEEP_FIELD_RE /
 * SweepReqSchema — что POST /api/sweep принимает и что отвергает с 400) и
 * резолвер src/lib/sweepPath.ts (resolve/apply: скобочные и точечные индексы,
 * границы массивов, не-числовые листья, мутация только целевого поля).
 * Импорт TS — jiti (см. tests/run.mjs).
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

const { SWEEP_FIELD_RE, SweepReqSchema, defaultBlockState, uid } = await jiti.import(
    `${ROOT}src/schema.ts`
);
const { resolveNumericPath, applyNumericPath } = await jiti.import(`${ROOT}src/lib/sweepPath.ts`);

// ── фикстура: дефолтный стейт + градиенты blur/underlay и слой ──
const lin = (angle, stops) => ({ type: 'linear', angle, repeating: false, stops });
const state = defaultBlockState();
state.blur.gradient = lin(137, [
    { id: uid(), pos: 0, color: '#101010', alpha: 0 },
    { id: uid(), pos: 50, color: '#101010', alpha: 0.42 },
    { id: uid(), pos: 100, color: '#101010', alpha: 0.8 },
]);
state.blur.underlay.gradient = lin(180, [
    { id: uid(), pos: 0, color: '#101010', alpha: 0.05 },
    { id: uid(), pos: 100, color: '#101010', alpha: 0.55 },
]);
state.layers = [
    {
        id: uid(),
        visible: true,
        opacity: 0.5,
        blend: 'normal',
        gradient: lin(90, [
            { id: uid(), pos: 0, color: '#101010', alpha: 0 },
            { id: uid(), pos: 100, color: '#101010', alpha: 0.45 },
        ]),
        rect: { x: 0, y: 0, w: 100, h: 100 },
    },
];

// ── SWEEP_FIELD_RE: белый список семейств числовых листьев ──
const VALID_FIELDS = [
    'blur.radius',
    'blur.gradient.angle',
    'mask.gradient.angle',
    'blur.gradient.stops[0].alpha',
    'blur.gradient.stops[2].alpha',
    'blur.gradient.stops.2.alpha', // точечный индекс — формат журнала
    'mask.gradient.stops[1].alpha',
    'base.gradient.stops[0].alpha',
    'blur.underlay.gradient.stops[1].alpha',
    'layers[0].opacity',
    'layers.0.opacity',
];
for (const f of VALID_FIELDS) {
    check(`field: ${f} — в белом списке`, SWEEP_FIELD_RE.test(f));
}

const INVALID_FIELDS = [
    'blur.enabled', // не числовой лист
    'base.image', // dataURL-строка
    'base.color', // строка-цвет
    'compare.tolerance', // вне семейств sweep
    'blur.mask.stops[0].alpha', // маска blur не в списке v2
    'blur.underlay.gradient.angle', // угол underlay не в списке v2
    'base.gradient.angle', // угол базы не в списке v2
    'layers[0].rect.x', // геометрия не числовой лист семейства
    'blur[0].radius', // скобки только у stops/layers
    'blur.radius.x', // лишний сегмент
    'stops[0].alpha', // нет корневого узла
    'foo',
    '',
];
for (const f of INVALID_FIELDS) {
    check(`field: ${f || "''"} — вне списка`, !SWEEP_FIELD_RE.test(f));
}

// ── SweepReqSchema: формат POST /api/sweep ──
check(
    'req: альфа стопа маски проходит',
    SweepReqSchema.safeParse({ field: 'mask.gradient.stops[2].alpha', from: 0, to: 1, steps: 6 })
        .success
);
check(
    'req: угол градиента blur проходит',
    SweepReqSchema.safeParse({ field: 'blur.gradient.angle', from: 0, to: 180, steps: 7 }).success
);
check(
    'req: левое поле — 400 (схема режет)',
    !SweepReqSchema.safeParse({ field: 'nope', from: 0, to: 1, steps: 2 }).success
);

// ── resolveNumericPath: чтение значения по пути ──
check('resolve: blur.radius', resolveNumericPath(state, 'blur.radius') === 24);
check('resolve: угол blur.gradient', resolveNumericPath(state, 'blur.gradient.angle') === 137);
check(
    'resolve: альфа среднего стопа (скобки)',
    resolveNumericPath(state, 'blur.gradient.stops[1].alpha') === 0.42
);
check(
    'resolve: альфа среднего стопа (точка) — эквивалент формы',
    resolveNumericPath(state, 'blur.gradient.stops.1.alpha') === 0.42
);
check(
    'resolve: альфа стопа underlay',
    resolveNumericPath(state, 'blur.underlay.gradient.stops[1].alpha') === 0.55
);
check('resolve: прозрачность слоя', resolveNumericPath(state, 'layers[0].opacity') === 0.5);
check(
    'resolve: альфа стопа маски блока',
    typeof resolveNumericPath(state, 'mask.gradient.stops[0].alpha') === 'number'
);

// ── resolveNumericPath: несуществующие пути → null ──
const NULL_FIELDS = [
    'blur.gradient.stops[9].alpha', // индекс за диапазоном
    'layers[1].opacity', // слоя нет
    'blur.mask.stops[0].alpha', // blur.mask = null в дефолте
    'blur.enabled', // не числовой лист
    'base.color', // лист-строка
    'blur', // не лист
    'blur.gradient', // не лист
    'blur.radius.extra', // лишний сегмент после листа
    '', // пустой путь
];
for (const f of NULL_FIELDS) {
    check(`resolve: ${f || "''"} → null`, resolveNumericPath(state, f) === null);
}

// ── applyNumericPath: запись значения и безопасность ──
const draft = structuredClone(state);
check(
    'apply: альфа стопа записана',
    applyNumericPath(draft, 'blur.gradient.stops[1].alpha', 0.75) === true &&
        draft.blur.gradient.stops[1].alpha === 0.75
);
check(
    'apply: точечная форма — та же цель',
    applyNumericPath(draft, 'blur.underlay.gradient.stops.0.alpha', 0.2) === true &&
        draft.blur.underlay.gradient.stops[0].alpha === 0.2
);
check(
    'apply: соседи не тронуты',
    draft.blur.gradient.stops[0].alpha === 0 &&
        draft.blur.gradient.stops[2].alpha === 0.8 &&
        draft.blur.gradient.angle === 137 &&
        state.blur.gradient.stops[1].alpha === 0.42 // исходник не мутирован
);
check(
    'apply: не-числовой лист — отказ без записи',
    applyNumericPath(draft, 'blur.enabled', 1) === false && draft.blur.enabled === false
);
check(
    'apply: индекс за диапазоном — отказ',
    applyNumericPath(draft, 'blur.gradient.stops[9].alpha', 1) === false
);
