interface SegmentedControlProps<T extends string> {
    value: T;
    options: { value: T; label: string; title?: string }[];
    onChange: (value: T) => void;
}

/**
 * Сегментированный контрол: при нехватке ширины ряд переносится на следующие
 * строки (wrap) — все опции всегда видны целиком, клипа/скролла нет.
 * Кнопки контент-сайза (flex-none + whitespace-nowrap).
 */
export function SegmentedControl<T extends string>({
    value,
    options,
    onChange,
}: SegmentedControlProps<T>) {
    return (
        <div className="flex w-full min-w-0 flex-wrap gap-1 rounded-md border border-lab-border bg-lab-panel2 p-1">
            {options.map((opt) => (
                <button
                    key={opt.value}
                    type="button"
                    title={opt.title}
                    className={`flex-none cursor-pointer rounded px-2 py-1 text-xs whitespace-nowrap transition-colors ${
                        value === opt.value
                            ? 'bg-lab-accent text-white'
                            : 'text-lab-muted hover:text-lab-text'
                    }`}
                    onClick={() => onChange(opt.value)}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    );
}
