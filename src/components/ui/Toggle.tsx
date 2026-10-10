interface ToggleProps {
    label?: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}

export function Toggle({ label, checked, onChange }: ToggleProps) {
    const track = (
        <span
            className={`relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors ${
                checked ? 'bg-lab-accent' : 'bg-lab-border'
            }`}
        >
            <span
                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                    checked ? 'left-[14px]' : 'left-0.5'
                }`}
            />
        </span>
    );

    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            className={
                label === undefined
                    ? 'cursor-pointer'
                    : 'flex w-full cursor-pointer items-center justify-between gap-2 py-0.5'
            }
            onClick={() => onChange(!checked)}
        >
            {label !== undefined && <span className="text-xs text-lab-text">{label}</span>}
            {track}
        </button>
    );
}
