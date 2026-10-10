import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { uid } from '../schema';
import { isAlphaTarget, readGradient, targetToKey } from '../targets';
import { useLabStore } from '../store';
import type { Analysis, AnalysisResidual, CompareSpec } from '../types';
import { EyedropperIcon, EyeIcon, EyeOffIcon, MoveIcon } from './icons';
import { NumberField } from './ui/NumberField';
import { SegmentedControl } from './ui/SegmentedControl';
import { UnitSlider } from './ui/UnitSlider';

function loadRefImage(file: File | undefined, onload: (dataUrl: string) => void): void {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => onload(String(reader.result));
    reader.readAsDataURL(file);
}

/** Строка «метка — значение» для панели анализа. */
function StatRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-baseline justify-between gap-2 font-mono text-[10px] leading-snug">
            <span className="text-lab-muted">{label}</span>
            <span className="text-lab-text">{value}</span>
        </div>
    );
}

/** Подписи классов остатков. */
const RESIDUAL_LABEL: Record<AnalysisResidual['kind'], string> = {
    edge: 'кромка',
    blur: 'blur-зона',
    level: 'уровень',
    approx: 'приблизительно',
};

/** Топ-зоны расхождения: значимые остатки (err > tolerance) по величине. */
function topZones(analysis: Analysis, count = 5): AnalysisResidual[] {
    return [...analysis.residuals]
        .sort((a, b) => b.err - a.err)
        .slice(0, count)
        .sort((a, b) => a.pos - b.pos);
}

