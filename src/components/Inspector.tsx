import { Fragment, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { BASE_FITS, BLEND_MODES } from '../constants';
import { defaultBlurLayer, defaultLinearGradient, uid } from '../schema';
import { fmtNum, parseRgba, rgbaString } from '../lib/color';
import { blurEdgeIssues } from '../lib/blurEdges';
import { getImage } from '../lib/imageCache';
import { fitBlockToAspect } from '../lib/validate';
import { useLabStore } from '../store';
import type { BaseSpec, StageSpec } from '../types';
import { AnimSection } from './AnimSection';
import { GradientEditor } from './GradientEditor';
import { LayerList } from './LayerList';
import { CompareSection } from './CompareSection';
import { CollapsibleSection } from './ui/CollapsibleSection';
import { ColorField } from './ui/ColorField';
import { NumberField } from './ui/NumberField';
import { SegmentedControl } from './ui/SegmentedControl';
import { SelectField } from './ui/SelectField';
import { Toggle } from './ui/Toggle';
import { UnitSlider } from './ui/UnitSlider';

/** Blob из буфера обмена -> dataURL. */
function readBlobAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/** Строка пересчёта «лейбл / значение»: две линии (лейбл сверху, значение снизу с переносом). */
function HintRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex w-full min-w-0 flex-col gap-0.5">
            <span className="text-[10px] leading-none text-lab-muted">{label}</span>
            <span className="w-full min-w-0 font-mono text-[11px] leading-snug tabular-nums break-words text-lab-text">
                {value}
            </span>
        </div>
    );
}

/**
 * Пересчёт величин кропа в величины макета: pxcss = pct/100 · блок / scale;
 * rem = pxcss / remBase; % макета = pxcss / designWidth · 100. Показывает
 * ключевые размеры blur/underlay live, агент считает сам по формуле из API.md.
 */
function ExportRecalcPanel() {
    const state = useLabStore((s) => s.state);
    const update = useLabStore((s) => s.update);
    const ex = state.export;

    // значения в одну строку с разделителем «·», округление до 1 знака —
    // чтобы хвосты не вылезали за панель при любых числах
    const chain = (pxcss: number): string =>
        `${fmtNum(pxcss, 1)}px · ${fmtNum(pxcss / ex.remBase, 1)}rem · ${fmtNum((pxcss / ex.designWidth) * 100, 1)}% макета`;
    const fromPct = (pct: number, basePx: number): string =>
        chain((pct / 100) * (basePx / ex.scale));

    return (
        <div className="flex flex-col gap-2 border-t border-lab-border pt-2.5">
            <span className="text-[11px] leading-none text-lab-muted">Пересчёт в макет</span>
            <div className="grid grid-cols-3 gap-2">
                <NumberField
                    label="Scale"
                    value={ex.scale}
                    min={1}
                    step={0.5}
                    onChange={(v) =>
                        update((d) => {
                            d.export.scale = v;
                        })
                    }
                />
                <NumberField
                    label="rem base"
                    value={ex.remBase}
                    min={1}
                    onChange={(v) =>
                        update((d) => {
                            d.export.remBase = v;
                        })
                    }
                />
                <NumberField
                    label="Макет, px"
                    value={ex.designWidth}
                    min={100}
                    onChange={(v) =>
                        update((d) => {
                            d.export.designWidth = v;
                        })
                    }
                />
            </div>
            <div className="flex flex-col gap-1">
                {state.blur.enabled &&
                    state.blur.layers.map(
                        (layer, i) =>
                            layer.visible && (
                                <Fragment key={layer.id}>
                                    <HintRow
                                        label={`блюр ${i + 1} лево ${fmtNum(layer.rect.x)}%`}
                                        value={fromPct(layer.rect.x, state.w)}
                                    />
                                    <HintRow
                                        label={`блюр ${i + 1} право ${fmtNum(layer.rect.x + layer.rect.w)}%`}
                                        value={fromPct(layer.rect.x + layer.rect.w, state.w)}
                                    />
                                    <HintRow
                                        label={`блюр ${i + 1} ширина ${fmtNum(layer.rect.w)}%`}
                                        value={fromPct(layer.rect.w, state.w)}
                                    />
                                    <HintRow
                                        label={`блюр ${i + 1} радиус ${fmtNum(layer.radius)}px`}
                                        value={chain(layer.radius / ex.scale)}
                                    />
                                </Fragment>
                            )
                    )}
                {state.blur.underlay.enabled && (
                    <HintRow
                        label={`underlay высота ${fmtNum(state.blur.underlay.rect.h)}%`}
                        value={fromPct(state.blur.underlay.rect.h, state.h)}
                    />
                )}
            </div>
            <p className="text-[10px] leading-relaxed text-lab-muted">
                px макета = % кропа / 100 × ширина блока / scale; rem = px / remBase
            </p>
        </div>
    );
}

