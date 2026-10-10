import { uid } from '../schema';
import type {
    BgLayer,
    BlockState,
    BlurRect,
    BlurSpec,
    Gradient,
    LinearGradient,
    RadialGradient,
    Stop,
} from '../types';

/** Приёмы из реального кода onsport (rem = 10px, blur приведён к px). */
export interface BuiltinPreset {
    id: string;
    name: string;
    /** источник — путь в onsport */
    desc: string;
    apply: Partial<BlockState>;
}

/** [pos %, #hex, alpha] — фабрика стопов, каждый вызов даёт свежие объекты. */
type StopSpec = [pos: number, color: string, alpha: number];

function stops(specs: StopSpec[]): Stop[] {
    return specs.map(([pos, color, alpha]) => ({ id: uid(), pos, color, alpha }));
}

function lin(angle: number, stopSpecs: StopSpec[]): LinearGradient {
    return { type: 'linear', angle, repeating: false, stops: stops(stopSpecs) };
}

/** Радиальный explicit-эллипс: 'radial-gradient(ellipse Rx% Ry% at Cx% Cy%, …)'. */
function rad(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    stopSpecs: StopSpec[]
): RadialGradient {
    return {
        type: 'radial',
        cx,
        cy,
        shape: 'ellipse',
        size: 'explicit',
        rx,
        ry,
        repeating: false,
        stops: stops(stopSpecs),
    };
}

function layer(gradient: Gradient, opts?: { blend?: BgLayer['blend'] }): BgLayer {
    return {
        id: uid(),
        visible: true,
        opacity: 1,
        blend: opts?.blend ?? 'normal',
        gradient,
        rect: { x: 0, y: 0, w: 100, h: 100 },
    };
}

function blur(
    radius: number,
    opts: { background?: string; gradient?: Gradient; mask?: Gradient; rect?: BlurRect } = {}
): BlurSpec {
    return {
        enabled: true,
        radius,
        background: opts.background ?? null,
        gradient: opts.gradient ?? null,
        mask: opts.mask ?? null,
        rect: opts.rect ?? { x: 0, y: 0, w: 100, h: 100 },
        underlay: {
            enabled: false,
            rect: { x: 0, y: 0, w: 100, h: 100 },
            color: null,
            gradient: null,
        },
    };
}

