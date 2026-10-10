import { useEffect, useRef, useState } from 'react';
import { fetchSessions } from '../lib/agentTransport';
import type { SessionInfo } from '../lib/agentTransport';
import { SESSION_ID_RE } from '../lib/session';

/**
 * Бриф для агента по текущей сессии (динамический): origin + id + минимальный
 * цикл. Собирается в момент копирования — сессия/домен всегда актуальны.
 */
function agentBrief(sessionId: string): string {
    return [
        `Ты работаешь с песочницей Gradient Lab: ${window.location.origin}`,
        `Сессия: ${sessionId} — заголовок "X-Lab-Session: ${sessionId}" на КАЖДЫЙ запрос.`,
        'Цикл: GET /api/state → правки → PUT /api/state (ПОЛНЫЙ BlockState) → GET /api/warnings (чинить до пусто) → GET /api/analysis?target=<таргет> (zoneMatchPercent/residuals/verdict/suggestedStops + hint) → повтор. Откат — GET /api/journal. Перебор радиуса — POST /api/sweep. Алгоритм целиком — GET /api/methodology.',
    ].join('\n');
}

/**
 * Селектор сессии в хедере (только прод — dev однопользовательский, всегда
 * 'default', селектор не монтируется): компактный «Сессия: <id>» → поповер с
 * полем id («Открыть/создать» — слот на сервере создаётся лениво), списком
 * живых сессий GET /api/sessions (клик — открыть, текущая подсвечена) и
 * блоком «Инструкция агенту» — копирование брифа текущей сессии в буфер.
 * Смена сессии — колбэк в App (sessionStorage + перезапуск синк/поллинга);
 * вид (зум/пан) не трогаем.
 */
export function HeaderSession({
    session,
    onSwitch,
}: {
    session: string;
    onSwitch: (id: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [error, setError] = useState('');
    const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
    const [copied, setCopied] = useState(false);
    const copyTimer = useRef<number | null>(null);
    const boxRef = useRef<HTMLDivElement | null>(null);

    // список живых сессий — при каждом открытии (лёгкий открытый GET);
    // сброс списка делает toggler кнопки (не setState в эффекте)
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        void fetchSessions().then((list) => {
            if (!cancelled) setSessions(list);
        });
        return () => {
            cancelled = true;
        };
    }, [open]);

    // клик мимо поповера — закрыть
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent): void => {
            if (boxRef.current !== null && !boxRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    useEffect(() => {
        return () => {
            if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
        };
    }, []);

    const openSession = (id: string): void => {
        const trimmed = id.trim();
        if (!SESSION_ID_RE.test(trimmed)) {
            setError('id: [a-zA-Z0-9_-], 1..64 символа');
            return;
        }
        setOpen(false);
        setError('');
        if (trimmed !== session) onSwitch(trimmed);
    };

    const copyBrief = async (): Promise<void> => {
        let ok = false;
        try {
            await navigator.clipboard.writeText(agentBrief(session));
            ok = true;
        } catch {
            // clipboard недоступен (нет разрешения/не https) — текст остаётся
            // в блоке, выделяется вручную
            ok = false;
        }
        setCopied(ok);
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 2500);
    };

    return (
        <div ref={boxRef} className="relative flex items-center">
            <button
                type="button"
                className="cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2.5 py-1.5 text-xs hover:border-lab-accent"
                onClick={() => {
                    setSessions(null);
                    setError('');
                    setOpen(!open);
                }}
                title="Сессия доски: агент и это окно работают в одном слоте; смена переключает слот (вид не меняется)"
            >
                Сессия: <span className="font-mono">{session}</span>
            </button>
            {open && (
                <div className="absolute right-0 top-full z-20 mt-1.5 flex w-72 flex-col gap-2 rounded-md border border-lab-border bg-lab-panel2 p-2.5 shadow-lg">
                    <form
                        className="flex gap-1.5"
                        onSubmit={(e) => {
                            e.preventDefault();
                            openSession(draft);
                        }}
                    >
                        <input
                            autoFocus
                            value={draft}
                            onChange={(e) => {
                                setDraft(e.target.value);
                                setError('');
                            }}
                            placeholder="id сессии: [a-zA-Z0-9_-], 1..64"
                            className="min-w-0 flex-1 rounded border border-lab-border bg-lab-panel px-2 py-1 text-xs outline-none focus:border-lab-accent"
                        />
                        <button
                            type="submit"
                            className="shrink-0 cursor-pointer rounded border border-lab-border bg-lab-panel px-2 py-1 text-xs hover:border-lab-accent"
                        >
                            Открыть/создать
                        </button>
                    </form>
                    {error !== '' && <span className="text-[10px] text-red-300">{error}</span>}
                    <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                        {sessions === null ? (
                            <span className="px-1 py-0.5 text-[10px] text-lab-muted">
                                список недоступен (прод-API не отвечает)
                            </span>
                        ) : sessions.length === 0 ? (
                            <span className="px-1 py-0.5 text-[10px] text-lab-muted">
                                сессий ещё нет
                            </span>
                        ) : (
                            sessions.map((s) => (
                                <button
                                    key={s.id}
                                    type="button"
                                    onClick={() => {
                                        setDraft('');
                                        openSession(s.id);
                                    }}
                                    className={`flex cursor-pointer items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-xs ${
                                        s.id === session
                                            ? 'bg-lab-accent/30 text-white'
                                            : 'hover:bg-lab-panel'
                                    }`}
                                >
                                    <span className="min-w-0 truncate font-mono">{s.id}</span>
                                    <span className="shrink-0 text-[10px] text-lab-muted">
                                        {s.id === session ? 'текущая' : s.name}
                                    </span>
                                </button>
                            ))
                        )}
                    </div>
                    <div className="flex flex-col gap-1 border-t border-lab-border pt-2">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] text-lab-muted">Инструкция агенту</span>
                            <button
                                type="button"
                                onClick={() => void copyBrief()}
                                className="cursor-pointer rounded border border-lab-border bg-lab-panel px-2 py-0.5 text-[10px] hover:border-lab-accent"
                            >
                                {copied ? 'Скопировано ✓' : 'Копировать'}
                            </button>
                        </div>
                        <pre className="max-h-28 overflow-y-auto rounded border border-lab-border bg-lab-panel px-2 py-1.5 font-mono text-[9px] leading-snug whitespace-pre-wrap text-lab-muted">
                            {agentBrief(session)}
                        </pre>
                        <span className="text-[10px] text-lab-muted">
                            Полный контракт — /api/schema и API.md в репо
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
