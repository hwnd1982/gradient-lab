interface SelectFieldProps<T extends string> {
    label?: string;
    value: T;
    options: { value: T; label: string }[];
    onChange: (value: T) => void;
}

export function SelectField<T extends string>({
    label,
    value,
    options,
    onChange,
}: SelectFieldProps<T>) {
    return (
        <label className="flex min-w-0 flex-col gap-1">
            {label !== undefined && (
                <span className="text-[11px] leading-none text-lab-muted">{label}</span>
            )}
            <select
                className="w-full min-w-0 cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2 py-1.5 text-xs text-lab-text outline-none focus:border-lab-accent"
                value={value}
                onChange={(e) => onChange(e.target.value as T)}
            >
                {options.map((o) => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </select>
        </label>
    );
}
