import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { blurRectBox, linearDir, pxToBoxPct, radialCenter } from '../lib/axis';
import { startPointerDrag } from '../lib/drag';
import { readGradient, targetAxisRect } from '../targets';
import { useLabStore } from '../store';
import type { BlockState, BlurRect, GradientTarget } from '../types';

interface CanvasHandlesProps {
    stageRef: RefObject<HTMLDivElement | null>;
}

function round01(n: number): number {
    return Math.round(n * 10) / 10;
}

/** Минимальный размер rect-области по каждой оси, % блока. */
const MIN_RECT_PCT = 1;

/**
 * rect-область активного таргета для контура/переноса/ресайза на канвасе:
 * layer:N — rect слоя, blurMask/blurBg — rect blur-слоя из таргета (при
 * включённом blur), underlay — его rect (при включённом underlay), прочие —
 * null.
 */
function rectHandleFor(state: BlockState, target: GradientTarget): BlurRect | null {
    switch (target.kind) {
        case 'layer':
            return state.layers[target.index]?.rect ?? null;
        case 'blurMask':
        case 'blurBg':
            return state.blur.enabled ? (state.blur.layers[target.layer]?.rect ?? null) : null;
        case 'underlay':
            return state.blur.underlay.enabled ? state.blur.underlay.rect : null;
        default:
            return null;
    }
}

/**
 * Канвас-хэндлы активного таргета поверх стейджа:
 * linear — ось через центр + хэндл угла; radial — крестовина центра,
 * для ellipse+explicit — ромбы радиусов rx/ry. Rect-таргеты (layer:N,
 * blurMask/blurBg, underlay) дополнительно получают контур rect-области
 * с ЧИП-подписью («Слой N» / «Область blur» / «Подложка»): drag внутри
 * контура — перемещение (при ЛЮБОМ rect, включая полный 100%), 4 угла —
 * ресайз (без clamp — область может заходить за края блока; Shift при
 * ресайзе — пропорциональное масштабирование одним коэффициентом от
 * противолежащего угла). Активный таргет ГЛАВНЕЕ блока: пока rect-таргет
 * активен, drag/углы внутри контура не двигают блок — блок доступен через
 * Alt+drag (перенос) / Alt+углы (ресайз) или полями X/Y/W/H инспектора.
 * Ось/центр/радиусы rect-таргетов живут в системе координат их rect
 * (CSS считает градиент от border-box элемента), остальных — от блока.
 * Хэндлы: белый fill, синяя обводка.
 */
