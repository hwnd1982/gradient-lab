/**
 * Юнит-тесты чистой логики приложения: гейт синка shouldSendSync (какие тики
 * подписки уходят в /api/sync — транзиентные значения sweep не уходят),
 * computeHint (5 правил, включая строгое плато радиуса) и зеркало журнала
 * стора (clearJournal). Импорт TS — jiti (см. tests/run.mjs).
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

// ── computeHint: 5 правил ──
const { computeHint } = await jiti.import(`${ROOT}src/lib/hint.ts`);
const { AnalysisSchema, uid } = await jiti.import(`${ROOT}src/schema.ts`);

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
    'hint 1н: дельта ≥0.5 — не плато',
    computeHint(aBlur, [
        entry(['blur.radius'], 95.0, 97.0),
        entry(['blur.radius'], 97.2, 97.3),
        entry(['blur.radius'], 97.3, 97.1),
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
    'hint 2: кромки → F1',
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
    'hint 3: уровень → suggestedStops к <target>',
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
check('hint 4: все kind=blur', computeHint(aBlur, []) === 'Крути blur.radius и форму blur.mask');
check(
    'hint 5: дефолт → /api/methodology',
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
