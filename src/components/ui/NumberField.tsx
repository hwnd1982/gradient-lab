import { useState } from 'react';

interface NumberFieldProps {
    label?: string;
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
}

/**
 * Числовое поле: controlled, с NaN-гвардом.
 * Пока пользователь печатает, показываем его текст; на blur — значение из стейта.
 */
export function NumberField({
    label,
    value,
    onChange,
    min,
    max,
    step,
    disabled,
}: NumberFieldProps) {
    const [text, setText] = useState<string | null>(null);
    const shown = text ?? String(value);

    const handleChange = (raw: string) => {
        setText(raw);
        if (raw.trim() === '') return;
        const n = Number(raw.replace(',', '.'));
        if (!Number.isFinite(n)) return;
        let v = n;
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        onChange(v);
    };

    return (
        <label className="flex min-w-0 flex-col gap-1">
            {label !== undefined && (
                <span className="text-[11px] leading-none text-lab-muted">{label}</span>
            )}
            <input
                type="number"
                className="w-full min-w-0 rounded-md border border-lab-border bg-lab-panel2 px-2 py-1.5 text-xs text-lab-text outline-none focus:border-lab-accent disabled:opacity-40"
                value={shown}
                min={min}
                max={max}
                step={step ?? 1}
                disabled={disabled}
                onChange={(e) => handleChange(e.target.value)}
                onBlur={() => setText(null)}
            />
        </label>
    );
}
