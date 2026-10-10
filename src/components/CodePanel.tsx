import { useEffect, useRef, useState } from 'react';
import { stateToCssText, stateToSassText } from '../cssgen';
import { useLabStore } from '../store';

type CodeTab = 'css' | 'sass';

/** Нижняя панель: CSS | Sass + анти-бэндинг + копирование. */
export function CodePanel() {
    const state = useLabStore((s) => s.state);
    const [tab, setTab] = useState<CodeTab>('css');
    const [copied, setCopied] = useState(false);
    const [antiBand, setAntiBand] = useState(false);
    const timerRef = useRef<number | null>(null);

    useEffect(() => {
        return () => {
            if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        };
    }, []);

    // анти-бэндинг — пост-процесс только ТЕКСТА экспорта (ресэмпл 12–16 стопов
    // с детерминированным дизерингом ±1–2 канала), стейт не меняет
    const code =
        tab === 'css' ? stateToCssText(state, { antiBand }) : stateToSassText(state, { antiBand });

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            if (timerRef.current !== null) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => setCopied(false), 1500);
        } catch {
            setCopied(false);
        }
    };

    return (
        <div className="flex h-[260px] shrink-0 flex-col border-t border-lab-border bg-lab-panel">
            <div className="flex items-center justify-between gap-2 border-b border-lab-border px-3 py-2">
                <div className="inline-flex overflow-hidden rounded-md border border-lab-border bg-lab-panel2">
                    {(['css', 'sass'] as const).map((t) => (
                        <button
                            key={t}
                            type="button"
                            className={`cursor-pointer px-3 py-1 text-xs uppercase transition-colors ${
                                tab === t
                                    ? 'bg-lab-accent text-white'
                                    : 'text-lab-muted hover:text-lab-text'
                            }`}
                            onClick={() => setTab(t)}
                        >
                            {t}
                        </button>
                    ))}
                </div>
                <label
                    className="flex cursor-pointer items-center gap-1.5"
                    title="Ресэмпл градиентов до 12–16 стопов (равномерные + ключевые экстремумы альфы точно) с детерминированным дизерингом ±1–2 канала — против полос на широких плавных фейдах. Меняет только текст экспорта, стейт не трогает"
                >
                    <input
                        type="checkbox"
                        className="accent-lab-accent"
                        checked={antiBand}
                        onChange={(e) => setAntiBand(e.target.checked)}
                    />
                    <span className="text-[11px] leading-none text-lab-muted">Анти-бэндинг</span>
                </label>
                <button
                    type="button"
                    className={`cursor-pointer rounded-md border px-2.5 py-1 text-xs transition-colors ${
                        copied
                            ? 'border-lab-accent text-lab-accent'
                            : 'border-lab-border bg-lab-panel2 text-lab-text hover:border-lab-accent'
                    }`}
                    onClick={copy}
                >
                    {copied ? 'Скопировано ✓' : 'Копировать'}
                </button>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-5 text-lab-text">
                {code}
            </pre>
        </div>
    );
}
