import { gradientToCss } from '../cssgen';
import { uid } from '../schema';
import { useLabStore } from '../store';
import type { BgLayer, LinearGradient } from '../types';
import { DuplicateIcon, EyeIcon, EyeOffIcon, PlusIcon, TrashIcon } from './icons';

function freshLayer(): BgLayer {
    const gradient: LinearGradient = {
        type: 'linear',
        angle: 135,
        repeating: false,
        stops: [
            { id: uid(), pos: 0, color: '#7c6cff', alpha: 1 },
            { id: uid(), pos: 100, color: '#ff5e8a', alpha: 1 },
        ],
    };
    return {
        id: uid(),
        visible: true,
        opacity: 1,
        blend: 'normal',
        gradient,
        rect: { x: 0, y: 0, w: 100, h: 100 },
    };
}

/** Список слоёв: глаз, свотч, dup/delete; клик по строке делает слой активным. */
export function LayerList() {
    const layers = useLabStore((s) => s.state.layers);
    const activeTarget = useLabStore((s) => s.activeTarget);
    const setActiveTarget = useLabStore((s) => s.setActiveTarget);
    const update = useLabStore((s) => s.update);

    const activeIndex = activeTarget.kind === 'layer' ? activeTarget.index : -1;

    const addLayer = () => {
        update((d) => {
            d.layers.push(freshLayer());
        });
        setActiveTarget({ kind: 'layer', index: layers.length });
    };

    const duplicateLayer = (i: number) => {
        update((d) => {
            const src = d.layers[i];
            if (!src) return;
            const copy = structuredClone(src);
            copy.id = uid();
            copy.gradient.stops.forEach((s) => {
                s.id = uid();
            });
            d.layers.splice(i + 1, 0, copy);
        });
        setActiveTarget({ kind: 'layer', index: i + 1 });
    };

    const removeLayer = (i: number) => {
        update((d) => {
            d.layers.splice(i, 1);
        });
        if (activeTarget.kind === 'layer' && activeTarget.index >= layers.length - 1) {
            setActiveTarget({ kind: 'layer', index: Math.max(0, layers.length - 2) });
        }
    };

    const toggleVisible = (i: number) => {
        update((d) => {
            const layer = d.layers[i];
            if (layer) layer.visible = !layer.visible;
        });
    };

    return (
        <div className="flex min-w-0 flex-col gap-1.5">
            {layers.map((layer, i) => {
                const isActive = i === activeIndex;
                return (
                    <div
                        key={layer.id}
                        className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 ${
                            isActive
                                ? 'border-lab-accent bg-lab-panel2'
                                : 'border-lab-border bg-lab-panel2/50 hover:border-lab-accent/60'
                        }`}
                        onClick={() => setActiveTarget({ kind: 'layer', index: i })}
                    >
                        <button
                            type="button"
                            title={layer.visible ? 'Скрыть слой' : 'Показать слой'}
                            className={`flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md hover:text-lab-text ${
                                layer.visible ? 'text-lab-text' : 'text-lab-muted'
                            }`}
                            onClick={(e) => {
                                e.stopPropagation();
                                toggleVisible(i);
                            }}
                        >
                            {layer.visible ? <EyeIcon /> : <EyeOffIcon />}
                        </button>
                        <div className="checkerboard h-6 w-9 shrink-0 overflow-hidden rounded border border-lab-border">
                            <div
                                className="h-full w-full"
                                style={{ background: gradientToCss(layer.gradient) }}
                            />
                        </div>
                        <span className="min-w-0 flex-1 truncate text-xs">Слой {i + 1}</span>
                        <button
                            type="button"
                            title="Дублировать слой"
                            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-lab-muted hover:text-lab-text"
                            onClick={(e) => {
                                e.stopPropagation();
                                duplicateLayer(i);
                            }}
                        >
                            <DuplicateIcon />
                        </button>
                        <button
                            type="button"
                            title="Удалить слой"
                            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-lab-muted hover:text-lab-text"
                            onClick={(e) => {
                                e.stopPropagation();
                                removeLayer(i);
                            }}
                        >
                            <TrashIcon />
                        </button>
                    </div>
                );
            })}
            <button
                type="button"
                className="flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-lab-border py-1.5 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text"
                onClick={addLayer}
            >
                <PlusIcon />
                Слой
            </button>
        </div>
    );
}