/** Секция «Сравнение с макетом»: референс, режимы, оффсет/масштаб, diff-анализ. */
export function CompareSection() {
    const compare = useLabStore((s) => s.state.compare);
    const compareUI = useLabStore((s) => s.compareUI);
    const analysis = useLabStore((s) => s.analysis);
    const analysisMarker = useLabStore((s) => s.analysisMarker);
    const activeTarget = useLabStore((s) => s.activeTarget);
    const analysisTarget = useLabStore((s) => s.analysisTarget);
    const analysisProfile = useLabStore((s) => s.analysisProfile);
    const setAnalysisProfile = useLabStore((s) => s.setAnalysisProfile);
    // лучи — только для radial-таргетов (эффективный: агентский override приоритетнее)
    const effectiveTarget = analysisTarget ?? activeTarget;
    const targetIsRadial = useLabStore((s) => s.getGradient(effectiveTarget)?.type === 'radial');
    const hasActiveGradient = useLabStore((s) => s.getGradient(s.activeTarget) !== null);
    const setCompareUI = useLabStore((s) => s.setCompareUI);
    const setSelectedStop = useLabStore((s) => s.setSelectedStop);
    const update = useLabStore((s) => s.update);
    const pushHistory = useLabStore((s) => s.pushHistory);
    const fileRef = useRef<HTMLInputElement>(null);
    const [dragOver, setDragOver] = useState(false);
    const [analysisOpen, setAnalysisOpen] = useState(false);

    const patchCompare = (patch: Partial<CompareSpec>, transient = false) => {
        update(
            (d) => {
                Object.assign(d.compare, patch);
            },
            { transient }
        );
    };

    const setRefImage = (dataUrl: string) => {
        update((d) => {
            d.compare.refImage = dataUrl;
            // чтобы загруженный референс сразу был виден
            if (d.compare.mode === 'off') d.compare.mode = 'opacity';
        });
    };

    const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
        loadRefImage(e.target.files?.[0], setRefImage);
        e.target.value = '';
    };

    const onDrop = (e: DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        loadRefImage(e.dataTransfer.files[0], setRefImage);
    };

    const removeRef = () => {
        update((d) => {
            d.compare.refImage = null;
        });
        setCompareUI({ dragRef: false, eyedropper: false });
    };

    // предлагаем агентом/юзеру стопы применяем к таргету, для которого считался
    // анализ (агентский override приоритетнее UI-активного); alpha-таргеты
    // (маски, blurBg, underlay — фейд по природе) берут альфу из анализа
    // и чёрный цвет, цветовые — color с альфой 1
    const applySuggested = () => {
        if (analysis === null) return;
        const target = analysisTarget ?? activeTarget;
        const alphaLike = isAlphaTarget(target.kind);
        update((d) => {
            const g = readGradient(d, target);
            if (!g) return;
            g.stops = analysis.suggestedStops.map((ss) => ({
                id: uid(),
                pos: Math.round(ss.pos * 10) / 10,
                color: alphaLike ? '#000000' : (ss.color ?? '#000000'),
                alpha: alphaLike ? (ss.alpha ?? 1) : 1,
            }));
        });
        setSelectedStop(null);
    };

    const hasImage = compare.refImage !== null;
    // кнопки режимов референса — только для режимов с картинкой-оверлеем
    const hasRefOverlay =
        hasImage &&
        (compare.mode === 'opacity' || compare.mode === 'difference' || compare.mode === 'split');

    const modeBtn = (active: boolean): string =>
        `flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs transition-colors ${
            active
                ? 'border-transparent bg-lab-accent text-white'
                : 'border-lab-border bg-lab-panel2 text-lab-muted hover:border-lab-accent hover:text-lab-text'
        }`;

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={onPickFile}
            />
            {hasImage ? (
                <div className="mt-1 flex items-center gap-2">
                    <img
                        src={compare.refImage ?? undefined}
                        alt=""
                        className="h-10 w-14 shrink-0 rounded border border-lab-border object-cover"
                    />
                    <button
                        type="button"
                        className="min-w-0 flex-1 cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2 py-1.5 text-xs hover:border-lab-accent"
                        onClick={() => fileRef.current?.click()}
                    >
                        Заменить
                    </button>
                    <button
                        type="button"
                        title="Убрать референс"
                        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-lab-border bg-lab-panel2 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text"
                        onClick={removeRef}
                    >
                        ×
                    </button>
                </div>
            ) : (
                <div
                    className={`flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed px-3 py-4 text-center ${
                        dragOver
                            ? 'border-lab-accent text-lab-text'
                            : 'border-lab-border text-lab-muted hover:border-lab-accent'
                    }`}
                    onClick={() => fileRef.current?.click()}
                    onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDrop}
                >
                    <span className="text-xs">Перетащите скриншот макета</span>
                    <span className="text-[10px]">или кликните для выбора файла</span>
                </div>
            )}

            <SegmentedControl
                value={compare.mode}
                options={[
                    { value: 'off' as const, label: 'Выкл' },
                    { value: 'opacity' as const, label: 'Прозрачность' },
                    { value: 'difference' as const, label: 'Разница' },
                    { value: 'split' as const, label: 'Разделить' },
                    { value: 'analysis' as const, label: 'Анализ' },
                ]}
                onChange={(v) => patchCompare({ mode: v })}
            />

            {compare.mode === 'opacity' && (
                <UnitSlider
                    label="Непрозрачность"
                    value={compare.opacity}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(v, continuous) => patchCompare({ opacity: v }, continuous === true)}
                    onGestureStart={pushHistory}
                />
            )}
            {compare.mode === 'split' && (
                <>
                    <SegmentedControl
                        value={compare.splitDir}
                        options={[
                            { value: 'vertical' as const, label: 'Вертикаль' },
                            { value: 'horizontal' as const, label: 'Горизонталь' },
                        ]}
                        onChange={(v) => patchCompare({ splitDir: v })}
                    />
                    <UnitSlider
                        label="Разделитель"
                        unit="%"
                        value={compare.splitPos}
                        min={0}
                        max={100}
                        step={1}
                        onChange={(v, continuous) =>
                            patchCompare({ splitPos: v }, continuous === true)
                        }
                        onGestureStart={pushHistory}
                    />
                </>
            )}

            {hasRefOverlay && (
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        title={
                            compareUI.visible
                                ? 'Скрыть референс (или удерживайте \\)'
                                : 'Показать референс'
                        }
                        className={modeBtn(compareUI.visible)}
                        onClick={() => setCompareUI({ visible: !compareUI.visible })}
                    >
                        {compareUI.visible ? <EyeIcon /> : <EyeOffIcon />}
                    </button>
                    <button
                        type="button"
                        title="Перетаскивать референс мышью; клик мимо — выключить"
                        className={modeBtn(compareUI.dragRef)}
                        onClick={() => setCompareUI({ dragRef: !compareUI.dragRef })}
                    >
                        <MoveIcon />
                        Двигать
                    </button>
                    <button
                        type="button"
                        title="Пипетка: клик по референсу берёт цвет"
                        className={modeBtn(compareUI.eyedropper)}
                        onClick={() => setCompareUI({ eyedropper: !compareUI.eyedropper })}
                    >
                        <EyedropperIcon />
                        Пипетка
                    </button>
                </div>
            )}

            <div className="grid grid-cols-2 gap-2">
                <NumberField
                    label="Смещение X, px"
                    value={compare.x}
                    onChange={(v) => patchCompare({ x: v })}
                />
                <NumberField
                    label="Смещение Y, px"
                    value={compare.y}
                    onChange={(v) => patchCompare({ y: v })}
                />
            </div>
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                <NumberField
                    label="Масштаб, %"
                    value={compare.scale * 100}
                    step={0.1}
                    min={5}
                    max={400}
                    onChange={(v) => patchCompare({ scale: v / 100 })}
                />
                <button
                    type="button"
                    title="Поставить референс ровно на блок (x=0, y=0, масштаб 100%)"
                    className="cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2.5 py-1.5 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text"
                    onClick={() => patchCompare({ x: 0, y: 0, scale: 1 })}
                >
                    Подогнать под блок
                </button>
            </div>

            {hasImage && (
                <div className="flex flex-col gap-2.5 rounded-lg border border-lab-border bg-lab-panel2/60 p-2.5">
                    <button
                        type="button"
                        className="flex cursor-pointer items-center gap-1.5 text-left"
                        onClick={() => setAnalysisOpen(!analysisOpen)}
                    >
                        <svg
                            className={`h-3 w-3 shrink-0 text-lab-muted transition-transform ${
                                analysisOpen ? 'rotate-90' : ''
                            }`}
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M6 3.5 10.5 8 6 12.5" />
                        </svg>
                        <span className="text-[11px] font-medium tracking-wide text-lab-muted uppercase">
                            Анализ
                        </span>
                    </button>
                    {analysisOpen && (
                        <div className="flex min-w-0 flex-col gap-2">
                            <NumberField
                                label="Допуск (tolerance), 0..255"
                                value={compare.tolerance}
                                min={0}
                                max={255}
                                onChange={(v) => patchCompare({ tolerance: v })}
                            />
                            <label
                                className="flex cursor-pointer items-center gap-1.5"
                                title="Ступени и стопы по P60 яркости колонок (ось X) — устойчиво к горизонтальному дрейфу контента, напр. каруселей"
                            >
                                <input
                                    type="checkbox"
                                    className="accent-lab-accent"
                                    checked={analysisProfile === 'columns'}
                                    onChange={(e) =>
                                        setAnalysisProfile(e.target.checked ? 'columns' : 'axis')
                                    }
                                />
                                <span className="text-[11px] leading-none text-lab-muted">
                                    Профиль по колонкам
                                </span>
                            </label>
                            <label
                                className="flex cursor-pointer items-center gap-1.5"
                                title="Медиана 16 лучей из центра radial-градиента на нормированном радиусе: ось-линия слепа к объектам вне линии, лучи видят всю зону (только radial-таргеты)"
                            >
                                <input
                                    type="checkbox"
                                    className="accent-lab-accent"
                                    disabled={!targetIsRadial}
                                    checked={analysisProfile === 'rays'}
                                    onChange={(e) =>
                                        setAnalysisProfile(e.target.checked ? 'rays' : 'axis')
                                    }
                                />
                                <span className="text-[11px] leading-none text-lab-muted">
                                    По лучам
                                </span>
                            </label>
                            {analysis === null ? (
                                analysisMarker === 'gradientMissing' ? (
                                    <p className="text-[10px] leading-relaxed text-lab-muted">
                                        У таргета нет градиента — анализ невозможен (слой за
                                        диапазоном, маска/градиент не заданы)
                                    </p>
                                ) : (
                                    <p className="text-[10px] leading-relaxed text-lab-muted">
                                        Метрики считаются автоматически ~0.5 c после правок
                                    </p>
                                )
                            ) : (
                                <>
                                    <StatRow
                                        label="Таргет"
                                        value={
                                            analysisTarget !== null &&
                                            targetToKey(analysisTarget) === analysis.target
                                                ? `${analysis.target} (агент)`
                                                : analysis.target
                                        }
                                    />
                                    <StatRow label="Ось" value={analysis.axisSpace} />
                                    <StatRow
                                        label="Совпадение"
                                        value={`${analysis.matchPercent}% (err < ${analysis.tolerance})`}
                                    />
                                    {analysis.axisSpace !== 'block' && (
                                        <StatRow
                                            label="Совпадение в зоне"
                                            value={`${analysis.zoneMatchPercent}% (зона x${analysis.zone.x} y${analysis.zone.y} w${analysis.zone.w} h${analysis.zone.h})`}
                                        />
                                    )}
                                    <StatRow
                                        label="Макс. ошибка"
                                        value={`${analysis.maxError}/255`}
                                    />
                                    <p className="text-[10px] leading-relaxed text-lab-text">
                                        {analysis.verdict}
                                    </p>
                                    {topZones(analysis).length > 0 && (
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] leading-none text-lab-muted">
                                                Топ-зоны расхождения (err &gt; допуска)
                                            </span>
                                            {topZones(analysis).map((z) => (
                                                <StatRow
                                                    key={`${z.pos}-${z.err}`}
                                                    label={`${z.pos}%`}
                                                    value={`err ${z.err} · ${RESIDUAL_LABEL[z.kind]}`}
                                                />
                                            ))}
                                        </div>
                                    )}
                                    {analysis.transitions.length > 0 && (
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] leading-none text-lab-muted">
                                                Ступени референса (pos → уровень)
                                            </span>
                                            {analysis.transitions.map((tr, i) => (
                                                <StatRow
                                                    key={`${tr.pos}-${i}`}
                                                    label={`${tr.pos}%`}
                                                    value={`уровень ${tr.level}`}
                                                />
                                            ))}
                                        </div>
                                    )}
                                    {analysis.suggestedStops.length > 0 && (
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] leading-none text-lab-muted">
                                                Предлагаемые стопы
                                            </span>
                                            <p className="font-mono text-[10px] leading-snug break-words text-lab-text">
                                                {analysis.suggestedStops
                                                    .map((ss) =>
                                                        ss.alpha !== undefined
                                                            ? `${ss.pos}%·a${ss.alpha}`
                                                            : `${ss.pos}%·${ss.color}`
                                                    )
                                                    .join('  ')}
                                            </p>
                                            <button
                                                type="button"
                                                title={
                                                    hasActiveGradient
                                                        ? undefined
                                                        : 'Сначала выберите градиент (слой/маска/blur) в инспекторе'
                                                }
                                                className="cursor-pointer rounded-md border border-lab-border bg-lab-panel px-2 py-1.5 text-[11px] hover:border-lab-accent disabled:cursor-default disabled:opacity-40"
                                                disabled={!hasActiveGradient}
                                                onClick={applySuggested}
                                            >
                                                Применить предложенные стопы
                                            </button>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}

            <p className="text-[10px] leading-relaxed text-lab-muted">
                Ctrl+V вставляет скриншот из буфера; удерживай \ для взгляда на блок
            </p>
        </div>
    );
}
