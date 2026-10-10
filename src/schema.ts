import { z } from 'zod';

export function uid(): string {
    return crypto.randomUUID();
}

export const BlendModeSchema = z.enum([
    'normal',
    'multiply',
    'screen',
    'overlay',
    'darken',
    'lighten',
    'color-dodge',
    'color-burn',
    'hard-light',
    'soft-light',
    'difference',
    'exclusion',
    'hue',
    'saturation',
    'color',
    'luminosity',
]);
export type BlendMode = z.infer<typeof BlendModeSchema>;

export const StopSchema = z.object({
    id: z.string(),
    /** % вдоль оси, может быть вне 0..100 */
    pos: z.number(),
    /** '#rrggbb' */
    color: z.string(),
    alpha: z.number().min(0).max(1),
});
export type Stop = z.infer<typeof StopSchema>;

export const LinearGradientSchema = z.object({
    type: z.literal('linear'),
    /** deg, CSS-конвенция: 0 = to top, 90 = to right */
    angle: z.number(),
    repeating: z.boolean(),
    stops: z.array(StopSchema),
});
export type LinearGradient = z.infer<typeof LinearGradientSchema>;

export const RadialSizeSchema = z.enum([
    'closest-side',
    'closest-corner',
    'farthest-side',
    'farthest-corner',
    'explicit',
]);
export type RadialSize = z.infer<typeof RadialSizeSchema>;

export const RadialGradientSchema = z.object({
    type: z.literal('radial'),
    /** % центра, может быть вне 0..100 */
    cx: z.number(),
    cy: z.number(),
    shape: z.enum(['circle', 'ellipse']),
    size: RadialSizeSchema,
    /** % при size='explicit' */
    rx: z.number(),
    ry: z.number(),
    repeating: z.boolean(),
    stops: z.array(StopSchema),
});
export type RadialGradient = z.infer<typeof RadialGradientSchema>;

export const GradientSchema = z.discriminatedUnion('type', [
    LinearGradientSchema,
    RadialGradientSchema,
]);
export type Gradient = z.infer<typeof GradientSchema>;

/** Область внутри блока, % от блока; x/y могут выходить за 0..100, w/h >= 1. */
export const BlurRectSchema = z.object({
    x: z.number(),
    y: z.number(),
    w: z.number().min(1),
    h: z.number().min(1),
});
export type BlurRect = z.infer<typeof BlurRectSchema>;

export const BgLayerSchema = z.object({
    id: z.string(),
    visible: z.boolean(),
    /** 0..1 */
    opacity: z.number().min(0).max(1),
    blend: BlendModeSchema,
    gradient: GradientSchema,
    /**
     * Область слоя внутри блока, % от блока (x/y могут выходить за 0..100,
     * w/h >= 1). Градиент слоя CSS считает от border-box элемента — ось/центр/
     * радиусы живут в системе rect. .default() — старые стейты без поля
     * остаются валидными.
     */
    rect: BlurRectSchema.default({ x: 0, y: 0, w: 100, h: 100 }),
});
export type BgLayer = z.infer<typeof BgLayerSchema>;

export const BaseSpecSchema = z.object({
    kind: z.enum(['color', 'gradient', 'image']),
    color: z.string(),
    /** заливка базы при kind='gradient'; .default() — старые стейты без поля остаются валидными */
    gradient: GradientSchema.default(() =>
        defaultLinearGradient(90, [
            { id: uid(), pos: 0, color: '#101010', alpha: 1 },
            { id: uid(), pos: 100, color: '#101010', alpha: 0 },
        ])
    ),
    /** dataURL загруженной картинки */
    image: z.string().nullable(),
    fit: z.enum(['cover', 'contain', 'fill']),
    posX: z.number(),
    posY: z.number(),
});
export type BaseSpec = z.infer<typeof BaseSpecSchema>;

export const MaskSpecSchema = z.object({
    enabled: z.boolean(),
    gradient: GradientSchema,
});
export type MaskSpec = z.infer<typeof MaskSpecSchema>;

