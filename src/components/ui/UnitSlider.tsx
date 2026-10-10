import { NumberField } from './NumberField';

interface UnitSliderProps {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    unit?: string;
    /**
     * continuous=true — значение пришло из драга ползунка (родитель делает
     * transient-update); без флага — дискретный ввод из числового поля.
     */
    onChange: (value: number, continuous?: boolean) => void;
    /** Вызывается на pointerdown ползунка — точка для pushHistory(). */
    onGestureStart?: () => void;
}

/** Слайдер + число в одну строку. */
export function UnitSlider({
    label,
    value,
    min,
    max,
    step,
    unit,
    onChange,
    onGestureStart,
}: UnitSliderProps) {
    const clamped = Math.min(max, Math.max(min, value));

    return (
        <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] leading-none text-lab-muted">{label}</span>
                <div className="flex w-[74px] items-center gap-1">
                    <div className="min-w-0 flex-1">
                        <NumberField
                            value={value}
                            min={min}
                            max={max}
                            step={step}
                            onChange={(v) => onChange(v)}
                        />
                    </div>
                    {unit !== undefined && (
                        <span className="text-[10px] leading-none text-lab-muted">{unit}</span>
                    )}
                </div>
            </div>
            <input
                type="range"
                className="accent-lab-accent"
                value={clamped}
                min={min}
                max={max}
                step={step ?? 1}
                onPointerDown={() => onGestureStart?.()}
                onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) onChange(n, true);
                }}
            />
        </div>
    );
}
