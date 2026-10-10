import type { Analysis, JournalEntry, JournalMetrics } from '../types';

/** Порог «заметного» шага метрики (методика v2: решения по Δ≥0.5). */
const STEP = 0.5;

/** Сколько последних записей журнала нужно для диагностики плато радиуса. */
const PLATEAU_ENTRIES = 3;

/**
 * «Движение к точке» (методика v2): подсказка следующего шага по фактам
 * анализа + журнала. Правила по приоритету:
 *
 * 1. радиус на плато — последние ≥3 записи крутили blur.radius, во всех
 *    известны дельты zoneMatch (before/after) и ВСЕ < 0.5 → переход к форме
 *    маски (F3); записи без метрик плато не доказывают;
 * 2. verdict про кромки → альфа не поможет, геометрия/кадры (F1) или стоп;
 * 3. verdict про уровень → применить suggestedStops (F4);
 * 4. остатки все в blur-зоне → крутить радиус и форму маски;
 * 5. дефолт — продолжать фазу по /api/methodology.
 *
 * Вердикт строится как «<классификация>: <совет> (топ-N: кромки X, …)» —
 * правила 2–3 проверяют классификацию (голову до статистики-хвоста), иначе
 * слово «уровень» из хвоста ловилось бы у каждого вердикта.
 */
export function computeHint(analysis: Analysis, journalEntries: JournalEntry[]): string {
    const tail = journalEntries.slice(-PLATEAU_ENTRIES);
    if (tail.length >= PLATEAU_ENTRIES && tail.every((e) => e.fields.includes('blur.radius'))) {
        const withMetrics = tail.filter(
            (e): e is JournalEntry & { before: JournalMetrics; after: JournalMetrics } =>
                e.before !== null && e.after !== null
        );
        // плато доказано только известными дельтами во ВСЕХ записях кортежа
        if (withMetrics.length === PLATEAU_ENTRIES) {
            const deltas = withMetrics.map((e) => Math.abs(e.after.zoneMatch - e.before.zoneMatch));
            if (deltas.every((d) => d < STEP)) {
                return 'Радиус на плато (F2 exit) — переходи к форме маски (F3): предразогрев 0.1@35% → фронт 0.5→1';
            }
        }
    }

    const head = analysis.verdict.split(' (топ-')[0];
    if (head.includes('кромк')) {
        return 'Остатки кромочные — альфа не поможет; проверь blur.rect/кадры (F1) или стоп';
    }
    if (head.includes('уровн')) {
        return `Примени suggestedStops к ${analysis.target} (F4)`;
    }
    if (analysis.residuals.length > 0 && analysis.residuals.every((r) => r.kind === 'blur')) {
        return 'Крути blur.radius и форму blur.mask';
    }
    return 'Продолжай фазу; см. /api/methodology';
}
