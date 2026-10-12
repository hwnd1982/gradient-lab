/**
 * Юнит-тесты чистой логики приложения: гейт синка shouldSendSync (какие тики
 * подписки уходят в /api/sync — транзиентные значения sweep не уходят),
 * computeHint (6 правил, включая строгое плато радиуса и резолв журнальных
 * α-стопов в конкретный sweep-путь) и зеркало журнала стора (clearJournal).
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

// ── shouldSendSync: транзиенты sweep не уходят в /api/sync ──
const { shouldSendSync } = await jiti.import(`${ROOT}src/lib/syncGate.ts`);
const stateA = { w: 1 };
const stateB = { w: 2 };
const snap = (state, sweeping) => ({ state, sweeping });

check(
    'gate: транзиент sweep (первый шаг) — не синкается',
    shouldSendSync(snap(stateA, true), snap(stateA, false)) === false
);
check(
    'gate: транзиент sweep (шаг N) — не синкается',
    shouldSendSync(snap(stateB, true), snap(stateA, true)) === false
);
check(
    'gate: конец sweep, контент исходный — финальный sync идёт',
    shouldSendSync(snap(stateA, false), snap(stateA, true)) === true
);
check(
    'gate: конец sweep после abort (правка юзера) — sync идёт',
    shouldSendSync(snap(stateB, false), snap(stateB, true)) === true
);
check(
    'gate: обычная правка — синкается',
    shouldSendSync(snap(stateB, false), snap(stateA, false)) === true
);
check(
    'gate: ничего не изменилось — не синкается',
    shouldSendSync(snap(stateA, false), snap(stateA, false)) === false
);

// ── computeHint: 6 правил ──
const { computeHint } = await jiti.import(`${ROOT}src/lib/hint.ts`);
const { AnalysisSchema, defaultBlockState, uid } = await jiti.import(`${ROOT}src/schema.ts`);

function mkAnalysis(patch) {
    const base = {
        matchPercent: 90,
        zoneMatchPercent: 95,
        maxError: 40,
        tolerance: 10,
        target: 'blurMask',
        profile: 'axis',
        axisSpace: 'blur.rect',
        zone: { x: 0, y: 60, w: 100, h: 40 },
        axis: [],
        transitions: [],
        suggestedStops: [],
        residuals: [],
        verdict: 'остатки в пределах допуска (err ≤ 10) — совпадение полное',
        updatedAt: Date.now(),
    };
    const parsed = AnalysisSchema.safeParse({ ...base, ...patch });
    if (!parsed.success)
        throw new Error('фикстура невалидна: ' + JSON.stringify(parsed.error.issues));
    return parsed.data;
}
function entry(fields, beforeZm, afterZm) {
    return {
        id: Math.random(),
        ts: Date.now(),
        fields,
        before: beforeZm === null ? null : { zoneMatch: beforeZm, maxErr: 40, verdict: 'x' },
        after: afterZm === null ? null : { zoneMatch: afterZm, maxErr: 35, verdict: 'y' },
    };
}

const aBlur = mkAnalysis({
    verdict:
        'остатки в blur-зоне: крутите радиус/стопы маски (топ-10: кромки 2, blur 6, уровень 2, приблизительно 0)',
    residuals: [{ pos: 50, err: 44, kind: 'blur' }],
});

check(
    'hint 1: 3 записи радиуса, все дельты <0.5 → плато/F3',
    computeHint(aBlur, [
        entry(['blur.radius'], 97.0, 97.2),
        entry(['blur.radius'], 97.2, 97.3),
        entry(['blur.radius'], 97.3, 97.1),
    ]).startsWith('Радиус на плато (F2 exit)')
);
check(
    'hint 1н: дельта ≥0.5 — не плато, параметр ещё движется → sweep',
    computeHint(aBlur, [
        entry(['blur.radius'], 95.0, 97.0),
        entry(['blur.radius'], 97.2, 97.3),
        entry(['blur.radius'], 97.3, 97.1),
    ]) ===
        'Параметр blur.radius ещё движется — прогони динамику: POST /api/sweep {field:"blur.radius"}'
);
check(
    'hint sweep-плато: один числовой лист (угол маски) с живыми дельтами → sweep',
    computeHint(
        mkAnalysis({
            verdict:
                'остатки — приблизительная классификация (профиль по колонкам): сверяйтесь со ступенями и heat-картой (топ-10: кромки 1, blur 1, уровень 1, приблизительно 7)',
            residuals: [{ pos: 30, err: 22, kind: 'approx' }],
        }),
        [
            entry(['mask.gradient.angle'], 90.0, 94.0),
            entry(['mask.gradient.angle'], 94.0, 95.1),
            entry(['mask.gradient.angle'], 95.1, 95.2),
        ]
    ) ===
        'Параметр mask.gradient.angle ещё движется — прогони динамику: POST /api/sweep {field:"mask.gradient.angle"}'
);
check(
    'hint sweep-плато: дельты <0.5 у не-радиусного листа — sweep не предлагается',
    computeHint(
        mkAnalysis({
            verdict:
                'остатки — приблизительная классификация (профиль по колонкам): сверяйтесь со ступенями и heat-картой (топ-10: кромки 1, blur 1, уровень 1, приблизительно 7)',
            residuals: [{ pos: 30, err: 22, kind: 'approx' }],
        }),
        [
            entry(['mask.gradient.angle'], 94.0, 94.2),
            entry(['mask.gradient.angle'], 94.2, 94.1),
            entry(['mask.gradient.angle'], 94.1, 94.3),
        ]
    ) === 'Продолжай фазу; см. /api/methodology'
);

// ── computeHint: журнальные α-стопы — diffPaths режет пути тремя сегментами,
// правки стопов приходят префиксом семейства, а не полным sweep-путем; ctx
// редактора резолвит конкретный stops[i].alpha выбранного стопа ──
const stopState = defaultBlockState();
const stopCtx = {
    state: stopState,
    target: { kind: 'mask' },
    selectedStopId: stopState.mask.gradient.stops[1].id,
};
check(
    'hint 2с: журнал mask.gradient.stops + выбранный стоп → конкретный sweep-путь',
    computeHint(
        aBlur,
        [
            entry(['mask.gradient.stops'], 90.0, 94.0),
            entry(['mask.gradient.stops'], 94.0, 95.1),
            entry(['mask.gradient.stops'], 95.1, 95.2),
        ],
        stopCtx
    ) ===
        'Параметр mask.gradient.stops[1].alpha ещё движется — прогони динамику: POST /api/sweep {field:"mask.gradient.stops[1].alpha"}'
);
const underlayState = defaultBlockState();
underlayState.blur.underlay.gradient = {
    type: 'linear',
    angle: 180,
    repeating: false,
    stops: [
        { id: uid(), pos: 0, color: '#101010', alpha: 0.05 },
        { id: uid(), pos: 100, color: '#101010', alpha: 0.55 },
    ],
};
check(
    'hint 2с: blur.underlay.gradient (журнальная форма underlay) → stops[1].alpha',
    computeHint(
        aBlur,
        [
            entry(['blur.underlay.gradient'], 90.0, 94.0),
            entry(['blur.underlay.gradient'], 94.0, 95.1),
            entry(['blur.underlay.gradient'], 95.1, 95.2),
        ],
        {
            state: underlayState,
            target: { kind: 'underlay' },
            selectedStopId: underlayState.blur.underlay.gradient.stops[1].id,
        }
    ) ===
        'Параметр blur.underlay.gradient.stops[1].alpha ещё движется — прогони динамику: POST /api/sweep {field:"blur.underlay.gradient.stops[1].alpha"}'
);
check(
    'hint 2сн: стоп не выбран — префикс не резолвится, правило молчит',
    computeHint(
        aBlur,
        [
            entry(['mask.gradient.stops'], 90.0, 94.0),
            entry(['mask.gradient.stops'], 94.0, 95.1),
            entry(['mask.gradient.stops'], 95.1, 95.2),
        ],
        { state: stopState, target: { kind: 'mask' }, selectedStopId: null }
    ) === 'Крути blur.radius и форму blur.mask'
);
check(
    'hint 2сн: активный таргет другого семейства — префикс не резолвится',
    computeHint(
        aBlur,
        [
            entry(['mask.gradient.stops'], 90.0, 94.0),
            entry(['mask.gradient.stops'], 94.0, 95.1),
            entry(['mask.gradient.stops'], 95.1, 95.2),
        ],
        {
            state: stopState,
            target: { kind: 'blurBg' },
            selectedStopId: stopState.mask.gradient.stops[1].id,
        }
    ) === 'Крути blur.radius и форму blur.mask'
);
check(
    'hint 2н: правки разных полей — правила журнала молчат',
    computeHint(aBlur, [
        entry(['mask.gradient.angle'], 90.0, 94.0),
        entry(['mask.gradient.angle'], 94.0, 95.1),
        entry(['layers.0.opacity'], 95.1, 95.2),
    ]) === 'Крути blur.radius и форму blur.mask'
);
check(
    'hint 1н: null-метрика в кортеже не доказывает плато',
    computeHint(aBlur, [
        entry(['blur.radius'], 97.0, 97.2),
        entry(['blur.radius'], null, null),
        entry(['blur.radius'], 97.3, 97.1),
    ]) === 'Крути blur.radius и форму blur.mask'
);
check(
    'hint 1н: журнал не про радиус',
    computeHint(aBlur, [
        entry(['blur.mask'], 97.2, 97.3),
        entry(['blur.mask'], 97.3, 97.1),
        entry(['blur.gradient'], 97.1, 97.0),
    ]) === 'Крути blur.radius и форму blur.mask'
);
check(
    'hint sweep-плато: кромки → F1',
    computeHint(
        mkAnalysis({
            verdict:
                'остатки — кромки: альфой не лечатся, правь геометрию/rect (топ-10: кромки 8, blur 2, уровень 0, приблизительно 0)',
            residuals: [{ pos: 2.4, err: 71, kind: 'edge' }],
        }),
        []
    ) === 'Остатки кромочные — альфа не поможет; проверь blur.rect/кадры (F1) или стоп'
);
check(
    'hint 3 кромки: уровень → suggestedStops к <target>',
    computeHint(
        mkAnalysis({
            verdict:
                'остатки уровня: примените suggestedStops (топ-10: кромки 0, blur 2, уровень 8, приблизительно 0)',
            residuals: [{ pos: 45.1, err: 83, kind: 'level' }],
            target: 'blurBg',
        }),
        []
    ) === 'Примени suggestedStops к blurBg (F4)'
);
check(
    'hint 3н: «уровень 2» в статистике blur-вердикта не триггерит',
    computeHint(aBlur, []) === 'Крути blur.radius и форму blur.mask'
);
check('hint 4 уровень: все kind=blur', computeHint(aBlur, []) === 'Крути blur.radius и форму blur.mask');
check(
    'hint 5 все-blur: дефолт → /api/methodology',
    computeHint(
        mkAnalysis({
            verdict:
                'остатки — приблизительная классификация (профиль по колонкам): сверяйтесь со ступенями и heat-картой (топ-10: кромки 1, blur 1, уровень 1, приблизительно 7)',
            residuals: [{ pos: 30, err: 22, kind: 'approx' }],
        }),
        []
    ) === 'Продолжай фазу; см. /api/methodology'
);
check(
    'hint 5н: residuals [] — дефолт',
    computeHint(mkAnalysis({}), []) === 'Продолжай фазу; см. /api/methodology'
);

// ── зеркало журнала стора: накопление, кап 50, clearJournal ──
const { useLabStore } = await jiti.import(`${ROOT}src/store.ts`);
const mkEntry = (id) => ({
    id,
    ts: Date.now(),
    fields: ['blur.radius'],
    before: null,
    after: null,
});

useLabStore.getState().pushJournalEntry(mkEntry(1));
useLabStore.getState().pushJournalEntry(mkEntry(2));
check('store: зеркало накапливает записи', useLabStore.getState().journalEntries.length === 2);
useLabStore.getState().completeJournalEntry(2, { zoneMatch: 98.4, maxErr: 10, verdict: 'y' });
check(
    'store: completeJournalEntry дозаполняет after',
    useLabStore.getState().journalEntries[1].after.zoneMatch === 98.4
);
for (let i = 0; i < 60; i++) useLabStore.getState().pushJournalEntry(mkEntry(uid()));
check('store: кап зеркала 50', useLabStore.getState().journalEntries.length === 50);
useLabStore.getState().clearJournal();
check(
    'store: clearJournal чистит зеркало (DELETE /api/journal)',
    useLabStore.getState().journalEntries.length === 0
);