/**
 * Подложка затемнения ПОД blur-элементом (порядок: base → слои → underlay → blur).
 * Без маски и блюра, со своей rect-областью. .default() на всех полях —
 * старые стейты без underlay остаются валидными.
 */
export const BlurUnderlaySchema = z.object({
    enabled: z.boolean(),
    /** область underlay внутри блока, % от блока */
    rect: BlurRectSchema.default({ x: 0, y: 0, w: 100, h: 100 }),
    /** плоский цвет затемнения rgba(...); при заданном gradient игнорируется */
    color: z.string().nullable().default(null),
    /** градиентная заливка underlay */
    gradient: GradientSchema.nullable().default(null),
});
export type BlurUnderlay = z.infer<typeof BlurUnderlaySchema>;

export const BlurSpecSchema = z.object({
    enabled: z.boolean(),
    /** px, backdrop-filter: blur() */
    radius: z.number(),
    /** опциональный цвет подложки rgba(...) — легаси-поле; при заданном gradient игнорируется */
    background: z.string().nullable(),
    /** градиентная заливка того же псевдоэлемента (фон + blur + маска на одном элементе) */
    gradient: GradientSchema.nullable().default(null),
    /** маска на blur-слой */
    mask: GradientSchema.nullable(),
    /** область blur-слоя внутри блока, % от блока; .default() — старые стейты остаются валидными */
    rect: BlurRectSchema.default({ x: 0, y: 0, w: 100, h: 100 }),
    /** подложка затемнения под blur; .default() — старые стейты без поля остаются валидными */
    underlay: BlurUnderlaySchema.default({
        enabled: false,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        color: null,
        gradient: null,
    }),
});
export type BlurSpec = z.infer<typeof BlurSpecSchema>;

export const ClipTextSpecSchema = z.object({
    enabled: z.boolean(),
    text: z.string(),
    gradient: GradientSchema,
});
export type ClipTextSpec = z.infer<typeof ClipTextSpecSchema>;

/** Сравнение с макетом-референсом (этап perfect pixel). */
export const CompareSpecSchema = z.object({
    refImage: z.string().nullable(),
    mode: z.enum(['off', 'opacity', 'difference', 'split', 'analysis']),
    opacity: z.number(),
    /** px-смещение референса относительно позиции «на блоке» */
    x: z.number(),
    y: z.number(),
    /** масштаб референса от центра блока (1 = размер блока) */
    scale: z.number(),
    /** % ширины/высоты блока, где стоит разделитель режима «split» */
    splitPos: z.number().min(0).max(100),
    /** ось разделителя: vertical — линия двигается влево/вправо, horizontal — вниз/вверх */
    splitDir: z.enum(['vertical', 'horizontal']).default('vertical'),
    /** допуск попиксельного сравнения в режиме «analysis» (0..255) */
    tolerance: z.number().min(0).max(255).default(10),
});
export type CompareSpec = z.infer<typeof CompareSpecSchema>;

export const StageSpecSchema = z.object({
    bg: z.enum(['checker', 'solid', 'image']),
    color: z.string(),
    /** dataURL фоновой картинки стейджа (режим bg='image'); .default() — старые стейты без поля остаются валидными */
    image: z.string().nullable().default(null),
    /** px-смещение картинки на стейдже */
    x: z.number().default(0),
    y: z.number().default(0),
    /** % масштаб картинки от натурального размера */
    scale: z.number().default(100),
    /**
     * Блок изолирован (backdrop root: isolation: isolate на блоке в превью и
     * экспорте). В реальном браузере родитель с isolation клипает сэмпл блюра —
     * backdrop-filter блюрит только содержимое блока; канва анализа при
     * isolated=true за краем блока сэмплирует копии краевых пикселей
     * (clamp-to-edge), а не прозрачность. .default() — бэк-компат.
     */
    isolated: z.boolean().default(true),
});
export type StageSpec = z.infer<typeof StageSpecSchema>;

