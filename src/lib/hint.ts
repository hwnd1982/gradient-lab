import { SWEEP_FIELD_RE } from '../schema';
import { readGradient } from '../targets';
import type { Analysis, BlockState, GradientTarget, JournalEntry, JournalMetrics } from '../types';

/** Порог «заметного» шага метрики (методика v2: решения по Δ≥0.5). */
const STEP = 0.5;

/** Сколько последних записей журнала нужно для диагностики плато/движения ручки. */
const PLATEAU_ENTRIES = 3;

/**
 * Контекст редактора для резолва журнальных α-стопов: diffPaths (App.tsx)
 * режет пути тремя сегментами, поэтому правки стопов попадают в журнал как
 * ПРЕФИКС семейства («mask.gradient.stops», «blur.underlay.gradient»,
 * «blur.layers.0» — любая правка внутри blur-слоя), а не полный sweep-путь.
 * Конкретный индекс берём из активного таргета редактора и выбранного в нём
 * стопа.
 */
export interface HintContext {
    state: BlockState;
    target: GradientTarget;
    selectedStopId: string | null;
}

/** Семейство α-стопов таргета; null — у таргета нет стоп-семейства в списке sweep. */
function stopFamilyOfTarget(t: GradientTarget): string | null {
    switch (t.kind) {
        case 'base':
            return 'base.gradient';
        case 'mask':
            return 'mask.gradient';
        case 'blurBg':
            // слой берём из таргета: blurBg layer 1 → blur.layers.1.gradient
            return `blur.layers.${t.layer}.gradient`;
        case 'underlay':
            return 'blur.underlay.gradient';
        default:
            return null;
    }
}

/**
 * Журнальная форма правки α-стопов: «<family>.stops» или сам
 * «blur.underlay.gradient» (легаси-префиксы семейств) и «blur.layers.N» —
 * новая форма правок внутри blur-слоя (diffPaths режет на 3 сегмента).
 */
const STOP_FAMILY_JOURNAL_RE =
    /^(?:base|mask|blur)\.gradient\.stops$|^blur\.underlay\.gradient$|^blur\.layers\.[01]$/;

/**
 * Журнальный путь → конкретный sweep-путь: полная форма (радиус/угол/
 * прозрачность слоя) — как есть; префикс семейства стопов — резолвится в
 * `<family>.stops[i].alpha` по выбранному стопу активного таргета (ctx).
 * Легаси «blur.gradient.stops» резолвит слой из активного таргета
 * (blurBg layer N → blur.layers.N.gradient), «blur.layers.N» несёт слой сам.
 * null — не числовой лист / семейство не совпадает с таргетом / стоп не
 * выбран или его уже нет в градиенте.
 */
function toSweepField(field: string, ctx: HintContext | undefined): string | null {
    if (SWEEP_FIELD_RE.test(field)) return field;
    if (ctx === undefined || !STOP_FAMILY_JOURNAL_RE.test(field)) return null;
    let family: string;
    if (field === 'blur.gradient.stops') {
        // легаси-форма до слоёв: слой не виден в пути — берём из таргета
        if (ctx.target.kind !== 'blurBg') return null;
        family = `blur.layers.${ctx.target.layer}.gradient`;
    } else if (field.startsWith('blur.layers.')) {
        // правки внутри blur-слоя N; стоп-семейство — заливка (gradient),
        // маски в списке sweep нет
        family = `${field}.gradient`;
    } else {
        family = field.endsWith('.stops') ? field.slice(0, -'.stops'.length) : field;
    }
    if (stopFamilyOfTarget(ctx.target) !== family) return null;
    const stops = readGradient(ctx.state, ctx.target)?.stops ?? [];
    const index = stops.findIndex((s) => s.id === ctx.selectedStopId);
    return index >= 0 ? `${family}.stops[${index}].alpha` : null;
}

