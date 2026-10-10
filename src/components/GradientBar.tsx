import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { uid } from '../schema';
import { stopsToCss } from '../cssgen';
import { fmtNum, rgbaString } from '../lib/color';
import { startPointerDrag } from '../lib/drag';
import { readGradient } from '../targets';
import { useLabStore } from '../store';
import type { GradientTarget, Stop } from '../types';

interface GradientBarProps {
    target: GradientTarget;
}

function round01(n: number): number {
    return Math.round(n * 10) / 10;
}

function nearestStop(stops: Stop[], pos: number): Stop {
    return stops.reduce((best, s) => (Math.abs(s.pos - pos) < Math.abs(best.pos - pos) ? s : best));
}

/** Полоса стопов градиента: фон всегда linear-gradient(90deg, stops), маркеры-ромбы. */
export function GradientBar({ target }: GradientBarProps) {
    const gradient = useLabStore((s) => s.getGradient(target));
    const selectedStopId = useLabStore((s) => s.selectedStopId);
    const setSelectedStop = useLabStore((s) => s.setSelectedStop);
    const update = useLabStore((s) => s.update);
    const pushHistory = useLabStore((s) => s.pushHistory);
    const barRef = useRef<HTMLDivElement>(null);

    if (!gradient) return null;
    const stops = gradient.stops;
    const selected = stops.find((s) => s.id === selectedStopId) ?? null;

    const posFromClientX = (clientX: number): number => {
        const rect = barRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return 0;
        return round01(((clientX - rect.left) / rect.width) * 100);
    };

    const onMarkerPointerDown = (e: ReactPointerEvent, stopId: string) => {
        e.stopPropagation();
        setSelectedStop(stopId);
        let pushed = false;
        startPointerDrag(e, ({ x }) => {
            const pos = posFromClientX(x);
            if (!pushed) {
                pushHistory();
                pushed = true;
            }
            update(
                (d) => {
                    const g = readGradient(d, target);
                    const stop = g?.stops.find((s) => s.id === stopId);
                    if (stop) stop.pos = pos;
                },
                { transient: true }
            );
        });
    };

    // клик по полосе (не по стопу) — добавить стоп с цветом текущего/ближайшего
    const onBarPointerDown = (e: ReactPointerEvent) => {
        if (e.button !== 0 || stops.length === 0) return;
        const pos = posFromClientX(e.clientX);
        const src = stops.find((s) => s.id === selectedStopId) ?? nearestStop(stops, pos);
        const stop: Stop = { id: uid(), pos, color: src.color, alpha: src.alpha };
        update((d) => {
            const g = readGradient(d, target);
            if (!g) return;
            g.stops.push(stop);
            g.stops.sort((a, b) => a.pos - b.pos);
        });
        setSelectedStop(stop.id);
    };

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div
                ref={barRef}
                className="checkerboard relative h-10 touch-none rounded-md border border-lab-border"
                style={{ cursor: 'copy' }}
                onPointerDown={onBarPointerDown}
            >
                <div
                    className="pointer-events-none absolute inset-0 rounded-md"
                    style={{ background: `linear-gradient(90deg, ${stopsToCss(stops)})` }}
                />
                {stops.map((stop) => {
                    const isSelected = stop.id === selectedStopId;
                    return (
                        <button
                            key={stop.id}
                            type="button"
                            title={`${fmtNum(stop.pos)}%`}
                            className={`absolute top-1/2 h-3.5 w-3.5 touch-none -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ew-resize rounded-[2px] border-2 ${
                                isSelected ? 'z-10 border-lab-accent' : 'border-white'
                            }`}
                            style={{
                                left: `${stop.pos}%`,
                                backgroundColor: rgbaString(stop.color, stop.alpha),
                            }}
                            onPointerDown={(e) => onMarkerPointerDown(e, stop.id)}
                        />
                    );
                })}
            </div>
            {selected !== null && (
                <div className="relative h-4">
                    <span
                        className="absolute -translate-x-1/2 text-[10px] leading-4 whitespace-nowrap text-lab-muted"
                        style={{ left: `${Math.min(97, Math.max(3, selected.pos))}%` }}
                    >
                        {fmtNum(selected.pos)}%
                    </span>
                </div>
            )}
        </div>
    );
}