/** Пересчёт величин кропа лаборатории в величины макета (B6). */
export const ExportSpecSchema = z.object({
    /** экспорт-масштаб кадров (2x → css px = px лабы / scale) */
    scale: z.number().default(2),
    /** px на 1rem в макете */
    remBase: z.number().default(10),
    /** ширина дизайн-макета, px (для «% макета») */
    designWidth: z.number().default(1440),
});
export type ExportSpec = z.infer<typeof ExportSpecSchema>;

/** Точка профиля расхождения вдоль оси активного градиента. */
export const AnalysisAxisPointSchema = z.object({
    /** % вдоль оси */
    pos: z.number(),
    /** [r, g, b, a] референса */
    ref: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    /** [r, g, b, a] текущего блока */
    got: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    /** величина расхождения в этой точке (0..255) */
    err: z.number(),
});
export type AnalysisAxisPoint = z.infer<typeof AnalysisAxisPointSchema>;

/** «Ступень» референса — резкая смена уровня вдоль оси. */
export const AnalysisTransitionSchema = z.object({
    /** % вдоль оси */
    pos: z.number(),
    /** уровень после ступени (0..255) */
    level: z.number(),
});
export type AnalysisTransition = z.infer<typeof AnalysisTransitionSchema>;

/** Предлагаемый стоп по ступеням референса. */
export const AnalysisSuggestedStopSchema = z.object({
    /** % вдоль оси */
    pos: z.number(),
    /** '#rrggbb' — для цветовых таргетов */
    color: z.string().optional(),
    /** 0..1 — для масковых таргетов */
    alpha: z.number().optional(),
});
export type AnalysisSuggestedStop = z.infer<typeof AnalysisSuggestedStopSchema>;

/**
 * Классификация точки остатка: кромка оси/rect, зона blur, уровень.
 * `approx` — колонковый профиль: позиции residual (ось градиента) и ступени
 * (ось X) живут в разных системах координат, классификация приблизительна.
 */
export const AnalysisResidualSchema = z.object({
    /** % вдоль оси */
    pos: z.number(),
    /** величина расхождения (0..255) */
    err: z.number(),
    kind: z.enum(['edge', 'blur', 'level', 'approx']),
});
export type AnalysisResidual = z.infer<typeof AnalysisResidualSchema>;

