import { useState } from 'react';
import { BLEND_MODES, RADIAL_SIZES } from '../constants';
import { useLabStore } from '../store';
import { blurRectBox } from '../lib/axis';
import {
    fitStops,
    sampleAlongLinear,
    sampleAlongRadial,
    samplesForColorTarget,
    samplesForMaskTarget,
} from '../lib/autofit';
import { getCanvas } from '../lib/imageCache';
import { assignGradient, isAlphaTarget, targetAxisRect, targetToKey, readGradient } from '../targets';
import type {
    BgLayer,
    BlurRect,
    Gradient,
    GradientTarget,
    LinearGradient,
    RadialGradient,
    Stop,
} from '../types';
import { GradientBar } from './GradientBar';
import { ColorField } from './ui/ColorField';
import { NumberField } from './ui/NumberField';
import { SegmentedControl } from './ui/SegmentedControl';
import { SelectField } from './ui/SelectField';
import { Toggle } from './ui/Toggle';
import { UnitSlider } from './ui/UnitSlider';
import { DistributeIcon, ReverseIcon } from './icons';

interface GradientEditorProps {
    target: GradientTarget;
}

function toRadial(g: Gradient): RadialGradient {
    if (g.type === 'radial') return g;
    return {
        type: 'radial',
        cx: 50,
        cy: 50,
        shape: 'ellipse',
        size: 'farthest-side',
        rx: 50,
        ry: 50,
        repeating: g.repeating,
        stops: g.stops,
    };
}

function toLinear(g: Gradient): LinearGradient {
    if (g.type === 'linear') return g;
    return { type: 'linear', angle: 90, repeating: g.repeating, stops: g.stops };
}

function round01(n: number): number {
    return Math.round(n * 10) / 10;
}