export function CanvasHandles({ stageRef }: CanvasHandlesProps) {
    const state = useLabStore((s) => s.state);
    const activeTarget = useLabStore((s) => s.activeTarget);
    const gradient = useLabStore((s) => s.getGradient(activeTarget));
    const update = useLabStore((s) => s.update);
    const pushHistory = useLabStore((s) => s.pushHistory);
    const viewSpace = useLabStore((s) => s.viewSpace);
    const pushed = useRef(false);
    // Alt удерживается: хэндлы становятся «прозрачными» для указателя —
    // события уходят блоку под ними (drag/углы блока)
    const [altDown, setAltDown] = useState(false);
    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            if (e.key !== 'Alt') return;
            e.preventDefault(); // не активируем меню браузера
            setAltDown(true);
        };
        const up = (e: KeyboardEvent) => {
            if (e.key === 'Alt') setAltDown(false);
        };
        const reset = () => setAltDown(false);
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        window.addEventListener('blur', reset);
        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
            window.removeEventListener('blur', reset);
        };
    }, []);
    // класс интерактивных групп: с Alt — выключены (приоритет блока),
    // с Space — тоже (пан вью глушиит канвасные драги)
    const pe = altDown || viewSpace ? 'pointer-events-none' : 'pointer-events-auto';

    const active =
        gradient !== null &&
        ((activeTarget.kind === 'base' && state.base.kind === 'gradient') ||
            activeTarget.kind === 'layer' ||
            (activeTarget.kind === 'mask' && state.mask.enabled) ||
            (activeTarget.kind === 'blurMask' &&
                state.blur.enabled &&
                state.blur.layers[activeTarget.layer] !== undefined &&
                state.blur.layers[activeTarget.layer].mask !== null) ||
            (activeTarget.kind === 'blurBg' &&
                state.blur.enabled &&
                state.blur.layers[activeTarget.layer] !== undefined &&
                state.blur.layers[activeTarget.layer].gradient !== null) ||
            (activeTarget.kind === 'underlay' &&
                state.blur.underlay.enabled &&
                state.blur.underlay.gradient !== null) ||
            (activeTarget.kind === 'clipText' && state.clipText.enabled) ||
            (activeTarget.kind === 'animFrom' && state.anim.enabled) ||
            (activeTarget.kind === 'animTo' && state.anim.enabled));

    // rect-хэндлы показываются для активного layer/blur/underlay-таргета
    const handleRect = rectHandleFor(state, activeTarget);

    // первый шаг жеста — единственный push в past, дальше transient-обновления
    const beginGesture = () => {
        if (!pushed.current) {
            pushHistory();
            pushed.current = true;
        }
    };

    // экранные -> канвасные координаты: снимаем пан и зум wrapper-а стейджа
    // (все координатные жесты обязаны видеть систему блока при любом зуме)
    const stagePoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
        const rect = stageRef.current?.getBoundingClientRect();
        if (!rect) return null;
        const { viewPan, viewZoom } = useLabStore.getState();
        const k = viewZoom / 100;
        return {
            x: (clientX - rect.left - viewPan.x) / k,
            y: (clientY - rect.top - viewPan.y) / k,
        };
    };

    if (handleRect === null && (!active || !gradient)) return null;

    const b = { x: state.x, y: state.y, w: state.w, h: state.h };
    // система координат оси активного градиента: rect-таргеты (blur/underlay/
    // слой с частичным rect) — свой rect (градиент считается от border-box
    // элемента), остальные — блок
    const axisRect = targetAxisRect(state, activeTarget);
    const axisBox = axisRect !== undefined ? blurRectBox(axisRect, b) : b;
    const centerX = axisBox.x + axisBox.w / 2;
    const centerY = axisBox.y + axisBox.h / 2;

    // --- rect-область активного таргета: перенос за площадь, ресайз за 4 угла ---
    // координатное пространство — блок; БЕЗ clamp: rect может заходить за края
    const onRectPointerDown = (e: ReactPointerEvent) => {
        if (e.button !== 0 || viewSpace) return; // Space/СКМ — пан вью, жест глушим
        e.stopPropagation();
        if (handleRect === null) return;
        const start = { x: handleRect.x, y: handleRect.y };
        pushed.current = false;
        startPointerDrag(e, ({ dx, dy }) => {
            const k = useLabStore.getState().viewZoom / 100;
            beginGesture();
            update(
                (d) => {
                    const r = rectHandleFor(d, activeTarget);
                    if (r === null) return;
                    r.x = round01(start.x + (dx / k / b.w) * 100);
                    r.y = round01(start.y + (dy / k / b.h) * 100);
                },
                { transient: true }
            );
        });
    };

    const onRectCornerPointerDown = (e: ReactPointerEvent, corner: string) => {
        if (e.button !== 0 || viewSpace) return;
        e.stopPropagation();
        if (handleRect === null) return;
        const sx = corner.includes('e') ? 1 : -1;
        const sy = corner.includes('s') ? 1 : -1;
        const start = { ...handleRect };
        pushed.current = false;
        startPointerDrag(e, ({ dx, dy, ev }) => {
            const k = useLabStore.getState().viewZoom / 100;
            const dw = ((sx * dx) / k / b.w) * 100;
            const dh = ((sy * dy) / k / b.h) * 100;
            let w: number;
            let h: number;
            if (ev.shiftKey) {
                // Shift — пропорциональный ресайз: один коэффициент для w/h
                // (берём ось с большей относительной тягой), якорь — противолежащий угол
                const kw = (start.w + dw) / start.w;
                const kh = (start.h + dh) / start.h;
                const k = Math.abs(kw - 1) >= Math.abs(kh - 1) ? kw : kh;
                w = Math.max(MIN_RECT_PCT, round01(start.w * k));
                h = Math.max(MIN_RECT_PCT, round01(start.h * k));
            } else {
                w = Math.max(MIN_RECT_PCT, round01(start.w + dw));
                h = Math.max(MIN_RECT_PCT, round01(start.h + dh));
            }
            beginGesture();
            update(
                (d) => {
                    const r = rectHandleFor(d, activeTarget);
                    if (r === null) return;
                    r.w = w;
                    r.h = h;
                    // противоположный край фиксирован — при клампе размера сдвигаем этот
                    r.x = sx < 0 ? round01(start.x + (start.w - w)) : start.x;
                    r.y = sy < 0 ? round01(start.y + (start.h - h)) : start.y;
                },
                { transient: true }
            );
        });
    };

    // linear: угол A -> вектор оси (sin A, -cos A) (CSS: 0 = to top, 90 = to right)
    const onAnglePointerDown = (e: ReactPointerEvent) => {
        if (e.button !== 0 || viewSpace) return;
        e.stopPropagation();
        pushed.current = false;
        startPointerDrag(e, ({ x, y }) => {
            const p = stagePoint(x, y);
            if (!p) return;
            const vx = p.x - centerX;
            const vy = p.y - centerY;
            const deg = (Math.atan2(vx, -vy) * 180) / Math.PI;
            const norm = ((deg % 360) + 360) % 360;
            beginGesture();
            update(
                (d) => {
                    const g = readGradient(d, activeTarget);
                    if (g?.type === 'linear') g.angle = round01(norm);
                },
                { transient: true }
            );
        });
    };

    const onCenterPointerDown = (e: ReactPointerEvent) => {
        if (e.button !== 0 || viewSpace) return;
        e.stopPropagation();
        pushed.current = false;
        startPointerDrag(e, ({ x, y }) => {
            const p = stagePoint(x, y);
            if (!p) return;
            const pct = pxToBoxPct(p.x, p.y, axisBox);
            const cx = round01(pct.x);
            const cy = round01(pct.y);
            beginGesture();
            update(
                (d) => {
                    const g = readGradient(d, activeTarget);
                    if (g?.type === 'radial') {
                        g.cx = cx;
                        g.cy = cy;
                    }
                },
                { transient: true }
            );
        });
    };

    const onRadiusPointerDown = (e: ReactPointerEvent, axis: 'rx' | 'ry') => {
        if (e.button !== 0 || viewSpace) return;
        e.stopPropagation();
        if (!gradient || gradient.type !== 'radial') return;
        pushed.current = false;
        const gcx = gradient.cx;
        const gcy = gradient.cy;
        startPointerDrag(e, ({ x, y }) => {
            const p = stagePoint(x, y);
            if (!p) return;
            beginGesture();
            update(
                (d) => {
                    const g = readGradient(d, activeTarget);
                    if (g?.type !== 'radial') return;
                    const pct = pxToBoxPct(p.x, p.y, axisBox);
                    if (axis === 'rx') {
                        g.rx = Math.max(0, round01(pct.x - gcx));
                    } else {
                        g.ry = Math.max(0, round01(pct.y - gcy));
                    }
                },
                { transient: true }
            );
        });
    };

    let axisHandles = null;
    if (active && gradient?.type === 'linear') {
        const dir = linearDir(gradient.angle);
        const len = Math.hypot(axisBox.w, axisBox.h) / 2 + 28;
        const p1 = { x: centerX - dir.x * len, y: centerY - dir.y * len };
        const p2 = { x: centerX + dir.x * len, y: centerY + dir.y * len };
        axisHandles = (
            <>
                <line
                    x1={p1.x}
                    y1={p1.y}
                    x2={p2.x}
                    y2={p2.y}
                    stroke="rgba(255, 255, 255, 0.55)"
                    strokeWidth={1}
                    strokeDasharray="5 4"
                />
                <circle cx={p1.x} cy={p1.y} r={3} fill="rgba(255, 255, 255, 0.55)" />
                <circle cx={centerX} cy={centerY} r={2.5} fill="rgba(255, 255, 255, 0.55)" />
                <g className={`${pe} cursor-grab touch-none`} onPointerDown={onAnglePointerDown}>
                    <circle cx={p2.x} cy={p2.y} r={14} fill="transparent" />
                    <circle
                        cx={p2.x}
                        cy={p2.y}
                        r={5.5}
                        fill="#fff"
                        stroke="#3b82f6"
                        strokeWidth={2}
                    />
                </g>
            </>
        );
    } else if (active && gradient?.type === 'radial') {
        const c = radialCenter(gradient.cx, gradient.cy, axisBox);
        const px = c.x;
        const py = c.y;
        const hx = px + (gradient.rx / 100) * axisBox.w;
        const hy = py + (gradient.ry / 100) * axisBox.h;
        const explicit = gradient.shape === 'ellipse' && gradient.size === 'explicit';

        axisHandles = (
            <>
                <line
                    x1={px - 11}
                    y1={py}
                    x2={px + 11}
                    y2={py}
                    stroke="rgba(255, 255, 255, 0.55)"
                    strokeWidth={1}
                />
                <line
                    x1={px}
                    y1={py - 11}
                    x2={px}
                    y2={py + 11}
                    stroke="rgba(255, 255, 255, 0.55)"
                    strokeWidth={1}
                />
                {explicit && (
                    <>
                        <line
                            x1={px}
                            y1={py}
                            x2={hx}
                            y2={py}
                            stroke="rgba(59, 130, 246, 0.7)"
                            strokeWidth={1}
                        />
                        <line
                            x1={px}
                            y1={py}
                            x2={px}
                            y2={hy}
                            stroke="rgba(59, 130, 246, 0.7)"
                            strokeWidth={1}
                        />
                    </>
                )}
                <g className={`${pe} cursor-move touch-none`} onPointerDown={onCenterPointerDown}>
                    <circle cx={px} cy={py} r={14} fill="transparent" />
                    <circle cx={px} cy={py} r={5.5} fill="#fff" stroke="#3b82f6" strokeWidth={2} />
                </g>
                {explicit && (
                    <>
                        <g
                            className={`${pe} cursor-ew-resize touch-none`}
                            onPointerDown={(e) => onRadiusPointerDown(e, 'rx')}
                        >
                            <rect x={hx - 9} y={py - 9} width={18} height={18} fill="transparent" />
                            <rect
                                x={hx - 4.5}
                                y={py - 4.5}
                                width={9}
                                height={9}
                                fill="#fff"
                                stroke="#3b82f6"
                                strokeWidth={2}
                                transform={`rotate(45 ${hx} ${py})`}
                            />
                        </g>
                        <g
                            className={`${pe} cursor-ns-resize touch-none`}
                            onPointerDown={(e) => onRadiusPointerDown(e, 'ry')}
                        >
                            <rect x={px - 9} y={hy - 9} width={18} height={18} fill="transparent" />
                            <rect
                                x={px - 4.5}
                                y={hy - 4.5}
                                width={9}
                                height={9}
                                fill="#fff"
                                stroke="#3b82f6"
                                strokeWidth={2}
                                transform={`rotate(45 ${px} ${hy})`}
                            />
                        </g>
                    </>
                )}
            </>
        );
    }

    let rectHandles = null;
    if (handleRect !== null) {
        const r = handleRect;
        const rp = {
            x: b.x + (r.x / 100) * b.w,
            y: b.y + (r.y / 100) * b.h,
            w: (r.w / 100) * b.w,
            h: (r.h / 100) * b.h,
        };
        // чип-подпись таргета: что сейчас таскаем
        const label =
            activeTarget.kind === 'layer'
                ? `Слой ${activeTarget.index + 1}`
                : activeTarget.kind === 'underlay'
                  ? 'Подложка'
                  : activeTarget.kind === 'blurMask' || activeTarget.kind === 'blurBg'
                    ? `Область blur ${activeTarget.layer + 1}`
                    : 'Область blur';
        const chipW = label.length * 6 + 14;
        // над верхней гранью; если контур прижат к верху стейджа — внутрь контура
        const chipY = rp.y >= 26 ? rp.y - 21 : rp.y + 5;
        rectHandles = (
            <g className={`${pe} cursor-grab touch-none`} onPointerDown={onRectPointerDown}>
                {/* внутренняя зона переноса — при ЛЮБОМ rect, включая полный:
                    активный таргет главнее блока (блок — через Alt) */}
                <rect x={rp.x} y={rp.y} width={rp.w} height={rp.h} fill="transparent" />
                <rect
                    x={rp.x}
                    y={rp.y}
                    width={rp.w}
                    height={rp.h}
                    fill="none"
                    stroke="#3b82f6"
                    strokeWidth={1.5}
                    strokeDasharray="5 4"
                    className="pointer-events-none"
                />
                {(
                    [
                        ['nw', rp.x, rp.y, 'nwse-resize'],
                        ['ne', rp.x + rp.w, rp.y, 'nesw-resize'],
                        ['sw', rp.x, rp.y + rp.h, 'nesw-resize'],
                        ['se', rp.x + rp.w, rp.y + rp.h, 'nwse-resize'],
                    ] as const
                ).map(([corner, cx, cy, cursor]) => (
                    <g
                        key={corner}
                        className={`${pe} ${cursor} touch-none`}
                        onPointerDown={(e) => onRectCornerPointerDown(e, corner)}
                    >
                        <rect x={cx - 9} y={cy - 9} width={18} height={18} fill="transparent" />
                        <rect
                            x={cx - 4.5}
                            y={cy - 4.5}
                            width={9}
                            height={9}
                            fill="#fff"
                            stroke="#3b82f6"
                            strokeWidth={2}
                        />
                    </g>
                ))}
                {/* чип-подпись: ЧТО сейчас таскаешь; у верхней грани, а если
                    контур у самого верха стейджа — внутри контура */}
                <g className="pointer-events-none">
                    <rect
                        x={rp.x + rp.w / 2 - chipW / 2}
                        y={chipY}
                        width={chipW}
                        height={16}
                        rx={4}
                        fill="#7c6cff"
                    />
                    <text
                        x={rp.x + rp.w / 2}
                        y={chipY + 8}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={10}
                        fill="#fff"
                    >
                        {label}
                    </text>
                </g>
            </g>
        );
    }

    // z-[35]: выше угловых хэндлов блока (z-30) — при совпадении углов
    // побеждает активный таргет (Alt делает хэндлы прозрачными для блока);
    // ниже попапов/плашек z-40; корень pointer-events-none
    return (
        <svg className="pointer-events-none absolute inset-0 z-[35] h-full w-full overflow-visible">
            {rectHandles}
            {axisHandles}
        </svg>
    );
}