/**
 * Карточка blur-слоя (до двух на блок): видимость, радиус, rect-область,
 * маска растворения (blurMask layer N) и заливка (blurBg layer N).
 * Слой 0 — «::before», слой 1 — «::after» (пара псевдо или два div — на
 * усмотрение вёрстки); инлайн-бейдж — жёсткая кромка (маска не доведена до
 * α≈0 у внутренней границы rect).
 */
function BlurLayerCard({ index }: { index: number }) {
    const state = useLabStore((s) => s.state);
    const activeTarget = useLabStore((s) => s.activeTarget);
    const update = useLabStore((s) => s.update);
    const pushHistory = useLabStore((s) => s.pushHistory);
    const setActiveTarget = useLabStore((s) => s.setActiveTarget);
    const layer = state.blur.layers[index];
    if (layer === undefined) return null;
    const pseudo = index === 0 ? '::before' : '::after';

    // заливка-цвет хранится rgba-строкой — разбираем для ColorField/слайдера
    const bgParsed = layer.background
        ? (parseRgba(layer.background) ?? { hex: '#000000', alpha: 0.2 })
        : null;
    const setLayerBackground = (hex: string, alpha: number, transient: boolean) => {
        update(
            (d) => {
                const l = d.blur.layers[index];
                if (l) l.background = rgbaString(hex, alpha);
            },
            { transient }
        );
    };

    // жёсткая кромка: rect зажат внутри блока, а маска у кромки не в α0
    const edgeIssue = blurEdgeIssues(state).find((issue) => issue.layer === index) ?? null;

    const removeLayer = () => {
        update((d) => {
            d.blur.layers.splice(index, 1);
            // удалили последний — глушим мастер-тумблер (секция схлопывается)
            if (d.blur.layers.length === 0) d.blur.enabled = false;
        });
        // таргет удалённого слоя уводим на нейтральный, таргет слоя выше —
        // сдвигаем вниз (индексы слоёв после splice сместились)
        if (activeTarget.kind === 'blurMask' || activeTarget.kind === 'blurBg') {
            if (activeTarget.layer === index) {
                setActiveTarget({ kind: 'layer', index: 0 });
            } else if (activeTarget.layer > index) {
                setActiveTarget({ kind: activeTarget.kind, layer: activeTarget.layer - 1 });
            }
        }
    };

    return (
        <div className="flex flex-col gap-2.5 rounded-lg border border-lab-border bg-lab-panel2/60 p-2.5">
            <div className="flex items-center gap-2">
                <span className="text-[11px] leading-none text-lab-text">
                    Слой {index + 1} — {pseudo}
                </span>
                <div className="ml-auto flex items-center gap-2">
                    <Toggle
                        label="Видим"
                        checked={layer.visible}
                        onChange={(v) =>
                            update((d) => {
                                const l = d.blur.layers[index];
                                if (l) l.visible = v;
                            })
                        }
                    />
                    <button
                        type="button"
                        title={`Удалить слой ${index + 1}`}
                        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-lab-border bg-lab-panel2 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text"
                        onClick={removeLayer}
                    >
                        ×
                    </button>
                </div>
            </div>
            {edgeIssue !== null && (
                <p
                    className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-400"
                    title="rect слоя зажат внутри блока, а маска у его кромки не растворяется — видна резкая граница backdrop-filter"
                >
                    Жёсткая кромка у {edgeIssue.edges.join(' и ')} границы rect (α маски{' '}
                    {fmtNum(edgeIssue.maxAlpha, 2)} у кромки) — вытяни стоп до α0 за кромку, позиции
                    стопов могут быть вне 0–100%
                </p>
            )}
            <NumberField
                label="Радиус, px"
                value={layer.radius}
                min={0}
                max={200}
                onChange={(v) =>
                    update((d) => {
                        const l = d.blur.layers[index];
                        if (l) l.radius = v;
                    })
                }
            />
            <div className="grid grid-cols-2 gap-2">
                <NumberField
                    label="Область X, %"
                    value={layer.rect.x}
                    step={0.1}
                    onChange={(v) =>
                        update((d) => {
                            const l = d.blur.layers[index];
                            if (l) l.rect.x = v;
                        })
                    }
                />
                <NumberField
                    label="Область Y, %"
                    value={layer.rect.y}
                    step={0.1}
                    onChange={(v) =>
                        update((d) => {
                            const l = d.blur.layers[index];
                            if (l) l.rect.y = v;
                        })
                    }
                />
                <NumberField
                    label="Область W, %"
                    value={layer.rect.w}
                    min={1}
                    step={0.1}
                    onChange={(v) =>
                        update((d) => {
                            const l = d.blur.layers[index];
                            if (l) l.rect.w = v;
                        })
                    }
                />
                <NumberField
                    label="Область H, %"
                    value={layer.rect.h}
                    min={1}
                    step={0.1}
                    onChange={(v) =>
                        update((d) => {
                            const l = d.blur.layers[index];
                            if (l) l.rect.h = v;
                        })
                    }
                />
            </div>
            <button
                type="button"
                title="Сбросить область слоя на весь блок"
                className="cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2.5 py-1.5 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text"
                onClick={() =>
                    update((d) => {
                        const l = d.blur.layers[index];
                        if (l) l.rect = { x: 0, y: 0, w: 100, h: 100 };
                    })
                }
            >
                Во весь блок
            </button>
            <div className="flex flex-col gap-2 border-t border-lab-border pt-2.5">
                <Toggle
                    label="Маска растворения"
                    checked={layer.mask !== null}
                    onChange={(v) => {
                        update((d) => {
                            const l = d.blur.layers[index];
                            if (l) l.mask = v ? defaultLinearGradient() : null;
                        });
                        if (v) setActiveTarget({ kind: 'blurMask', layer: index });
                    }}
                />
                {layer.mask !== null && (
                    <GradientEditor target={{ kind: 'blurMask', layer: index }} />
                )}
            </div>
            <div className="flex flex-col gap-2 border-t border-lab-border pt-2.5">
                <SegmentedControl
                    value={
                        layer.gradient !== null
                            ? ('gradient' as const)
                            : layer.background !== null
                              ? ('color' as const)
                              : ('none' as const)
                    }
                    options={[
                        { value: 'none' as const, label: 'Нет' },
                        { value: 'color' as const, label: 'Цвет' },
                        { value: 'gradient' as const, label: 'Градиент' },
                    ]}
                    onChange={(v) => {
                        update((d) => {
                            const l = d.blur.layers[index];
                            if (l === undefined) return;
                            if (v === 'none') {
                                l.gradient = null;
                                l.background = null;
                            } else if (v === 'color') {
                                l.gradient = null;
                                if (l.background === null) {
                                    l.background = 'rgba(255, 255, 255, 0.2)';
                                }
                            } else if (l.gradient === null) {
                                l.gradient = defaultLinearGradient(0, [
                                    { id: uid(), pos: 0, color: '#101010', alpha: 0.4 },
                                    { id: uid(), pos: 100, color: '#101010', alpha: 0 },
                                ]);
                            }
                        });
                        if (v === 'gradient') setActiveTarget({ kind: 'blurBg', layer: index });
                        else if (activeTarget.kind === 'blurBg' && activeTarget.layer === index) {
                            setActiveTarget({ kind: 'layer', index: 0 });
                        }
                    }}
                />
                {layer.gradient === null && bgParsed !== null && (
                    <>
                        <ColorField
                            label="Подложка"
                            value={bgParsed.hex}
                            onChange={(hex, continuous) =>
                                setLayerBackground(hex, bgParsed.alpha, continuous === true)
                            }
                            onGestureStart={pushHistory}
                            onClear={() =>
                                update((d) => {
                                    const l = d.blur.layers[index];
                                    if (l) l.background = null;
                                })
                            }
                        />
                        <UnitSlider
                            label="Прозрачность подложки"
                            value={bgParsed.alpha}
                            min={0}
                            max={1}
                            step={0.01}
                            onChange={(v, continuous) =>
                                setLayerBackground(bgParsed.hex, v, continuous === true)
                            }
                            onGestureStart={pushHistory}
                        />
                    </>
                )}
                {layer.gradient !== null && (
                    <GradientEditor target={{ kind: 'blurBg', layer: index }} />
                )}
            </div>
        </div>
    );
}