export const BUILTIN_PRESETS: BuiltinPreset[] = [
    {
        id: 'onsport-training-card',
        name: 'Карточка тренировки',
        desc: 'onsport · blocks/mixins/training-card · ::after: один элемент = градиент + blur + маска',
        apply: {
            layers: [
                layer(
                    lin(180, [
                        [40, '#101010', 0],
                        [100, '#101010', 0.45],
                    ])
                ),
            ],
            // оригинал: ::after { left/right/bottom: 0; height: 15rem; blur(2rem);
            // background-image: linear-gradient(180deg, 0 50%, .1 72%, .22 86%, .38 100%);
            // mask-image: linear-gradient(0deg, #000 60%, transparent 100%) }
            // 15rem = 150px от низа блока 480px → rect y 68.75 / h 31.25;
            // стопы градиента и маски в оригинале относились именно к полосе
            blur: blur(20, {
                rect: { x: 0, y: 68.75, w: 100, h: 31.25 },
                gradient: lin(180, [
                    [50, '#101010', 0],
                    [72, '#101010', 0.1],
                    [86, '#101010', 0.22],
                    [100, '#101010', 0.38],
                ]),
                mask: lin(0, [
                    [0, '#000000', 1],
                    [60, '#000000', 1],
                    [100, '#000000', 0],
                ]),
            }),
        },
    },
    {
        id: 'onsport-directions-hero',
        name: 'Hero направлений',
        desc: 'onsport · blocks/includes/directions/hero',
        apply: {
            blur: blur(10, {
                mask: lin(0, [
                    [45, '#000000', 1],
                    [52, '#000000', 0.8],
                    [60, '#000000', 0],
                ]),
            }),
        },
    },
    {
        id: 'onsport-schedule-fog',
        name: 'Полоса тумана (расписание)',
        desc: 'onsport · blocks/includes/common/schedule',
        apply: {
            w: 600,
            h: 120,
            blur: blur(10, {
                mask: lin(180, [
                    [0, '#000000', 0],
                    [30, '#000000', 1],
                    [100, '#000000', 0],
                ]),
            }),
        },
    },
    {
        id: 'onsport-collections-vignette',
        name: 'Виньетки коллекций',
        desc: 'onsport · blocks/includes/directions/collections',
        apply: {
            layers: [
                layer(
                    rad(0, 60, 80, 80, [
                        [0, '#101010', 0.6],
                        [10, '#101010', 0.2],
                        [35, '#101010', 0.1],
                        [70, '#101010', 0],
                    ])
                ),
            ],
            blur: blur(30, {
                mask: rad(50, 50, 5, 35, [
                    [0, '#000000', 1],
                    [70, '#000000', 0],
                ]),
            }),
        },
    },
    {
        id: 'onsport-404-radial',
        name: 'Радиальный фон 404',
        desc: 'onsport · assets/sass/elements/body',
        apply: {
            layers: [
                layer(
                    rad(50.13, 48.83, 136.73, 225.13, [
                        [0, '#9EA9A2', 1],
                        [100, '#323733', 1],
                    ])
                ),
            ],
        },
    },
    {
        id: 'onsport-select-out-of-range',
        name: 'Селект: стопы вне диапазона',
        desc: 'onsport · blocks/mixins/select',
        apply: {
            layers: [
                layer(
                    lin(247.82, [
                        [-13.94, '#2F3B5F', 1],
                        [116.91, '#313C5F', 1],
                    ])
                ),
            ],
        },
    },
    {
        id: 'onsport-assistant-veil',
        name: 'Вуаль ассистента',
        desc: 'onsport · blocks/mixins/assistant · один элемент = градиент + blur + маска',
        apply: {
            // оригинал (assistant.sass:76-80): background linear-gradient(0deg, .2/.1@75/0)
            // + backdrop-filter blur(50px) + mask #000, #000 25%, #000e 45%, transparent
            blur: blur(50, {
                gradient: lin(0, [
                    [0, '#575757', 0.2],
                    [75, '#575757', 0.1],
                    [100, '#575757', 0],
                ]),
                mask: lin(0, [
                    [0, '#000000', 1],
                    [25, '#000000', 1],
                    [45, '#000000', 0.93],
                    [100, '#000000', 0],
                ]),
            }),
        },
    },
    {
        id: 'onsport-club-load-text',
        name: 'Текст с градиентом (club-load)',
        desc: 'onsport · blocks/includes/main/club-load',
        apply: {
            w: 600,
            h: 140,
            clipText: {
                enabled: true,
                text: 'Онлайн-тренировки',
                gradient: lin(125, [
                    [0, '#FFFFFF', 1],
                    [100, '#FFFFFF', 0],
                ]),
            },
        },
    },
    {
        id: 'onsport-assistant-glow',
        name: 'Свечение ассистента (screen)',
        desc: 'onsport · blocks/mixins/assistant (в оригинале inset box-shadow)',
        apply: {
            layers: [
                layer(
                    lin(180, [
                        [0, '#D7A65E', 0.35],
                        [100, '#D7A65E', 0.35],
                    ]),
                    { blend: 'screen' }
                ),
            ],
            blur: blur(25),
        },
    },
    {
        id: 'onsport-slider-edge-fade',
        name: 'Край слайдера: растворение границ',
        desc: 'оверлей на слайдер: градиентная база + blur растворяют границы (запрос фронт-лида)',
        apply: {
            w: 600,
            h: 300,
            base: {
                kind: 'gradient',
                color: '#101010',
                gradient: lin(90, [
                    [0, '#101010', 1],
                    [30, '#101010', 1],
                    [100, '#101010', 0],
                ]),
                image: null,
                fit: 'cover',
                posX: 50,
                posY: 50,
            },
            blur: blur(20, {
                mask: lin(90, [
                    [0, '#000000', 0],
                    [25, '#000000', 1],
                    [75, '#000000', 1],
                    [100, '#000000', 0],
                ]),
            }),
        },
    },
];