/** Результат diff-анализа блока против референса (Perfect Pixel). */
export const AnalysisSchema = z.object({
    /** % пикселей с err < tolerance */
    matchPercent: z.number(),
    /** matchPercent, ограниченный зоной эффекта (zone) */
    zoneMatchPercent: z.number(),
    maxError: z.number(),
    tolerance: z.number(),
    /** таргет, для которого считался анализ (ключ API: base / layer:N / blockMask / …) */
    target: z.string(),
    /** режим профиля: 'axis' — вдоль оси градиента, 'columns' — P60 яркости по оси X, 'rays' — медиана по 16 лучам radial (только radial-таргеты) */
    profile: z.enum(['axis', 'columns', 'rays']),
    /** пространство координат оси: блок или rect-область эффекта (blur/underlay/слой) */
    axisSpace: z.enum(['block', 'blur.rect', 'underlay.rect', 'layer.rect']),
    /** зона эффекта, % от блока (для blur-таргетов — blur.rect, для underlay — его rect, для layer — rect слоя) */
    zone: BlurRectSchema,
    axis: z.array(AnalysisAxisPointSchema),
    transitions: z.array(AnalysisTransitionSchema),
    suggestedStops: z.array(AnalysisSuggestedStopSchema),
    /** значимые остатки (err > tolerance) с классификацией */
    residuals: z.array(AnalysisResidualSchema),
    /** человеческая сводка «что править в первую очередь» */
    verdict: z.string(),
    /** Date.now() на момент расчёта */
    updatedAt: z.number(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

/**
 * Маркер вместо анализа (POST/GET /api/__analysis): полный расчёт невозможен.
 * `gradientMissing` — у таргета нет градиента (слой за диапазоном, blurMask без
 * маски, плоский цвет у blurBg/underlay); `blocked` — анализ не считался,
 * потому что нет референса (агентский `?target=` при пустом compare.refImage).
 * Refine: без хотя бы одного маркерного поля объект не маркер — иначе полный
 * анализ без обязательных полей прошёл бы сюда за счёт strip неизвестных ключей.
 */
export const AnalysisMarkerSchema = z
    .object({
        target: z.string(),
        gradientMissing: z.boolean().optional(),
        blocked: z.enum(['no-reference']).optional(),
    })
    .refine((m) => m.gradientMissing !== undefined || m.blocked !== undefined, {
        message: 'маркер должен содержать gradientMissing или blocked',
    });
export type AnalysisMarker = z.infer<typeof AnalysisMarkerSchema>;

/** Тело POST /api/__analysis: сброс кэша, полный анализ или маркер. */
export const AnalysisPostSchema = z.union([
    z.object({ cleared: z.literal(true) }),
    AnalysisSchema,
    AnalysisMarkerSchema,
]);
export type AnalysisPost = z.infer<typeof AnalysisPostSchema>;

/** Предупреждение борт-контроля старта (GET /api/warnings). */
export const WarningSchema = z.object({
    code: z.string(),
    severity: z.enum(['warn', 'info']),
    message: z.string(),
    /** готовое исправление полей блока — агент применяет сам через PUT /api/state */
    fix: z
        .object({
            w: z.number().optional(),
            h: z.number().optional(),
        })
        .optional(),
});
export type Warning = z.infer<typeof WarningSchema>;

/** Тело POST /api/__warnings: предупреждения есть или явно сброшены. */
export const WarningsPayloadSchema = z.union([
    z.object({ cleared: z.literal(true) }),
    z.object({ warnings: z.array(WarningSchema).min(1) }),
]);
export type WarningsPayload = z.infer<typeof WarningsPayloadSchema>;

/** Метрики анализа на момент итерации (запись журнала, GET /api/journal). */
export const JournalMetricsSchema = z.object({
    zoneMatch: z.number(),
    maxErr: z.number(),
    verdict: z.string(),
});
export type JournalMetrics = z.infer<typeof JournalMetricsSchema>;

/**
 * Запись журнала итераций: ts + изменённые пути (dot-notation, глубина ≤ 3,
 * максимум 20) + метрики анализа «до» правки; `after` заполняется следующим
 * анализом (вторым сообщением POST /api/__journal {id, after}).
 */
export const JournalEntrySchema = z.object({
    id: z.number(),
    ts: z.number(),
    fields: z.array(z.string()),
    before: JournalMetricsSchema.nullable(),
    after: JournalMetricsSchema.nullable(),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/** Тело POST /api/__journal: новая запись (start) или дозаполнение after (finish). */
export const JournalPostSchema = z.union([
    z.object({
        ts: z.number(),
        fields: z.array(z.string()).min(1),
        before: JournalMetricsSchema.optional(),
    }),
    z.object({
        id: z.number(),
        after: JournalMetricsSchema,
    }),
]);
export type JournalPost = z.infer<typeof JournalPostSchema>;

/** UI анимации — следующий этап. */
const AnimSpecSchema = z.object({
    enabled: z.boolean(),
    /** ms, длительность transition маски from -> to */
    duration: z.number(),
    from: GradientSchema,
    to: GradientSchema,
});
export type AnimSpec = z.infer<typeof AnimSpecSchema>;

export const BlockStateSchema = z.object({
    /** px размер блока */
    w: z.number(),
    h: z.number(),
    /** px позиция левого верхнего угла на стейдже */
    x: z.number(),
    y: z.number(),
    /** px border-radius */
    radius: z.number(),
    base: BaseSpecSchema,
    layers: z.array(BgLayerSchema),
    mask: MaskSpecSchema,
    blur: BlurSpecSchema,
    blockBlend: BlendModeSchema,
    clipText: ClipTextSpecSchema,
    anim: AnimSpecSchema,
    compare: CompareSpecSchema,
    stage: StageSpecSchema,
    /** пересчёт кроп → макет; .default() — старые стейты без поля остаются валидными */
    export: ExportSpecSchema.default({ scale: 2, remBase: 10, designWidth: 1440 }),
});
export type BlockState = z.infer<typeof BlockStateSchema>;

export const GradientTargetSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('base') }),
    z.object({ kind: z.literal('layer'), index: z.number() }),
    z.object({ kind: z.literal('mask') }),
    z.object({ kind: z.literal('blurMask') }),
    z.object({ kind: z.literal('blurBg') }),
    z.object({ kind: z.literal('underlay') }),
    z.object({ kind: z.literal('clipText') }),
    z.object({ kind: z.literal('animFrom') }),
    z.object({ kind: z.literal('animTo') }),
]);
export type GradientTarget = z.infer<typeof GradientTargetSchema>;

export function defaultLinearGradient(angle = 180, stops?: Stop[]): LinearGradient {
    return {
        type: 'linear',
        angle,
        repeating: false,
        stops: stops ?? [
            { id: uid(), pos: 0, color: '#ffffff', alpha: 0 },
            { id: uid(), pos: 100, color: '#000000', alpha: 0.6 },
        ],
    };
}

export function defaultRadialGradient(stops?: Stop[]): RadialGradient {
    return {
        type: 'radial',
        cx: 50,
        cy: 50,
        shape: 'ellipse',
        size: 'farthest-side',
        rx: 50,
        ry: 50,
        repeating: false,
        stops: stops ?? defaultLinearGradient().stops,
    };
}

export function defaultBlockState(): BlockState {
    return {
        w: 360,
        h: 480,
        x: 120,
        y: 96,
        radius: 24,
        base: {
            kind: 'color',
            color: '#101010',
            gradient: defaultLinearGradient(90, [
                { id: uid(), pos: 0, color: '#101010', alpha: 1 },
                { id: uid(), pos: 100, color: '#101010', alpha: 0 },
            ]),
            image: null,
            fit: 'cover',
            posX: 50,
            posY: 50,
        },
        layers: [
            {
                id: uid(),
                visible: true,
                opacity: 1,
                blend: 'normal',
                gradient: defaultLinearGradient(180),
                rect: { x: 0, y: 0, w: 100, h: 100 },
            },
        ],
        mask: { enabled: false, gradient: defaultLinearGradient() },
        blur: {
            enabled: false,
            radius: 24,
            background: null,
            gradient: null,
            mask: null,
            rect: { x: 0, y: 0, w: 100, h: 100 },
            underlay: {
                enabled: false,
                rect: { x: 0, y: 0, w: 100, h: 100 },
                color: null,
                gradient: null,
            },
        },
        blockBlend: 'normal',
        clipText: {
            enabled: false,
            text: 'Gradient',
            gradient: {
                type: 'linear',
                angle: 90,
                repeating: false,
                stops: [
                    { id: uid(), pos: 0, color: '#7c6cff', alpha: 1 },
                    { id: uid(), pos: 100, color: '#ff5e8a', alpha: 1 },
                ],
            },
        },
        anim: {
            enabled: false,
            duration: 400,
            from: defaultLinearGradient(),
            to: defaultLinearGradient(0),
        },
        compare: {
            refImage: null,
            mode: 'off',
            opacity: 0.5,
            x: 0,
            y: 0,
            scale: 1,
            splitPos: 50,
            splitDir: 'vertical',
            tolerance: 10,
        },
        stage: {
            bg: 'checker',
            color: '#141416',
            image: null,
            x: 0,
            y: 0,
            scale: 100,
            isolated: true,
        },
        export: { scale: 2, remBase: 10, designWidth: 1440 },
    };
}