/** Правая панель: блок, стейдж, слои, маска, blur, clip-text. */
export function Inspector() {
    const state = useLabStore((s) => s.state);
    const activeTarget = useLabStore((s) => s.activeTarget);
    const update = useLabStore((s) => s.update);
    const pushHistory = useLabStore((s) => s.pushHistory);
    const setActiveTarget = useLabStore((s) => s.setActiveTarget);
    const fileRef = useRef<HTMLInputElement>(null);
    const stageFileRef = useRef<HTMLInputElement>(null);
    // подпись под кнопкой «Из буфера»: нет прав / нет картинки в буфере
    const [clipboardNote, setClipboardNote] = useState<string | null>(null);

    const patchBase = (patch: Partial<BaseSpec>, transient = false) => {
        update(
            (d) => {
                Object.assign(d.base, patch);
            },
            { transient }
        );
    };

    const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            update((d) => {
                d.base.kind = 'image';
                d.base.image = String(reader.result);
            });
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    };

    // подгонка w/h под аспект натурального размера картинки: сохраняется та
    // сторона, чья относительная правка меньше (меньшая деформация блока)
    const fitBlockToImage = () => {
        const src = state.base.image;
        if (src === null) return;
        getImage(src)
            .then((img) => {
                if (img.naturalWidth === 0 || img.naturalHeight === 0) return;
                const fit = fitBlockToAspect(
                    state.w,
                    state.h,
                    img.naturalWidth / img.naturalHeight
                );
                update((d) => {
                    d.w = fit.w;
                    d.h = fit.h;
                });
            })
            .catch(() => {
                // картинка не загрузилась — оставляем размеры как есть
            });
    };

    const patchStage = (patch: Partial<StageSpec>, transient = false) => {
        update(
            (d) => {
                Object.assign(d.stage, patch);
            },
            { transient }
        );
    };

    const setStageImage = (dataUrl: string) => {
        update((d) => {
            d.stage.bg = 'image';
            d.stage.image = dataUrl;
        });
    };

    const onStagePickFile = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file && file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = () => setStageImage(String(reader.result));
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    };

    // буфер обмена через Async Clipboard API (отличается от Ctrl+V -> compare.refImage)
    const onStageClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const type = item.types.find((t) => t.startsWith('image/'));
                if (type === undefined) continue;
                setStageImage(await readBlobAsDataUrl(await item.getType(type)));
                setClipboardNote(null);
                return;
            }
            setClipboardNote('В буфере нет картинки');
        } catch {
            setClipboardNote(
                'Буфер недоступен, используй Ctrl+V в поле референса или загрузи файл'
            );
        }
    };

    // цвет underlay — тоже rgba-строка
    const underlay = state.blur.underlay;
    const underlayParsed = underlay.color
        ? (parseRgba(underlay.color) ?? { hex: '#000000', alpha: 0.45 })
        : null;

    const setUnderlayColor = (hex: string, alpha: number, transient: boolean) => {
        update(
            (d) => {
                d.blur.underlay.color = rgbaString(hex, alpha);
            },
            { transient }
        );
    };

    return (
        <aside className="flex w-[360px] shrink-0 flex-col overflow-y-auto border-l border-lab-border bg-lab-panel">
            <CollapsibleSection title="Блок">
                <div className="grid grid-cols-2 gap-2">
                    <NumberField
                        label="Ширина, px"
                        value={state.w}
                        min={24}
                        onChange={(v) =>
                            update((d) => {
                                d.w = v;
                            })
                        }
                    />
                    <NumberField
                        label="Высота, px"
                        value={state.h}
                        min={24}
                        onChange={(v) =>
                            update((d) => {
                                d.h = v;
                            })
                        }
                    />
                    <NumberField
                        label="Радиус, px"
                        value={state.radius}
                        min={0}
                        onChange={(v) =>
                            update((d) => {
                                d.radius = v;
                            })
                        }
                    />
                    <NumberField
                        label="X, px"
                        value={state.x}
                        onChange={(v) =>
                            update((d) => {
                                d.x = v;
                            })
                        }
                    />
                    <NumberField
                        label="Y, px"
                        value={state.y}
                        onChange={(v) =>
                            update((d) => {
                                d.y = v;
                            })
                        }
                    />
                    <SelectField
                        label="Наложение блока"
                        value={state.blockBlend}
                        options={BLEND_MODES}
                        onChange={(v) =>
                            update((d) => {
                                d.blockBlend = v;
                            })
                        }
                    />
                </div>
                <SegmentedControl
                    value={state.base.kind}
                    options={[
                        { value: 'color' as const, label: 'Цвет' },
                        { value: 'gradient' as const, label: 'Градиент' },
                        { value: 'image' as const, label: 'Картинка' },
                    ]}
                    onChange={(v) => {
                        patchBase({ kind: v });
                        if (v === 'gradient') {
                            setActiveTarget({ kind: 'base' });
                        } else if (activeTarget.kind === 'base') {
                            setActiveTarget({ kind: 'layer', index: 0 });
                        }
                    }}
                />
                {state.base.kind === 'color' ? (
                    <ColorField
                        label="Цвет базы"
                        value={state.base.color}
                        onChange={(hex, continuous) =>
                            patchBase({ color: hex }, continuous === true)
                        }
                        onGestureStart={pushHistory}
                    />
                ) : state.base.kind === 'gradient' ? (
                    <GradientEditor target={{ kind: 'base' }} />
                ) : (
                    <div className="flex flex-col gap-2.5">
                        <input
                            ref={fileRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={onPickFile}
                        />
                        <div className="flex items-center gap-2">
                            {state.base.image && (
                                <img
                                    src={state.base.image}
                                    alt=""
                                    className="h-8 w-12 shrink-0 rounded border border-lab-border object-cover"
                                />
                            )}
                            <button
                                type="button"
                                className="min-w-0 flex-1 cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2 py-1.5 text-xs hover:border-lab-accent"
                                onClick={() => fileRef.current?.click()}
                            >
                                {state.base.image ? 'Заменить картинку' : 'Загрузить'}
                            </button>
                            {state.base.image && (
                                <button
                                    type="button"
                                    title="Убрать картинку"
                                    className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-lab-border bg-lab-panel2 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text"
                                    onClick={() => patchBase({ image: null })}
                                >
                                    ×
                                </button>
                            )}
                        </div>
                        <SelectField
                            label="Вписывание"
                            value={state.base.fit}
                            options={BASE_FITS}
                            onChange={(v) => patchBase({ fit: v })}
                        />
                        <button
                            type="button"
                            className="cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2 py-1.5 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text disabled:cursor-default disabled:opacity-40"
                            disabled={state.base.image === null}
                            title="Ширина/высота под аспект натурального размера картинки (меньшая деформация)"
                            onClick={fitBlockToImage}
                        >
                            Подогнать блок под картинку
                        </button>
                        <UnitSlider
                            label="Позиция X"
                            unit="%"
                            value={state.base.posX}
                            min={0}
                            max={100}
                            step={1}
                            onChange={(v, continuous) =>
                                patchBase({ posX: v }, continuous === true)
                            }
                            onGestureStart={pushHistory}
                        />
                        <UnitSlider
                            label="Позиция Y"
                            unit="%"
                            value={state.base.posY}
                            min={0}
                            max={100}
                            step={1}
                            onChange={(v, continuous) =>
                                patchBase({ posY: v }, continuous === true)
                            }
                            onGestureStart={pushHistory}
                        />
                    </div>
                )}
                <ExportRecalcPanel />
            </CollapsibleSection>

            <CollapsibleSection title="Стейдж" defaultOpen={false}>
                <SegmentedControl
                    value={state.stage.bg}
                    options={[
                        { value: 'checker' as const, label: 'Шахматка' },
                        { value: 'solid' as const, label: 'Цвет' },
                        { value: 'image' as const, label: 'Картинка' },
                    ]}
                    onChange={(v) => patchStage({ bg: v })}
                />
                {state.stage.bg === 'solid' && (
                    <ColorField
                        label="Цвет фона"
                        value={state.stage.color}
                        onChange={(hex, continuous) =>
                            patchStage({ color: hex }, continuous === true)
                        }
                        onGestureStart={pushHistory}
                    />
                )}
                {state.stage.bg === 'image' && (
                    <>
                        <input
                            ref={stageFileRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={onStagePickFile}
                        />
                        {state.stage.image !== null ? (
                            <div className="flex items-center gap-2">
                                <img
                                    src={state.stage.image}
                                    alt=""
                                    className="h-8 w-12 shrink-0 rounded border border-lab-border object-cover"
                                />
                                <button
                                    type="button"
                                    className="min-w-0 flex-1 cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2 py-1.5 text-xs hover:border-lab-accent"
                                    onClick={() => stageFileRef.current?.click()}
                                >
                                    Заменить
                                </button>
                                <button
                                    type="button"
                                    title="Убрать картинку"
                                    className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-lab-border bg-lab-panel2 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text"
                                    onClick={() =>
                                        patchStage({
                                            image: null,
                                            x: 0,
                                            y: 0,
                                            scale: 100,
                                        })
                                    }
                                >
                                    ×
                                </button>
                            </div>
                        ) : (
                            <div
                                className="flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed border-lab-border px-3 py-4 text-center hover:border-lab-accent"
                                onClick={() => stageFileRef.current?.click()}
                            >
                                <span className="text-xs">Перетащите скриншот на стейдж</span>
                                <span className="text-[10px]">или кликните для выбора файла</span>
                            </div>
                        )}
                        <button
                            type="button"
                            className="cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2 py-1.5 text-xs hover:border-lab-accent"
                            onClick={() => void onStageClipboard()}
                        >
                            Из буфера
                        </button>
                        {clipboardNote !== null && (
                            <p className="text-[10px] leading-relaxed text-lab-muted">
                                {clipboardNote}
                            </p>
                        )}
                        <div className="grid grid-cols-2 gap-2">
                            <NumberField
                                label="X, px"
                                value={state.stage.x}
                                onChange={(v) => patchStage({ x: v })}
                            />
                            <NumberField
                                label="Y, px"
                                value={state.stage.y}
                                onChange={(v) => patchStage({ y: v })}
                            />
                        </div>
                        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                            <NumberField
                                label="Масштаб, %"
                                value={state.stage.scale}
                                min={1}
                                step={1}
                                onChange={(v) => patchStage({ scale: v })}
                            />
                            <button
                                type="button"
                                title="Сбросить смещение и масштаб картинки"
                                className="cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2.5 py-1.5 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text"
                                onClick={() => patchStage({ x: 0, y: 0, scale: 100 })}
                            >
                                Сбросить вид
                            </button>
                        </div>
                    </>
                )}
                <Toggle
                    label="Isolation (Backdrop Root)"
                    checked={state.stage.isolated}
                    onChange={(v) => patchStage({ isolated: v })}
                />
                <p className="text-[10px] leading-relaxed text-lab-muted">
                    Пустое место стейджа перетаскивает фон. Изоляция включена — blur-слой сэмплит
                    только содержимое блока (как в реальном браузере с isolation на родителе и в
                    анализе, clamp-to-edge у кромок); выключи, чтобы blur блёрил картинку стейджа
                </p>
            </CollapsibleSection>

            <CollapsibleSection title="Слои градиентов">
                <LayerList />
                {activeTarget.kind === 'layer' && <GradientEditor target={activeTarget} />}
            </CollapsibleSection>

            <CollapsibleSection title="Маска блока" defaultOpen={false}>
                <Toggle
                    label="Включить маску"
                    checked={state.mask.enabled}
                    onChange={(v) => {
                        update((d) => {
                            d.mask.enabled = v;
                        });
                        if (v) setActiveTarget({ kind: 'mask' });
                    }}
                />
                {state.mask.enabled && <GradientEditor target={{ kind: 'mask' }} />}
            </CollapsibleSection>

            <CollapsibleSection title="Размытие" defaultOpen={false}>
                <Toggle
                    label="Включить размытие"
                    checked={state.blur.enabled}
                    onChange={(v) => {
                        update((d) => {
                            d.blur.enabled = v;
                            // чистый холст: первое включение создаёт слой 0 по умолчанию
                            if (v && d.blur.layers.length === 0) {
                                d.blur.layers = [defaultBlurLayer()];
                            }
                        });
                        // слой с заливкой уже есть — сразу открываем его редактор
                        const first = state.blur.layers[0];
                        if (v && first !== undefined && first.gradient !== null) {
                            setActiveTarget({ kind: 'blurBg', layer: 0 });
                        }
                    }}
                />
                {state.blur.enabled && (
                    <div className="flex flex-col gap-2.5">
                        {state.blur.layers.map((layer, i) => (
                            <BlurLayerCard key={layer.id} index={i} />
                        ))}
                        <button
                            type="button"
                            title="Второй blur-слой: пара ::before/::after — меньший радиус выше, больший ниже (копирует rect/маску последнего)"
                            className="cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2.5 py-1.5 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text disabled:cursor-default disabled:opacity-40"
                            disabled={state.blur.layers.length >= 2}
                            onClick={() =>
                                update((d) => {
                                    // новый слой копирует rect/маску последнего —
                                    // удобно докручивать поверх готовой геометрии
                                    const src = d.blur.layers[d.blur.layers.length - 1];
                                    if (src !== undefined) {
                                        d.blur.layers.push({ ...structuredClone(src), id: uid() });
                                    } else {
                                        d.blur.layers.push(defaultBlurLayer());
                                    }
                                })
                            }
                        >
                            + слой
                        </button>
                        <p className="text-[10px] leading-relaxed text-lab-muted">
                            Два слоя = пара ::before/::after или два div: слой с меньшим радиусом
                            выше, с большим ниже; верхний блюрит уже заблюренный нижний в зоне
                            пересечения
                        </p>
                    </div>
                )}
                {/* underlay рендерится независимо от blur.enabled — контролы
                    доступны всегда, чтобы юзер мог его выключить и без blur */}
                <div className="flex flex-col gap-2.5 border-t border-lab-border pt-2.5">
                    {' '}
                    <Toggle
                        label="Подложка затемнения (::before)"
                        checked={underlay.enabled}
                        onChange={(v) => {
                            update((d) => {
                                d.blur.underlay.enabled = v;
                            });
                            if (v && underlay.gradient !== null) {
                                setActiveTarget({ kind: 'underlay' });
                            }
                        }}
                    />
                    {underlay.enabled && (
                        <>
                            <div className="grid grid-cols-2 gap-2">
                                <NumberField
                                    label="Подложка X, %"
                                    value={underlay.rect.x}
                                    step={0.1}
                                    onChange={(v) =>
                                        update((d) => {
                                            d.blur.underlay.rect.x = v;
                                        })
                                    }
                                />
                                <NumberField
                                    label="Подложка Y, %"
                                    value={underlay.rect.y}
                                    step={0.1}
                                    onChange={(v) =>
                                        update((d) => {
                                            d.blur.underlay.rect.y = v;
                                        })
                                    }
                                />
                                <NumberField
                                    label="Подложка W, %"
                                    value={underlay.rect.w}
                                    min={1}
                                    step={0.1}
                                    onChange={(v) =>
                                        update((d) => {
                                            d.blur.underlay.rect.w = v;
                                        })
                                    }
                                />
                                <NumberField
                                    label="Подложка H, %"
                                    value={underlay.rect.h}
                                    min={1}
                                    step={0.1}
                                    onChange={(v) =>
                                        update((d) => {
                                            d.blur.underlay.rect.h = v;
                                        })
                                    }
                                />
                            </div>
                            <button
                                type="button"
                                title="Сбросить область подложки на весь блок"
                                className="cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2.5 py-1.5 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text"
                                onClick={() =>
                                    update((d) => {
                                        d.blur.underlay.rect = { x: 0, y: 0, w: 100, h: 100 };
                                    })
                                }
                            >
                                Во весь блок
                            </button>
                            <SegmentedControl
                                value={
                                    underlay.gradient !== null
                                        ? ('gradient' as const)
                                        : underlay.color !== null
                                          ? ('color' as const)
                                          : ('none' as const)
                                }
                                options={[
                                    { value: 'none' as const, label: 'Нет' },
                                    { value: 'color' as const, label: 'Цвет' },
                                    { value: 'gradient' as const, label: 'Градиент' },
                                ]}
                                onChange={(v) => {
                                    update((d) => {
                                        if (v === 'none') {
                                            d.blur.underlay.gradient = null;
                                            d.blur.underlay.color = null;
                                        } else if (v === 'color') {
                                            d.blur.underlay.gradient = null;
                                            if (d.blur.underlay.color === null) {
                                                d.blur.underlay.color = 'rgba(0, 0, 0, 0.45)';
                                            }
                                        } else if (d.blur.underlay.gradient === null) {
                                            d.blur.underlay.gradient = defaultLinearGradient(0, [
                                                {
                                                    id: uid(),
                                                    pos: 0,
                                                    color: '#101010',
                                                    alpha: 0.4,
                                                },
                                                {
                                                    id: uid(),
                                                    pos: 100,
                                                    color: '#101010',
                                                    alpha: 0,
                                                },
                                            ]);
                                        }
                                    });
                                    if (v === 'gradient') {
                                        setActiveTarget({ kind: 'underlay' });
                                    } else if (activeTarget.kind === 'underlay') {
                                        setActiveTarget({ kind: 'layer', index: 0 });
                                    }
                                }}
                            />
                            {underlay.gradient === null && underlayParsed !== null && (
                                <>
                                    <ColorField
                                        label="Цвет подложки"
                                        value={underlayParsed.hex}
                                        onChange={(hex, continuous) =>
                                            setUnderlayColor(
                                                hex,
                                                underlayParsed.alpha,
                                                continuous === true
                                            )
                                        }
                                        onGestureStart={pushHistory}
                                        onClear={() =>
                                            update((d) => {
                                                d.blur.underlay.color = null;
                                            })
                                        }
                                    />
                                    <UnitSlider
                                        label="Прозрачность подложки"
                                        value={underlayParsed.alpha}
                                        min={0}
                                        max={1}
                                        step={0.01}
                                        onChange={(v, continuous) =>
                                            setUnderlayColor(
                                                underlayParsed.hex,
                                                v,
                                                continuous === true
                                            )
                                        }
                                        onGestureStart={pushHistory}
                                    />
                                </>
                            )}
                            {underlay.gradient !== null && (
                                <GradientEditor target={{ kind: 'underlay' }} />
                            )}
                        </>
                    )}
                </div>
            </CollapsibleSection>

            <CollapsibleSection title="Текст с градиентом" defaultOpen={false}>
                <Toggle
                    label="Включить текст"
                    checked={state.clipText.enabled}
                    onChange={(v) => {
                        update((d) => {
                            d.clipText.enabled = v;
                        });
                        if (v) setActiveTarget({ kind: 'clipText' });
                    }}
                />
                {state.clipText.enabled && (
                    <>
                        <label className="flex min-w-0 flex-col gap-1">
                            <span className="text-[11px] leading-none text-lab-muted">Текст</span>
                            <input
                                className="w-full min-w-0 rounded-md border border-lab-border bg-lab-panel2 px-2 py-1.5 text-xs outline-none focus:border-lab-accent"
                                value={state.clipText.text}
                                onChange={(e) =>
                                    update((d) => {
                                        d.clipText.text = e.target.value;
                                    })
                                }
                            />
                        </label>
                        <GradientEditor target={{ kind: 'clipText' }} />
                    </>
                )}
            </CollapsibleSection>

            <CollapsibleSection title="Анимация маски" defaultOpen={false}>
                <AnimSection />
            </CollapsibleSection>

            <CollapsibleSection title="Сравнение с макетом" defaultOpen={false}>
                <CompareSection />
            </CollapsibleSection>
        </aside>
    );
}
