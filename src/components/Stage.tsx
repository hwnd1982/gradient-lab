import { useEffect, useRef, useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { startPointerDrag } from '../lib/drag';
import { BlockBox } from './BlockBox';
import { CanvasHandles } from './CanvasHandles';
import { CompareOverlay } from './CompareOverlay';
import { useLabStore } from '../store';

const MIN_SIZE = 24;
const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
type Corner = (typeof CORNERS)[number];

const CORNER_CURSOR: Record<Corner, string> = {
    nw: 'nwse-resize',
    ne: 'nesw-resize',
    sw: 'nesw-resize',
    se: 'nwse-resize',
};

/** Зум стейджа из стора на момент события (в жестах/колесе — всегда свежий). */
function viewK(): number {
    return useLabStore.getState().viewZoom / 100;
}

/**
 * Контрол зума в правом верхнем углу стейджа: Fit · 50 · 100 · 200 · 300 +
 * степпер −/+ (шаг ×1.25, диапазон 10..800%) и индикатор текущего зума
 * (клик по нему — Fit). View-only, канвы не касается.
 */
function ZoomControl() {
    const viewZoom = useLabStore((s) => s.viewZoom);
    const viewFit = useLabStore((s) => s.viewFit);
    const setViewZoom = useLabStore((s) => s.setViewZoom);
    const zoomFit = useLabStore((s) => s.zoomFit);

    const btnCls = (active: boolean): string =>
        `cursor-pointer rounded border px-1.5 py-1 text-[11px] leading-none transition-colors ${
            active
                ? 'border-transparent bg-lab-accent text-white'
                : 'border-lab-border bg-lab-panel2 text-lab-text hover:border-lab-accent'
        }`;

    // пресеты 50/200/300: зум вокруг центра вьюпорта — точка под центром не уезжает
    const to = (z: number) => {
        const vs = useLabStore.getState().viewSize;
        setViewZoom(z, vs ? { x: vs.w / 2, y: vs.h / 2 } : undefined);
    };
    // 100% — натуральный размер, блок по центру вьюпорта. Сначала зум, потом
    // центрирующий пан: кламп пана обязан считать по k=1, а не по старому зуму
    // (пан, поклампленный по k=3, после выхода на 100% уводил блок за вьюпорт)
    const to100 = () => {
        setViewZoom(100);
        const { viewSize: vs, state, setViewPan } = useLabStore.getState();
        if (vs) {
            setViewPan({
                x: vs.w / 2 - (state.x + state.w / 2),
                y: vs.h / 2 - (state.y + state.h / 2),
            });
        }
    };
    // степпер: шаг ×1.25 туда-обратно, кламп 10..800 внутри setViewZoom
    const step = (dir: 1 | -1) => {
        const vs = useLabStore.getState().viewSize;
        const factor = dir === 1 ? 1.25 : 1 / 1.25;
        setViewZoom(viewZoom * factor, vs ? { x: vs.w / 2, y: vs.h / 2 } : undefined);
    };

    const z = Math.round(viewZoom);
    return (
        <div
            className="absolute right-3 top-3 z-40 flex items-center gap-0.5 rounded-md border border-lab-border bg-lab-panel/90 p-1 shadow-lg backdrop-blur"
            onPointerDown={(e) => e.stopPropagation()}
        >
            <button
                type="button"
                className={btnCls(viewFit)}
                onClick={zoomFit}
                title="Вписать блок в окно стейджа (отступ 24px); режим авто-Fit"
            >
                Fit
            </button>
            {[50, 100, 200, 300].map((v) => (
                <button
                    key={v}
                    type="button"
                    className={btnCls(!viewFit && z === v)}
                    onClick={() => (v === 100 ? to100() : to(v))}
                >
                    {v}%
                </button>
            ))}
            <button
                type="button"
                className={btnCls(false)}
                onClick={() => step(-1)}
                title="Уменьшить (×1.25)"
            >
                −
            </button>
            <button
                type="button"
                className={btnCls(false)}
                onClick={() => step(1)}
                title="Увеличить (×1.25)"
            >
                +
            </button>
            <button
                type="button"
                className="min-w-[64px] cursor-pointer rounded border border-transparent px-1.5 py-1 text-right font-mono text-[11px] leading-none text-lab-muted transition-colors hover:text-lab-text"
                onClick={zoomFit}
                title="Текущий зум — клик возвращает режим Fit"
            >
                {viewFit ? `Fit · ${z}%` : `${z}%`}
            </button>
        </div>
    );
}

/**
 * Янтарная плашка борт-контроля над стейджем: счётчик-бейдж + раскрываемый
 * список предупреждений (warn — янтарь, info — синий маркер).
 */
function WarningsBar() {
    const warnings = useLabStore((s) => s.warnings);
    const [open, setOpen] = useState(false);
    if (warnings.length === 0) return null;
    const warnCount = warnings.filter((w) => w.severity === 'warn').length;
    return (
        <div
            className="absolute top-3 left-3 z-40 flex max-w-[440px] flex-col gap-1.5"
            onPointerDown={(e) => e.stopPropagation()}
        >
            <button
                type="button"
                className={`flex cursor-pointer items-center gap-2 self-start rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                    open
                        ? 'border-amber-400/80 bg-amber-500/20 text-amber-200'
                        : 'border-amber-500/60 bg-amber-500/10 text-amber-300 hover:border-amber-400'
                }`}
                onClick={() => setOpen(!open)}
                title="Предупреждения борт-контроля: аспекты картинок, трансформ референса, покрытие переходов зоной blur, дубли стопов"
            >
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400/90 px-1 text-[10px] font-semibold text-lab-bg">
                    {warnings.length}
                </span>
                Предупреждения{warnCount > 0 ? ` · ${warnCount} важных` : ''}
            </button>
            {open && (
                <ul className="m-0 flex flex-col gap-1.5 rounded-lg border border-amber-500/50 bg-lab-panel/95 p-2.5 list-none shadow-xl">
                    {warnings.map((w) => (
                        <li
                            key={w.code}
                            className="flex items-start gap-2 text-left text-[11px] leading-snug"
                        >
                            <span
                                className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${
                                    w.severity === 'warn' ? 'bg-amber-400' : 'bg-sky-400'
                                }`}
                            />
                            <span className="min-w-0 text-amber-100/90">{w.message}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/**
 * Рабочая область: вьюпорт (overflow hidden, зум/пан) + канва (stage-фон
 * с картинкой, блок, ресайз-хэндлы, канвас-хэндлы, референс-оверлей — всё
 * внутри wrapper-а с transform: translate(pan) scale(zoom)). UI-слои вне
 * wrapper-а: плашка предупреждений и контрол зума.
 */
export function Stage() {
    const stageRef = useRef<HTMLDivElement>(null);
    const state = useLabStore((s) => s.state);
    const update = useLabStore((s) => s.update);
    const pushHistory = useLabStore((s) => s.pushHistory);
    const viewZoom = useLabStore((s) => s.viewZoom);
    const viewPan = useLabStore((s) => s.viewPan);
    const viewSpace = useLabStore((s) => s.viewSpace);
    const [panning, setPanning] = useState(false);
    const [viewPanning, setViewPanning] = useState(false);

    // размер вьюпорта стейджа — для Fit, зума к центру и колесного пана
    useEffect(() => {
        const el = stageRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            const r = entries[entries.length - 1].contentRect;
            useLabStore.getState().setViewSize({ w: r.width, h: r.height });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Space — режим пана (Figma-паттерн): канвасные драги глохнут; в полях
    // ввода и на кнопках Space работает штатно
    useEffect(() => {
        const inField = (a: Element | null): boolean =>
            a instanceof HTMLInputElement ||
            a instanceof HTMLTextAreaElement ||
            a instanceof HTMLSelectElement ||
            a instanceof HTMLButtonElement ||
            (a instanceof HTMLElement && a.isContentEditable);
        const isSpace = (e: KeyboardEvent): boolean => e.code === 'Space' || e.key === ' ';
        const down = (e: KeyboardEvent) => {
            if (!isSpace(e) || inField(document.activeElement)) return;
            e.preventDefault();
            useLabStore.getState().setViewSpace(true);
        };
        const up = (e: KeyboardEvent) => {
            if (!isSpace(e)) return;
            useLabStore.getState().setViewSpace(false);
        };
        const reset = () => useLabStore.getState().setViewSpace(false);
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        window.addEventListener('blur', reset);
        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
            window.removeEventListener('blur', reset);
        };
    }, []);

    // колесо над стейджем: ТОЛЬКО Ctrl/Cmd — зум к курсору (обычное колесо
    // не используется вовсе и уходит браузеру); preventDefault — только на зуме
    useEffect(() => {
        const el = stageRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const line = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
            // точка под курсором остаётся под курсором: anchor-формула в setViewZoom
            const factor = Math.exp(-e.deltaY * line * 0.0015);
            const st = useLabStore.getState();
            st.setViewZoom(st.viewZoom * factor, {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    // пан вью (Space+drag / средняя кнопка): дельты экранные, 1:1, без /zoom
    const onViewPointerDown = (e: ReactPointerEvent) => {
        if (!useLabStore.getState().viewSpace && e.button !== 1) return;
        e.preventDefault(); // СКМ: гасим автоскролл браузера
        const start = { ...useLabStore.getState().viewPan };
        setViewPanning(true);
        startPointerDrag(
            e,
            ({ dx, dy }) => {
                useLabStore.getState().setViewPan({ x: start.x + dx, y: start.y + dy });
            },
            () => setViewPanning(false)
        );
    };

    // перемещение блока; дельты курсора делим на zoom — блок следует за
    // курсором 1:1 при любом масштабе
    const onBlockPointerDown = (e: ReactPointerEvent) => {
        if (e.button !== 0 || useLabStore.getState().viewSpace) return;
        const start = { x: state.x, y: state.y };
        let pushed = false;
        startPointerDrag(e, ({ dx, dy }) => {
            const k = viewK();
            if (!pushed) {
                pushHistory();
                pushed = true;
            }
            update(
                (d) => {
                    d.x = Math.round(start.x + dx / k);
                    d.y = Math.round(start.y + dy / k);
                },
                { transient: true }
            );
        });
    };

    // пустое место канвы: drag — пан ВИДА, основной жест (всегда доступен,
    // кламп «часть блока видна» — в сторе). Alt+drag при bg=image — пан
    // фоновой КАРТИНКИ стейджа (Alt отдаёт жест фону, зеркально Alt-приоритету
    // блока; двигает stage.x/y — отдельная система от view-пана, поэтому /zoom).
    // Space/СКМ глохнут здесь — их пан стартует на вьюпорте
    const onContentPointerDown = (e: ReactPointerEvent) => {
        if (e.button !== 0 || e.target !== e.currentTarget) return;
        if (useLabStore.getState().viewSpace) return;
        if (e.altKey && state.stage.bg === 'image' && state.stage.image !== null) {
            const start = { x: state.stage.x, y: state.stage.y };
            let pushed = false;
            setPanning(true);
            startPointerDrag(
                e,
                ({ dx, dy }) => {
                    const k = viewK();
                    if (!pushed) {
                        pushHistory();
                        pushed = true;
                    }
                    update(
                        (d) => {
                            d.stage.x = Math.round(start.x + dx / k);
                            d.stage.y = Math.round(start.y + dy / k);
                        },
                        { transient: true }
                    );
                },
                () => setPanning(false)
            );
            return;
        }
        // пан вида: экранные дельты 1:1, без деления на zoom
        const start = { ...useLabStore.getState().viewPan };
        setViewPanning(true);
        startPointerDrag(
            e,
            ({ dx, dy }) => {
                useLabStore.getState().setViewPan({ x: start.x + dx, y: start.y + dy });
            },
            () => setViewPanning(false)
        );
    };

    // drop файла-картинки на стейдж — фон под блоком; остальные drop-типы игнорируем
    const onStageDrop = (e: DragEvent) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file === undefined || !file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => {
            update((d) => {
                d.stage.bg = 'image';
                d.stage.image = String(reader.result);
            });
        };
        reader.readAsDataURL(file);
    };

    // ресайз за 4 угловых хэндла (min 24px); дельты делим на zoom
    const onResizePointerDown = (e: ReactPointerEvent, corner: Corner) => {
        if (e.button !== 0 || useLabStore.getState().viewSpace) return;
        e.stopPropagation();
        const sx = corner.includes('e') ? 1 : -1;
        const sy = corner.includes('s') ? 1 : -1;
        const start = { x: state.x, y: state.y, w: state.w, h: state.h };
        let pushed = false;
        startPointerDrag(e, ({ dx, dy }) => {
            const k = viewK();
            const w = Math.max(MIN_SIZE, Math.round(start.w + (sx * dx) / k));
            const h = Math.max(MIN_SIZE, Math.round(start.h + (sy * dy) / k));
            if (!pushed) {
                pushHistory();
                pushed = true;
            }
            update(
                (d) => {
                    d.w = w;
                    d.h = h;
                    d.x = sx < 0 ? Math.round(start.x + (start.w - w)) : start.x;
                    d.y = sy < 0 ? Math.round(start.y + (start.h - h)) : start.y;
                },
                { transient: true }
            );
        });
    };

    const handlePos: Record<Corner, { left: number; top: number }> = {
        nw: { left: state.x - 6, top: state.y - 6 },
        ne: { left: state.x + state.w - 6, top: state.y - 6 },
        sw: { left: state.x - 6, top: state.y + state.h - 6 },
        se: { left: state.x + state.w - 6, top: state.y + state.h - 6 },
    };

    // картинка без блочного z-index: DOM-порядок до BlockBox держит её самым нижним слоем
    const hasBgImage = state.stage.bg === 'image' && state.stage.image !== null;
    const k = viewZoom / 100;
    // канва тянется (пан вида/фона/Space) — курсор grab; дети-хэндлы перекрывают своим
    const cursor = viewPanning || panning ? 'grabbing' : 'grab';

    return (
        <div
            ref={stageRef}
            className={`relative min-w-0 flex-1 touch-none overflow-hidden select-none ${
                state.stage.bg === 'checker' || (state.stage.bg === 'image' && !hasBgImage)
                    ? 'checkerboard'
                    : ''
            }`}
            style={{
                ...(state.stage.bg === 'solid' ? { backgroundColor: state.stage.color } : {}),
                ...(cursor !== undefined ? { cursor } : {}),
            }}
            onPointerDown={onViewPointerDown}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onStageDrop}
        >
            {/* канва: трансформируется зумом/паном; координаты внутри — система блока */}
            <div
                className="absolute inset-0"
                style={{
                    transform: `translate(${viewPan.x}px, ${viewPan.y}px) scale(${k})`,
                    transformOrigin: '0 0',
                }}
                onPointerDown={onContentPointerDown}
            >
                {hasBgImage && (
                    <img
                        src={state.stage.image ?? undefined}
                        alt=""
                        draggable={false}
                        className="absolute"
                        style={{
                            left: state.stage.x,
                            top: state.stage.y,
                            transform: `scale(${state.stage.scale / 100})`,
                            transformOrigin: '0 0',
                            imageRendering: 'auto',
                            pointerEvents: 'none',
                        }}
                    />
                )}
                <BlockBox onPointerDown={onBlockPointerDown} />
                <CompareOverlay stageRef={stageRef} />
                {CORNERS.map((corner) => (
                    <div
                        key={corner}
                        className={`absolute z-30 h-3 w-3 touch-none rounded-sm border border-white bg-lab-bg ${
                            viewSpace ? 'pointer-events-none' : ''
                        }`}
                        style={{ ...handlePos[corner], cursor: CORNER_CURSOR[corner] }}
                        onPointerDown={(e) => onResizePointerDown(e, corner)}
                    />
                ))}
                <CanvasHandles stageRef={stageRef} />
            </div>
            {/* UI-слои вне канвы: не зумятся, не панаются */}
            <WarningsBar />
            <ZoomControl />
        </div>
    );
}
