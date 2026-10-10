import { useState } from 'react';
import { HexColorPicker } from 'react-colorful';
import { isValidHex } from '../../lib/color';

interface ColorFieldProps {
    label?: string;
    /** '#rrggbb' */
    value: string;
    /**
     * continuous=true — цвет пришёл из драга пикера (родитель делает
     * transient-update); без флага — дискретный ввод hex-текста.
     */
    onChange: (hex: string, continuous?: boolean) => void;
    /** Вызывается на pointerdown пикера — точка для pushHistory(). */
    onGestureStart?: () => void;
    /** Если передан — показывает кнопку сброса цвета. */
    onClear?: () => void;
}

export function ColorField({ label, value, onChange, onGestureStart, onClear }: ColorFieldProps) {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState<string | null>(null);
    const shown = (text ?? value).toUpperCase();

    const commitText = (raw: string) => {
        setText(raw);
        const v = raw.startsWith('#') ? raw : `#${raw}`;
        if (isValidHex(v)) onChange(v.toLowerCase());
    };

    return (
        <div className="relative flex min-w-0 flex-col gap-1">
            {label !== undefined && (
                <span className="text-[11px] leading-none text-lab-muted">{label}</span>
            )}
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    title="Открыть пикер"
                    className="checkerboard h-7 w-10 shrink-0 cursor-pointer overflow-hidden rounded-md border border-lab-border hover:border-lab-accent"
                    onClick={() => setOpen(!open)}
                >
                    <span className="block h-full w-full" style={{ backgroundColor: value }} />
                </button>
                <input
                    className="w-full min-w-0 rounded-md border border-lab-border bg-lab-panel2 px-2 py-1.5 font-mono text-xs tracking-wide uppercase outline-none focus:border-lab-accent"
                    value={shown}
                    onChange={(e) => commitText(e.target.value)}
                    onBlur={() => setText(null)}
                    spellCheck={false}
                />
                {onClear !== undefined && (
                    <button
                        type="button"
                        title="Убрать цвет"
                        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-lab-border bg-lab-panel2 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text"
                        onClick={onClear}
                    >
                        ×
                    </button>
                )}
            </div>
            {open && (
                <>
                    <button
                        type="button"
                        aria-label="Закрыть пикер"
                        className="fixed inset-0 z-40 cursor-default"
                        onClick={() => setOpen(false)}
                    />
                    <div className="absolute top-full left-0 z-50 rounded-lg border border-lab-border bg-lab-panel2 p-3 shadow-xl">
                        <div onPointerDown={() => onGestureStart?.()}>
                            <HexColorPicker
                                color={value}
                                onChange={(hex) => onChange(hex, true)}
                                style={{ width: 172, height: 138 }}
                            />
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