/** Главный редактор градиента таргета (layer / mask / blur-таргеты / underlay / clipText / anim). */
export function GradientEditor({ target }: GradientEditorProps) {
    const gradient = useLabStore((s) => s.getGradient(target));
    const selectedStopId = useLabStore((s) => s.selectedStopId);
    const setSelectedStop = useLabStore((s) => s.setSelectedStop);
    const update = useLabStore((s) => s.update);
    const pushHistory = useLabStore((s) => s.pushHistory);
    const refImage = useLabStore((s) => s.state.compare.refImage);
    // подпись прошлого подбора показываем только для таргета, на котором он сделан
    const [fit, setFit] = useState<{ targetKey: string; count: number; error: number } | null>(
        null
    );
    const layer = useLabStore((s) =>
        target.kind === 'layer' ? (s.state.layers[target.index] ?? null) : null
    );

    if (!gradient) return null;

    // канонический ключ таргета (targetToKey): различает blurMask/blurBg
    // слоёв 0/1 — fit-бейдж живёт только в редакторе слоя, где сделан подбор
    const targetKey = targetToKey(target);
    const fitInfo = fit !== null && fit.targetKey === targetKey ? fit : null;

    const selectedStop = gradient.stops.find((s) => s.id === selectedStopId) ?? null;

    const switchType = (type: 'linear' | 'radial') => {
        if (gradient.type === type) return;
        update((d) => {
            const g = readGradient(d, target);
            if (!g) return;
            assignGradient(d, target, type === 'radial' ? toRadial(g) : toLinear(g));
        });
    };

    const patchStop = (
        id: string,
        patch: Partial<Pick<Stop, 'color' | 'alpha' | 'pos'>>,
        transient = false
    ) => {
        update(
            (d) => {
                const g = readGradient(d, target);
                const stop = g?.stops.find((s) => s.id === id);
                if (stop) Object.assign(stop, patch);
            },
            { transient }
        );
    };

    const deleteStop = () => {
        if (!selectedStop || gradient.stops.length <= 2) return;
        update((d) => {
            const g = readGradient(d, target);
            if (!g) return;
            g.stops = g.stops.filter((s) => s.id !== selectedStop.id);
        });
        setSelectedStop(null);
    };

    const reverseStops = () => {
        update((d) => {
            const g = readGradient(d, target);
            if (!g) return;
            g.stops = g.stops
                .map((s) => ({ ...s, pos: round01(100 - s.pos) }))
                .sort((a, b) => a.pos - b.pos);
        });
    };

    const distributeStops = () => {
        update((d) => {
            const g = readGradient(d, target);
            if (!g || g.stops.length === 0) return;
            const sorted = [...g.stops].sort((a, b) => a.pos - b.pos);
            const n = sorted.length;
            sorted.forEach((s, i) => {
                s.pos = n === 1 ? 0 : round01((i / (n - 1)) * 100);
            });
            g.stops = sorted;
        });
    };

    const patchLayer = (patch: Partial<Pick<BgLayer, 'opacity' | 'blend'>>, transient = false) => {
        if (!layer) return;
        update(
            (d) => {
                const l = target.kind === 'layer' ? d.layers[target.index] : undefined;
                if (l) Object.assign(l, patch);
            },
            { transient }
        );
    };

    // область слоя (rect): % от блока, по образцу blur-rect в инспекторе
    const patchLayerRect = (patch: Partial<BlurRect>) => {
        update((d) => {
            const l = target.kind === 'layer' ? d.layers[target.index] : undefined;
            if (l) Object.assign(l.rect, patch);
        });
    };

    // автоподбор стопов по референсу: сэмплируем картинку вдоль оси градиента,
    // жадно фитим стопы; маски берут альфу (или luminance), остальное — цвет
    const onAutofit = async () => {
        if (refImage === null) return;
        const st = useLabStore.getState().state;
        const g = readGradient(st, target);
        if (!g) return;
        try {
            const canvas = await getCanvas(refImage);
            // rect-таргеты (blur/underlay) сэмплируем в системе их rect —
            // как анализ и хэндлы
            const axisRect = targetAxisRect(st, target);
            const axisBox =
                axisRect !== undefined
                    ? blurRectBox(axisRect, { x: 0, y: 0, w: st.w, h: st.h })
                    : undefined;
            const common = { block: { w: st.w, h: st.h }, compare: st.compare, axisBox };
            const raw =
                g.type === 'linear'
                    ? sampleAlongLinear(canvas, { ...common, angle: g.angle })
                    : sampleAlongRadial(canvas, {
                          ...common,
                          cx: g.cx,
                          cy: g.cy,
                          shape: g.shape,
                          size: g.size,
                          rx: g.rx,
                          ry: g.ry,
                      });
            const samples = isAlphaTarget(target.kind)
                ? samplesForMaskTarget(raw)
                : samplesForColorTarget(raw);
            const { stops, error } = fitStops(samples);
            if (stops.length === 0) return;
            update((d) => {
                const dg = readGradient(d, target);
                if (dg) dg.stops = stops;
            });
            setSelectedStop(null);
            setFit({ targetKey, count: stops.length, error: Math.round(error) });
        } catch {
            // референс не удалось загрузить — стопы остаются как есть
        }
    };

    return (
        <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-lab-border bg-lab-panel2/60 p-3">
            <div className="flex items-center justify-between gap-2">
                <SegmentedControl
                    value={gradient.type}
                    options={[
                        { value: 'linear' as const, label: 'Линейный' },
                        { value: 'radial' as const, label: 'Радиальный' },
                    ]}
                    onChange={switchType}
                />
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        title="Развернуть (reverse стопов)"
                        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-lab-border bg-lab-panel2 text-lab-muted hover:border-lab-accent hover:text-lab-text"
                        onClick={reverseStops}
                    >
                        <ReverseIcon />
                    </button>
                    <button
                        type="button"
                        title="Выровнять стопы равномерно"
                        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-lab-border bg-lab-panel2 text-lab-muted hover:border-lab-accent hover:text-lab-text"
                        onClick={distributeStops}
                    >
                        <DistributeIcon />
                    </button>
                </div>
            </div>

            {gradient.type === 'linear' ? (
                <div className="flex items-end justify-between gap-3">
                    <div className="w-[88px]">
                        <NumberField
                            label="Угол, °"
                            value={gradient.angle}
                            min={-360}
                            max={360}
                            step={1}
                            onChange={(v) =>
                                update((d) => {
                                    const g = readGradient(d, target);
                                    if (g?.type === 'linear') g.angle = v;
                                })
                            }
                        />
                    </div>
                    <div className="pb-1.5">
                        <Toggle
                            label="Повтор"
                            checked={gradient.repeating}
                            onChange={(v) =>
                                update((d) => {
                                    const g = readGradient(d, target);
                                    if (g) g.repeating = v;
                                })
                            }
                        />
                    </div>
                </div>
            ) : (
                <div className="flex min-w-0 flex-col gap-2.5">
                    <div className="flex items-end justify-between gap-2">
                        <SegmentedControl
                            value={gradient.shape}
                            options={[
                                { value: 'circle' as const, label: 'Круг' },
                                { value: 'ellipse' as const, label: 'Эллипс' },
                            ]}
                            onChange={(v) =>
                                update((d) => {
                                    const g = readGradient(d, target);
                                    if (g?.type === 'radial') g.shape = v;
                                })
                            }
                        />
                        <div className="min-w-0 flex-1">
                            <SelectField
                                label="Размер"
                                value={gradient.size}
                                options={RADIAL_SIZES}
                                onChange={(v) =>
                                    update((d) => {
                                        const g = readGradient(d, target);
                                        if (g?.type === 'radial') g.size = v;
                                    })
                                }
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <NumberField
                            label="Центр X, %"
                            value={gradient.cx}
                            step={0.1}
                            onChange={(v) =>
                                update((d) => {
                                    const g = readGradient(d, target);
                                    if (g?.type === 'radial') g.cx = v;
                                })
                            }
                        />
                        <NumberField
                            label="Центр Y, %"
                            value={gradient.cy}
                            step={0.1}
                            onChange={(v) =>
                                update((d) => {
                                    const g = readGradient(d, target);
                                    if (g?.type === 'radial') g.cy = v;
                                })
                            }
                        />
                    </div>
                    {gradient.size === 'explicit' && (
                        <div className="grid grid-cols-2 gap-2">
                            <NumberField
                                label="Радиус X, %"
                                value={gradient.rx}
                                min={0}
                                onChange={(v) =>
                                    update((d) => {
                                        const g = readGradient(d, target);
                                        if (g?.type === 'radial') g.rx = v;
                                    })
                                }
                            />
                            <NumberField
                                label="Радиус Y, %"
                                value={gradient.ry}
                                min={0}
                                onChange={(v) =>
                                    update((d) => {
                                        const g = readGradient(d, target);
                                        if (g?.type === 'radial') g.ry = v;
                                    })
                                }
                            />
                        </div>
                    )}
                    <Toggle
                        label="Повтор"
                        checked={gradient.repeating}
                        onChange={(v) =>
                            update((d) => {
                                const g = readGradient(d, target);
                                if (g) g.repeating = v;
                            })
                        }
                    />
                </div>
            )}

            <GradientBar target={target} />

            {selectedStop !== null && (
                // key по id стопа: при смене выделения контролы перемонтируются,
                // иначе NumberField/UnitSlider держат черновик старого стопа,
                // пока не сойдёт фокус (NumberField хранит text между рендерами)
                <div
                    key={selectedStop.id}
                    className="flex flex-col gap-2.5 border-t border-lab-border pt-2.5"
                >
                    <ColorField
                        label="Цвет стопа"
                        value={selectedStop.color}
                        onChange={(hex, continuous) =>
                            patchStop(selectedStop.id, { color: hex }, continuous === true)
                        }
                        onGestureStart={pushHistory}
                    />
                    <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                        <NumberField
                            label="Позиция, %"
                            value={selectedStop.pos}
                            step={0.1}
                            onChange={(v) => patchStop(selectedStop.id, { pos: v })}
                        />
                        <button
                            type="button"
                            className="cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2.5 py-1.5 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text disabled:cursor-default disabled:opacity-40"
                            disabled={gradient.stops.length <= 2}
                            onClick={deleteStop}
                        >
                            Удалить стоп
                        </button>
                    </div>
                    <UnitSlider
                        label="Прозрачность стопа"
                        value={selectedStop.alpha}
                        min={0}
                        max={1}
                        step={0.01}
                        onChange={(v, continuous) =>
                            patchStop(selectedStop.id, { alpha: v }, continuous === true)
                        }
                        onGestureStart={pushHistory}
                    />
                </div>
            )}

            {layer !== null && (
                <div className="flex flex-col gap-2.5 border-t border-lab-border pt-2.5">
                    <UnitSlider
                        label="Непрозрачность слоя"
                        value={layer.opacity}
                        min={0}
                        max={1}
                        step={0.01}
                        onChange={(v, continuous) =>
                            patchLayer({ opacity: v }, continuous === true)
                        }
                        onGestureStart={pushHistory}
                    />
                    <SelectField
                        label="Режим наложения"
                        value={layer.blend}
                        options={BLEND_MODES}
                        onChange={(v) => patchLayer({ blend: v })}
                    />
                    <div className="grid grid-cols-2 gap-2">
                        <NumberField
                            label="Область X, %"
                            value={layer.rect.x}
                            step={0.1}
                            onChange={(v) => patchLayerRect({ x: v })}
                        />
                        <NumberField
                            label="Область Y, %"
                            value={layer.rect.y}
                            step={0.1}
                            onChange={(v) => patchLayerRect({ y: v })}
                        />
                        <NumberField
                            label="Область W, %"
                            value={layer.rect.w}
                            min={1}
                            step={0.1}
                            onChange={(v) => patchLayerRect({ w: v })}
                        />
                        <NumberField
                            label="Область H, %"
                            value={layer.rect.h}
                            min={1}
                            step={0.1}
                            onChange={(v) => patchLayerRect({ h: v })}
                        />
                    </div>
                    <p className="text-[10px] leading-relaxed text-lab-muted">
                        Канвас: тяни за контур и углы · Shift — пропорция · Alt — двигать блок
                    </p>
                    <button
                        type="button"
                        title="Сбросить область слоя на весь блок"
                        className="cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2.5 py-1.5 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text"
                        onClick={() =>
                            update((d) => {
                                const l =
                                    target.kind === 'layer' ? d.layers[target.index] : undefined;
                                if (l) l.rect = { x: 0, y: 0, w: 100, h: 100 };
                            })
                        }
                    >
                        Во весь блок
                    </button>
                </div>
            )}

            <div className="flex flex-col gap-1.5 border-t border-lab-border pt-2.5">
                <button
                    type="button"
                    className="cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2.5 py-1.5 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text disabled:cursor-default disabled:opacity-40"
                    disabled={refImage === null}
                    title={
                        refImage !== null
                            ? 'Сэмплировать референс вдоль оси градиента и подобрать стопы'
                            : 'Сначала загрузите референс в секции «Сравнение с макетом»'
                    }
                    onClick={() => void onAutofit()}
                >
                    Подобрать по референсу
                </button>
                {fitInfo !== null && (
                    <span className="text-[10px] leading-none text-lab-muted">
                        {fitInfo.count} стопов, ошибка ~{fitInfo.error}/255
                    </span>
                )}
            </div>
        </div>
    );
}
