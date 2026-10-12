import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { blockPointToImage } from '../lib/autofit';
import { rgbToHex, rgbaString } from '../lib/color';
import { startPointerDrag } from '../lib/drag';
import { getCanvas } from '../lib/imageCache';
import { readGradient } from '../targets';
import { useLabStore } from '../store';

interface CompareOverlayProps {
    stageRef: RefObject<HTMLDivElement | null>;
}

const POPUP_WIDTH = 196;

/**
 * Референс-оверлей поверх блока: режимы opacity / difference / gray
 * (PerfectPixel: ref + плашка #808080, оба difference — совпадение = ровно
 * серый) / split (split — вертикальный или горизонтальный по
 * compare.splitDir), режим analysis — heat-карта расхождений; A/B по
 * удержанию `\`, drag-референс и пипетка.
 */
export function CompareOverlay({ stageRef }: CompareOverlayProps) {
    const state = useLabStore((s) => s.state);
    const compare = state.compare;
    const compareUI = useLabStore((s) => s.compareUI);
    const analysisDiff = useLabStore((s) => s.analysisDiff);
    const setCompareUI = useLabStore((s) => s.setCompareUI);
    const update = useLabStore((s) => s.update);
    const pushHistory = useLabStore((s) => s.pushHistory);
    const activeTarget = useLabStore((s) => s.activeTarget);
    const selectedStopId = useLabStore((s) => s.selectedStopId);
    const viewSpace = useLabStore((s) => s.viewSpace);
    // выбран ли стоп, существующий в активном градиенте (цель кнопки «В стоп»)
    const stopValid = useLabStore(
        (s) =>
            readGradient(s.state, s.activeTarget)?.stops.some((st) => st.id === s.selectedStopId) ??
            false
    );
    const [hiddenByKey, setHiddenByKey] = useState(false);
    const diffCanvasRef = useRef<HTMLCanvasElement>(null);

    // heat-карта анализа: блитим сохранённый canvas в отображаемый элемент
    useEffect(() => {
        const c = diffCanvasRef.current;
        if (!c || analysisDiff === null) return;
        c.width = analysisDiff.width;
        c.height = analysisDiff.height;
        c.getContext('2d')?.drawImage(analysisDiff, 0, 0);
    }, [analysisDiff]);

    // A/B: удержание Backslash временно прячет overlay, отпускание возвращает
    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            if (e.code === 'Backslash' || e.key === '\\') setHiddenByKey(true);
        };
        const up = (e: KeyboardEvent) => {
            if (e.code === 'Backslash' || e.key === '\\') setHiddenByKey(false);
        };
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
        };
    }, []);

    if (compare.refImage === null || compare.mode === 'off') return null;
    if (!compareUI.visible || hiddenByKey) return null;

    const interactive = compareUI.dragRef || compareUI.eyedropper;

    // клик мимо референса выключает режим «Двигать референс»
    const onCatcherPointerDown = () => {
        if (useLabStore.getState().viewSpace) return; // пан вью — не выбор режима
        setCompareUI({ dragRef: false });
    };

    // режим «Двигать референс»: drag двигает offset compare.x/y; дельты /zoom
    const onOverlayPointerDown = (e: ReactPointerEvent) => {
        if (e.button !== 0 || viewSpace) return;
        e.stopPropagation();
        const start = { x: compare.x, y: compare.y };
        let pushed = false;
        startPointerDrag(e, ({ dx, dy }) => {
            const k = useLabStore.getState().viewZoom / 100;
            if (!pushed) {
                pushHistory();
                pushed = true;
            }
            update(
                (d) => {
                    d.compare.x = Math.round(start.x + dx / k);
                    d.compare.y = Math.round(start.y + dy / k);
                },
                { transient: true }
            );
        });
    };

    // пипетка: экранные координаты -> (снимаем зум/пан) -> пиксель картинки -> попап
    const onPickPointerDown = (e: ReactPointerEvent) => {
        if (e.button !== 0 || viewSpace) return;
        e.stopPropagation();
        const rect = stageRef.current?.getBoundingClientRect();
        const ref = compare.refImage;
        if (!rect || ref === null) return;
        const { viewPan, viewZoom } = useLabStore.getState();
        const k = viewZoom / 100;
        // канвасные координаты клика: попап живёт внутри wrapper-а и зумится вместе
        const sx = (e.clientX - rect.left - viewPan.x) / k;
        const sy = (e.clientY - rect.top - viewPan.y) / k;
        const bx = sx - state.x;
        const by = sy - state.y;
        void getCanvas(ref)
            .then((canvas) => {
                const p = blockPointToImage(
                    bx,
                    by,
                    { w: state.w, h: state.h },
                    compare,
                    canvas.width,
                    canvas.height
                );
                if (p.x < 0 || p.y < 0 || p.x >= canvas.width || p.y >= canvas.height) {
                    return; // клик мимо картинки
                }
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                const d = ctx.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
                setCompareUI({
                    pick: {
                        // клэмп попапа по правому краю вьюпорта в канвасных
                        // координатах: (rect.width - panX)/k, не просто rect.width/k
                        popupLeft: Math.max(
                            4,
                            Math.min(sx + 12, (rect.width - viewPan.x) / k - POPUP_WIDTH - 4)
                        ),
                        y: sy - 10,
                        r: d[0],
                        g: d[1],
                        b: d[2],
                        a: d[3],
                    },
                });
            })
            .catch(() => {
                // незагруженный референс — игнорируем клик
            });
    };

    // разделитель сплита: вертикальная линия двигается по X, горизонтальная — по Y;
    // координаты снимаем с зума/пана — линия под курсором при любом масштабе
    const onSplitPointerDown = (e: ReactPointerEvent) => {
        if (e.button !== 0 || viewSpace) return;
        e.stopPropagation();
        const rect = stageRef.current?.getBoundingClientRect();
        if (!rect) return;
        let pushed = false;
        startPointerDrag(e, ({ x, y }) => {
            const { viewPan, viewZoom } = useLabStore.getState();
            const k = viewZoom / 100;
            const p =
                compare.splitDir === 'vertical'
                    ? (((x - rect.left - viewPan.x) / k - state.x) / state.w) * 100
                    : (((y - rect.top - viewPan.y) / k - state.y) / state.h) * 100;
            const pos = Math.round(Math.min(100, Math.max(0, p)));
            if (!pushed) {
                pushHistory();
                pushed = true;
            }
            update(
                (d) => {
                    d.compare.splitPos = pos;
                },
                { transient: true }
            );
        });
    };

    const pick = compareUI.pick;
    const pickHex = pick !== null ? rgbToHex(pick.r, pick.g, pick.b) : '';

    const applyToBase = () => {
        if (pick === null) return;
        const hex = rgbToHex(pick.r, pick.g, pick.b);
        update((d) => {
            d.base.color = hex;
        });
        setCompareUI({ pick: null });
    };

    const applyToStop = () => {
        if (pick === null) return;
        const hex = rgbToHex(pick.r, pick.g, pick.b);
        update((d) => {
            const g = readGradient(d, activeTarget);
            const stop = g?.stops.find((st) => st.id === selectedStopId);
            if (stop) stop.color = hex;
        });
        setCompareUI({ pick: null });
    };

    // vertical: клип слева, видна правая часть референса; horizontal: клип сверху
    const splitClip =
        compare.mode === 'split'
            ? compare.splitDir === 'vertical'
                ? `inset(0 0 0 ${compare.splitPos}%)`
                : `inset(${compare.splitPos}% 0 0 0)`
            : undefined;

    const overlayStyle: CSSProperties = {
        position: 'absolute',
        left: state.x,
        top: state.y,
        width: state.w,
        height: state.h,
        // при x=0, y=0, scale=1 референс лежит ровно на блоке
        transform: `translate(${compare.x}px, ${compare.y}px) scale(${compare.scale})`,
        transformOrigin: 'center',
        // референс клипается по скруглению блока: углы оверлея совпадают с
        // блоком, кривой кроп углами референса не подсвечивается; transform
        // scale домножает радиус визуально (radius·compare.scale), как у блока
        borderRadius: state.radius > 0 ? state.radius : undefined,
        overflow: 'hidden',
        pointerEvents: interactive && !viewSpace ? 'auto' : 'none',
        cursor: compareUI.dragRef ? 'move' : 'crosshair',
        touchAction: 'none',
        opacity: compare.mode === 'opacity' ? compare.opacity : undefined,
        mixBlendMode:
            compare.mode === 'difference' || compare.mode === 'gray' ? 'difference' : undefined,
        clipPath: splitClip,
    };

    return (
        <>
            {compareUI.dragRef && (
                // catcher строго ПОД оверлей-слоями (z-auto + DOM-порядок: слои
                // режимов рендерятся позже и стоят выше): клик по референсу
                // достаётся слою (drag), клик мимо — catcher-у (выключить режим).
                // Положительный z (было z-[5]) хит-тестился выше z-auto-слоёв
                // независимо от DOM-порядка и перехватывал клики по самому
                // референсу — drag был мёртв, режим гас первым же кликом.
                // Пипетка не конфликтует: dragRef и eyedropper взаимоисключающие
                // (store.setCompareUI), catcher существует только при dragRef
                <div className="absolute inset-0" onPointerDown={onCatcherPointerDown} />
            )}
            {compare.mode === 'analysis' ? (
                analysisDiff !== null && (
                    <canvas
                        ref={diffCanvasRef}
                        className="pointer-events-none absolute z-10"
                        style={{
                            left: state.x,
                            top: state.y,
                            width: state.w,
                            height: state.h,
                        }}
                    />
                )
            ) : compare.mode === 'gray' ? (
                <>
                    {/* Серый (PerfectPixel): ref и плашка #808080 — два СИБЛИНГА
                        с difference каждый: у стека один transform (изоляция
                        blending потомков), поэтому blend вешаем на сами слои —
                        ref смешивается с блоком, плашка с уже смешанным ref.
                        Совпавшие пиксели = ровно #808080; клип радиусом блока
                        (borderRadius + overflow в overlayStyle) — на обоих. */}
                    <div
                        style={overlayStyle}
                        onPointerDown={
                            compareUI.eyedropper ? onPickPointerDown : onOverlayPointerDown
                        }
                    >
                        <img
                            src={compare.refImage}
                            alt=""
                            draggable={false}
                            className="h-full w-full select-none"
                            style={{ objectFit: 'fill' }}
                        />
                    </div>
                    <div
                        style={{ ...overlayStyle, background: '#808080' }}
                        onPointerDown={
                            compareUI.eyedropper ? onPickPointerDown : onOverlayPointerDown
                        }
                    />
                </>
            ) : (
                <div
                    style={overlayStyle}
                    onPointerDown={compareUI.eyedropper ? onPickPointerDown : onOverlayPointerDown}
                >
                    <img
                        src={compare.refImage}
                        alt=""
                        draggable={false}
                        className="h-full w-full select-none"
                        style={{ objectFit: 'fill' }}
                    />
                </div>
            )}
            {compare.mode === 'split' && compare.splitDir === 'vertical' && (
                <div
                    className={`absolute z-20 flex w-4 -translate-x-1/2 touch-none justify-center ${
                        viewSpace ? 'pointer-events-none' : 'cursor-ew-resize'
                    }`}
                    style={{
                        left: state.x + (compare.splitPos / 100) * state.w,
                        top: state.y,
                        height: state.h,
                    }}
                    onPointerDown={onSplitPointerDown}
                >
                    <div className="h-full w-0.5 bg-white/85 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" />
                </div>
            )}
            {compare.mode === 'split' && compare.splitDir === 'horizontal' && (
                <div
                    className={`absolute z-20 flex h-4 -translate-y-1/2 touch-none items-center ${
                        viewSpace ? 'pointer-events-none' : 'cursor-ns-resize'
                    }`}
                    style={{
                        left: state.x,
                        top: state.y + (compare.splitPos / 100) * state.h,
                        width: state.w,
                    }}
                    onPointerDown={onSplitPointerDown}
                >
                    <div className="h-0.5 w-full bg-white/85 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" />
                </div>
            )}
            {pick !== null && (
                <>
                    {/* попап пипетки живёт в КАНВЕ (внутри зумящегося wrapper-а):
                        координаты и размер масштабируются вместе с ней — так и
                        задумано: попап показывает точку канвы, а не UI-слой */}
                    <div
                        className="absolute inset-0 z-30"
                        onPointerDown={() => setCompareUI({ pick: null })}
                    />
                    <div
                        className="absolute z-40 flex w-[196px] flex-col gap-2 rounded-lg border border-lab-border bg-lab-panel2 p-2.5 shadow-xl"
                        style={{ left: pick.popupLeft, top: pick.y }}
                        onPointerDown={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center gap-2">
                            <span
                                className="h-6 w-9 shrink-0 rounded border border-lab-border"
                                style={{ backgroundColor: rgbaString(pickHex, pick.a / 255) }}
                            />
                            <div className="flex min-w-0 flex-col font-mono text-[10px] leading-snug">
                                <span className="text-lab-text">{pickHex.toUpperCase()}</span>
                                <span className="text-lab-muted">
                                    {rgbaString(pickHex, pick.a / 255)}
                                </span>
                            </div>
                        </div>
                        <div className="flex gap-1.5">
                            <button
                                type="button"
                                className="min-w-0 flex-1 cursor-pointer rounded-md border border-lab-border bg-lab-panel px-2 py-1.5 text-[11px] hover:border-lab-accent"
                                onClick={applyToBase}
                            >
                                В цвет блока
                            </button>
                            <button
                                type="button"
                                title={
                                    stopValid
                                        ? undefined
                                        : 'Сначала выберите стоп на полосе градиента'
                                }
                                className="min-w-0 flex-1 cursor-pointer rounded-md border border-lab-border bg-lab-panel px-2 py-1.5 text-[11px] hover:border-lab-accent disabled:cursor-default disabled:opacity-40"
                                disabled={!stopValid}
                                onClick={applyToStop}
                            >
                                В стоп
                            </button>
                        </div>
                    </div>
                </>
            )}
        </>
    );
}