/**
 * «Движение к точке» (методика v2): подсказка следующего шага по фактам
 * анализа + журнала. Правила по приоритету:
 *
 * 1. радиус на плато — последние ≥3 записи касались радиуса blur (журнальные
 *    маркеры: легаси-лист `blur.radius` или префикс правок blur-слоя
 *    `blur.layers.N` — точный лист `blur.layers.N.radius` в журнал не
 *    попадает, diffPaths режет пути тремя сегментами), во всех известны
 *    дельты zoneMatch (before/after) и ВСЕ < 0.5 → переход к форме маски
 *    (F3) или разбивке на два слоя; записи без метрик плато не доказывают;
 * 2. один числовой лист (валидный путь sweep) правится ≥3 записи и дельты
 *    ещё живые (хотя бы одна ≥0.5) → динамику выгоднее прогнать одной
 *    командой POST /api/sweep, чем руками; журнальные α-стопы приходят
 *    префиксом семейства (пути обрезаны до 3 сегментов) — конкретный
 *    stops[i].alpha резолвится по активному таргету редактора (ctx);
 *    маркеры blur-слоя точного листа не дают — совет нейтральный;
 * 3. verdict про кромки → альфа не поможет, геометрия/кадры (F1) или стоп;
 * 4. verdict про уровень → применить suggestedStops (F4);
 * 5. остатки все в blur-зоне → крутить радиус и форму маски;
 * 6. дефолт — продолжать фазу по /api/methodology.
 *
 * Вердикт строится как «<классификация>: <совет> (топ-N: кромки X, …)» —
 * правила 3–4 проверяют классификацию (голову до статистики-хвоста), иначе
 * слово «уровень» из хвоста ловилось бы у каждого вердикта.
 */
export function computeHint(
    analysis: Analysis,
    journalEntries: JournalEntry[],
    ctx?: HintContext
): string {
    const tail = journalEntries.slice(-PLATEAU_ENTRIES);
    // маркеры радиусных правок: легаси blur.radius и слоевые blur.layers.N
    const radiusTouched = tail.every((e) =>
        e.fields.some((f) => f === 'blur.radius' || f === 'blur.layers.0' || f === 'blur.layers.1')
    );
    if (tail.length >= PLATEAU_ENTRIES && radiusTouched) {
        const withMetrics = tail.filter(
            (e): e is JournalEntry & { before: JournalMetrics; after: JournalMetrics } =>
                e.before !== null && e.after !== null
        );
        // плато доказано только известными дельтами во ВСЕХ записях кортежа
        if (withMetrics.length === PLATEAU_ENTRIES) {
            const deltas = withMetrics.map((e) => Math.abs(e.after.zoneMatch - e.before.zoneMatch));
            if (deltas.every((d) => d < STEP)) {
                return 'Blur-ручка на плато (F2 exit) — переходи к форме маски (F3): предразогрев 0.1@35% → фронт 0.5→1; либо разбей на два слоя: ::before с меньшим радиусом выше, ::after с большим ниже';
            }
        }
    }

    // один числовой лист во всех записях кортежа и метрика ещё отвечает на
    // правки (max дельта ≥0.5) — коридор/динамику перебирает sweep; журнальные
    // α-стопы приходят префиксом семейства (обрезаны до 3 сегментов) —
    // конкретный путь резолвится по активному таргету редактора (ctx)
    if (tail.length >= PLATEAU_ENTRIES) {
        const moving = tail[0].fields.find(
            (f) => toSweepField(f, ctx) !== null && tail.every((e) => e.fields.includes(f))
        );
        const field = moving === undefined ? null : toSweepField(moving, ctx);
        if (field !== null) {
            const deltas = tail
                .filter(
                    (e): e is JournalEntry & { before: JournalMetrics; after: JournalMetrics } =>
                        e.before !== null && e.after !== null
                )
                .map((e) => Math.abs(e.after.zoneMatch - e.before.zoneMatch));
            if (deltas.some((d) => d >= STEP)) {
                // журнальный blur-маркер — ЛЮБАЯ ручка внутри blur-слоя
                // (радиус/rect/маска/стопы неразличимы): приписывать живые
                // дельты конкретному листу нельзя — совет нейтральный,
                // точный лист для sweep выбирает агент
                const isBlurMarker =
                    moving !== undefined &&
                    (moving === 'blur.radius' || moving.startsWith('blur.layers.'));
                if (isBlurMarker) {
                    return 'Ручка внутри blur-слоя ещё движется — продолжай итерации; для динамики доступен POST /api/sweep по точному листу слоя (radius или gradient.stops[i].alpha — что крутишь)';
                }
                return `Параметр ${field} ещё движется — прогони динамику: POST /api/sweep {field:"${field}"}`;
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
