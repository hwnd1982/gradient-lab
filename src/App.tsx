import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { CodePanel } from './components/CodePanel';
import { HeaderSession } from './components/HeaderSession';
import { Inspector } from './components/Inspector';
import { PresetDrawer } from './components/PresetDrawer';
import { Stage } from './components/Stage';
import { UndoIcon } from './components/icons';
import { agentPost, agentSync, pollState } from './lib/agentTransport';
import { computeAnalysis } from './lib/analysis';
import { pollDelayMs } from './lib/backoff';
import { computeHint } from './lib/hint';
import { getCanvas, getImage } from './lib/imageCache';
import { resolveNumericPath } from './lib/sweepPath';
import { currentSession, setSession } from './lib/session';
import { shouldSendSync } from './lib/syncGate';
import { decodeState, encodeState } from './lib/shareUrl';
import { validateStart } from './lib/validate';
import { BlockStateSchema, SweepReqSchema, defaultBlockState } from './schema';
import { readGradient, targetFromString, targetToKey } from './targets';
import { sameTarget, useLabStore } from './store';
import type { Analysis, BlockState, GradientTarget, SweepPoint, SweepRequest } from './types';

/** Вставка картинки из буфера (Ctrl+V) как референса сравнения. */
function usePasteImage() {
    const update = useLabStore((s) => s.update);

    useEffect(() => {
        const onPaste = (e: ClipboardEvent) => {
            // в текстовых полях paste работает штатно — не перехватываем
            const active = document.activeElement;
            if (
                active instanceof HTMLInputElement ||
                active instanceof HTMLTextAreaElement ||
                (active instanceof HTMLElement && active.isContentEditable)
            ) {
                return;
            }
            const items = e.clipboardData?.items;
            if (!items) return;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item === null || !item.type.startsWith('image/')) continue;
                const file = item.getAsFile();
                if (!file) continue;
                e.preventDefault();
                const reader = new FileReader();
                reader.onload = () => {
                    update((d) => {
                        d.compare.refImage = String(reader.result);
                        if (d.compare.mode === 'off') d.compare.mode = 'opacity';
                    });
                };
                reader.readAsDataURL(file);
                return;
            }
        };
        window.addEventListener('paste', onPaste);
        return () => window.removeEventListener('paste', onPaste);
    }, [update]);
}

/**
 * Синхронизация с Agent API: текущий стейт уходит на сервер (debounce 300ms),
 * входящие агентские PUT-стейты применяются в стор.
 *
 * dev: SSE (/api/events) + POST /api/__sync в кэш сервера; стейт, применённый
 * из SSE (по ссылке), НЕ уходит обратно — браузерное эхо не перетирает поля
 * агентского PUT, юзерские правки поверх — обычный last-writer-wins. dev
 * всегда однопользовательский: сессии нет ('default').
 *
 * прод: вместо SSE — поллинг версий GET /api/state?since=N раз в ~10с (пауза
 * при document.hidden; бэкофф до 60с при квоте/сбоях Upstash — lib/backoff).
 * Эхо закрыто по версиям: свой POST /api/sync запоминает присвоенную сервером
 * версию и поллинг её не возвращает (unchanged), чужую версию применяем и не
 * отсылаем обратно (identity-чек, как в dev); потерянный ответ синка страховён
 * контент-сверкой в applyForeign. Мульти-сессии: все вызовы несут
 * X-Lab-Session (транспорт читает sessionStorage на каждом запросе); смена
 * сессии (session-проп) перезапускает эффект — версии/эхо-строки сбрасываются,
 * поллинг новой сессии стартует немедленно (вид не трогаем). Полный контракт —
 * API.md «Прод (Vercel)» и «Сессии».
 */
function useAgentSync(hashLoadedRef: RefObject<boolean>, session: string) {
    const replace = useLabStore((s) => s.replace);
    const setDevApiAvailable = useLabStore((s) => s.setDevApiAvailable);
    const setAgentNote = useLabStore((s) => s.setAgentNote);
    const setAnalysisTarget = useLabStore((s) => s.setAnalysisTarget);
    // ссылка последнего применённого с сервера стейта: identity-сравнение в подписке
    const justAppliedRef = useRef<BlockState | null>(null);

    useEffect(() => {
        // защита от эха: строка последнего отправленного POST /api/__sync
        let lastSyncJson = '';
        let timer: number | undefined;
        // состояние тоста agentNote — ОБЩЕЕ для прод и dev веток ниже (объявлено
        // до ветвления: в прод-бандле код после веток выпадает как unreachable,
        // объявления внизу не исполняются и ссылки из прод-ветки падали бы TDZ)
        let burstPaths: string[] = [];
        let showTimer: number | undefined;
        let hideTimer: number | undefined;

        if (!import.meta.env.DEV) {
            // ── прод: поллинг версий (транспорт — src/lib/agentTransport.ts) ──
            // версия, которую браузер уже видел (свой синк подтягивает её сразу)
            let lastKnownVersion = 0;
            // ts последнего показанного notify (полл возвращает его всегда —
            // показываем только новее; сообщения не перезапрашиваются)
            let lastSeenNotifyTs = 0;
            // первую выдачу не затираем, если стейт пришёл из share-ссылки
            let firstPoll = true;
            let pollTimer: number | undefined;
            // подряд неудачные тики (429/502/5xx от квоты Upstash, сеть) — бэкофф
            let failures = 0;

            const send = (): void => {
                const state = useLabStore.getState().state;
                const json = JSON.stringify(state);
                // контент не менялся (sweep восстановил исходное) — не шлём
                if (json === lastSyncJson) return;
                lastSyncJson = json;
                void agentSync(state).then((version) => {
                    if (version === null) {
                        // не дошло — эхо-чек по этой строке не валиден
                        lastSyncJson = '';
                        return;
                    }
                    if (version > lastKnownVersion) lastKnownVersion = version;
                });
            };

            const applyForeign = (state: unknown, version: number): void => {
                // своё, вернувшееся с сервера (ответ синка потерян после записи
                // или правка ещё в debounce): контент не трогаем — иначе replace
                // откатил бы несинкнутую юзерскую правку; применяется только версия
                const pollJson = JSON.stringify(state);
                if (
                    pollJson === lastSyncJson ||
                    pollJson === JSON.stringify(useLabStore.getState().state)
                ) {
                    return;
                }
                // sweep исполняется — входящие стейты не применяем; версию при
                // этом adopting сам poll (после applyForeign ставит
                // lastKnownVersion), выдача НЕ переиграется — PUT во время
                // sweep осознанно теряется до финального синка (протокол агента
                // в API.md: до done/aborted не PUT-ить, GET в это время честен —
                // транзиенты на сервер не уходят, см. shouldSendSync)
                if (useLabStore.getState().sweeping) return;
                const parsed = BlockStateSchema.safeParse(state);
                if (!parsed.success) return;
                // ссылка применяемого объекта: подписка по ней не шлёт /api/sync
                justAppliedRef.current = parsed.data;
                lastKnownVersion = version;
                const prevState = useLabStore.getState().state;
                replace(parsed.data, { undoable: false });
                // индикация агентской активности: пачка PUT-ов агрегируется —
                // тост показывается через 1с затишья и гаснет через 2.5с,
                // иначе при активном агенте он «висит» постоянно
                const paths: string[] = [];
                diffPaths(prevState, parsed.data, '', 0, paths);
                if (paths.length > 0) {
                    burstPaths = [...new Set([...burstPaths, ...paths])].slice(-8);
                    window.clearTimeout(showTimer);
                    window.clearTimeout(hideTimer);
                    showTimer = window.setTimeout(() => {
                        const uniq = [...new Set(burstPaths)];
                        const head = uniq.slice(0, 3).join(', ');
                        const more = uniq.length > 3 ? ` +${uniq.length - 3}` : '';
                        setAgentNote(`Агент обновил: ${head}${more}`);
                        burstPaths = [];
                        hideTimer = window.setTimeout(() => setAgentNote(null), 2500);
                    }, 1000);
                }
            };

            const arm = (): void => {
                pollTimer = window.setTimeout(() => void poll(), pollDelayMs(failures));
            };

            const poll = async (): Promise<void> => {
                if (document.hidden) {
                    arm(); // вкладка скрыта — не запрашиваем, ждём visibilitychange
                    return;
                }
                const pollSession = currentSession();
                const res = await pollState(lastKnownVersion);
                // за время запроса сессию переключили — ответ чужого слота
                // целиком игнорируем (не применяем стейт/notify/заявки)
                if (currentSession() !== pollSession) return;
                if (res === null) {
                    failures += 1; // сеть — тоже неудачный тик, бэкоффим
                    arm();
                    return;
                }
                if (res.status === 503) return; // прод-API не настроен — поллинг не поднимаем
                if (res.status === 429 || res.status >= 500) {
                    // квота/сбой Upstash (их 429 приходит к нам как 502) — бэкофф;
                    // при сбросе квоты поллинг сам вернётся к базе
                    failures += 1;
                    arm();
                    return;
                }
                failures = 0; // живой ответ (в т.ч. 404 «стейта ещё нет») — сброс бэкоффа
                if (res.analysisRequest !== undefined) {
                    // агент ждёт анализ таргета (GET /api/analysis?target=...):
                    // вместо SSE-события заявка приезжает поллингом стейта
                    const t = targetFromString(res.analysisRequest);
                    if (t !== null) setAnalysisTarget(t);
                }
                if (res.sweepRequest !== undefined) {
                    // заявка на авто-перебор (POST /api/sweep): исполняет
                    // useSweepSync; повторные доставки того же id — no-op в сторе
                    useLabStore.getState().requestSweep(res.sweepRequest);
                }
                if (res.notify !== undefined && res.notify.ts > lastSeenNotifyTs) {
                    // сообщение агента (POST /api/notify): тост тем же механизмом
                    // agentNote (префикс «Агент:»); повторные доставки того же
                    // ts молча пропускаются
                    lastSeenNotifyTs = res.notify.ts;
                    window.clearTimeout(showTimer);
                    window.clearTimeout(hideTimer);
                    setAgentNote(`Агент: ${res.notify.text}`);
                    hideTimer = window.setTimeout(() => setAgentNote(null), 4000);
                }
                if (res.version !== undefined && res.version > lastKnownVersion) {
                    if (res.state !== undefined && !res.unchanged) {
                        if (firstPoll && hashLoadedRef.current) {
                            // стейт из share-ссылки свежее — выдачу пропускаем,
                            // версию adopting, чтобы поллинг не привозил её снова
                            hashLoadedRef.current = false;
                        } else {
                            applyForeign(res.state, res.version);
                        }
                        firstPoll = false;
                    }
                    lastKnownVersion = res.version;
                }
                arm();
            };

            const onVisibility = (): void => {
                if (!document.hidden) {
                    window.clearTimeout(pollTimer);
                    void poll(); // проснулись — сразу, не ждём таймера
                }
            };
            document.addEventListener('visibilitychange', onVisibility);

            const unsubscribe = useLabStore.subscribe((s, prev) => {
                // транзиентные sweep-значения не синкаются (команды/версии не
                // тратятся, GET во время sweep отдаёт исходный стейт); конец
                // sweep — досылаем финальный контент (см. syncGate.ts)
                if (!shouldSendSync(s, prev)) return;
                if (s.state === justAppliedRef.current) return;
                window.clearTimeout(timer);
                timer = window.setTimeout(send, 300);
            });
            void poll();

            return () => {
                document.removeEventListener('visibilitychange', onVisibility);
                unsubscribe();
                window.clearTimeout(timer);
                window.clearTimeout(pollTimer);
            };
        }

        // ── dev: как раньше — middleware + SSE ──
        const unsubscribe = useLabStore.subscribe((s, prev) => {
            // транзиентные sweep-значения не синкаются; конец sweep — досылка
            // финального контента (восстановленный радиус / правка юзера)
            if (!shouldSendSync(s, prev)) return;
            // стейт просто применён из SSE-события агентского PUT — эхо не шлём:
            // сервер уже знает этот стейт, а гонка echo/PUT портила поля;
            // юзерские правки ПОВЕРХ применённого — новый объект, синкается как обычно
            if (s.state === justAppliedRef.current) return;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                const json = JSON.stringify(useLabStore.getState().state);
                // контент не менялся (sweep восстановил исходное) — не шлём
                if (json === lastSyncJson) return;
                lastSyncJson = json;
                fetch('/api/__sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: json,
                }).catch(() => {
                    // dev-сервер недоступен/перезапущен — просто пропускаем тик
                });
            }, 300);
        });

        // burstPaths/showTimer/hideTimer объявлены в общей области эффекта выше
        let es: EventSource | null = null;
        // стейт из share-ссылки уже применён — первое SSE-событие после
        // подключения (initial-кэш сервера) не должно его затирать;
        // флаг сбрасывается после пропуска, дальше PUT-ы применяются штатно
        let skipInitialEvent = false;
        const openEvents = () => {
            skipInitialEvent = hashLoadedRef.current;
            es = new EventSource('/api/events');
            es.onmessage = (ev: MessageEvent<string>) => {
                let msg: {
                    type?: string;
                    state?: unknown;
                    target?: unknown;
                    id?: unknown;
                    req?: unknown;
                    text?: unknown;
                };
                try {
                    msg = JSON.parse(ev.data);
                } catch {
                    return;
                }
                // агент запросил анализ конкретного таргета (GET /api/analysis?target=...)
                if (msg.type === 'analysis-request') {
                    if (typeof msg.target === 'string') {
                        const t = targetFromString(msg.target);
                        if (t !== null) setAnalysisTarget(t);
                    }
                    return;
                }
                // заявка на авто-перебор (POST /api/sweep): исполняет useSweepSync
                if (msg.type === 'sweep-request') {
                    if (
                        typeof msg.id === 'string' &&
                        typeof msg.req === 'object' &&
                        msg.req !== null
                    ) {
                        const parsed = SweepReqSchema.safeParse(msg.req);
                        if (parsed.success) {
                            useLabStore.getState().requestSweep({ id: msg.id, req: parsed.data });
                        }
                    }
                    return;
                }
                // сообщение агента юзеру (POST /api/notify): тост напрямую,
                // хранить не нужно (dev — одно окно, доставлено мгновенно)
                if (msg.type === 'notify') {
                    if (typeof msg.text === 'string' && msg.text !== '') {
                        window.clearTimeout(showTimer);
                        window.clearTimeout(hideTimer);
                        setAgentNote(`Агент: ${msg.text}`);
                        hideTimer = window.setTimeout(() => setAgentNote(null), 4000);
                    }
                    return;
                }
                // агент очистил журнал (DELETE /api/journal) — локальное зеркало
                // тоже чистим, иначе hint «плато радиуса» видит удалённые записи
                if (msg.type === 'journal-cleared') {
                    useLabStore.getState().clearJournal();
                    return;
                }
                if (msg.type !== 'state' || msg.state === undefined) return;
                // sweep исполняется — входящие стейты не применяем до завершения
                // (PUT до done/aborted sweep — нарушение протокола агента, API.md)
                if (useLabStore.getState().sweeping) return;
                if (skipInitialEvent) {
                    skipInitialEvent = false;
                    hashLoadedRef.current = false;
                    return;
                }
                // пропускаем собственное эхо (последний отправленный стейт)
                if (JSON.stringify(msg.state) === lastSyncJson) return;
                const parsed = BlockStateSchema.safeParse(msg.state);
                if (!parsed.success) return;
                // ссылка применяемого объекта: subscribe-хук по ней не шлёт /api/__sync
                justAppliedRef.current = parsed.data;
                replace(parsed.data, { undoable: false });
            };
        };

        // защита от гонки probe/cleanup (StrictMode-двойной маунт в dev):
        // если эффект уже размонтирован — EventSource не открываем
        let cancelled = false;

        // probe: если dev-API жив — поднимаем SSE и открываем файловые пресеты
        fetch('/api/presets')
            .then((r) => {
                if (!r.ok) throw new Error('agent api ответил не ok');
                if (cancelled) return;
                setDevApiAvailable(true);
                openEvents();
            })
            .catch(() => {
                // static-хостинг или плагин выключен — живём без API
            });

        return () => {
            cancelled = true;
            unsubscribe();
            window.clearTimeout(timer);
            window.clearTimeout(showTimer);
            window.clearTimeout(hideTimer);
            es?.close();
        };
    }, [replace, setDevApiAvailable, setAnalysisTarget, hashLoadedRef, session]);
}

/** Изменённые пути dot-notation: глубина ≤ 3 сегментов, значения не собираем. */
function diffPaths(
    prev: unknown,
    next: unknown,
    prefix: string,
    depth: number,
    out: string[]
): void {
    if (Object.is(prev, next)) return;
    const walkable = (v: unknown): boolean => v !== null && typeof v === 'object';
    if (depth >= 3 || !walkable(prev) || !walkable(next)) {
        out.push(prefix);
        return;
    }
    const keys = new Set([...Object.keys(prev as object), ...Object.keys(next as object)]);
    for (const key of keys) {
        const p = prefix === '' ? key : `${prefix}.${key}`;
        const a = (prev as Record<string, unknown>)[key];
        const b = (next as Record<string, unknown>)[key];
        if (!Object.is(a, b)) {
            diffPaths(a, b, p, depth + 1, out);
        }
    }
}

/** Метрики анализа для записи журнала. */
function journalMetrics(a: Analysis | null): {
    zoneMatch: number;
    maxErr: number;
    verdict: string;
} | null {
    if (a === null) return null;
    return { zoneMatch: a.zoneMatchPercent, maxErr: a.maxError, verdict: a.verdict };
}

/**
 * Журнал итераций (GET /api/journal): на каждое устоявшееся изменение стейта
 * (debounce ~700ms, поля объединяются) пишет запись — ts, изменённые пути
 * (dot-notation, ≤ 20) и метрики анализа «до»; когда следующий анализ
 * посчитан — дозаполняет `after` вторым сообщением. Агент читает журнал,
 * чтобы откатиться к удачной итерации. В dev пишет middleware-эндпоинт
 * /api/__journal, на проде — /api/journal (транспорт agentTransport).
 */
function useJournalSync() {
    useEffect(() => {
        let timer: number | undefined;
        // накопленные с последнего flush пути + метрики анализа «до» правки
        let fields: string[] = [];
        let before: ReturnType<typeof journalMetrics> = null;
        let beforeAnalysisAt: number | null = null;
        // id записи, ждущей after; flushInFlight/afterCandidate — гонка «анализ
        // (500ms) прилетает раньше журнального flush (700ms)»: тогда after
        // запоминается и дозаполняется сразу после получения id
        let pendingId: number | null = null;
        let flushInFlight = false;
        let afterCandidate: ReturnType<typeof journalMetrics> = null;

        const post = (body: unknown): void => {
            // сеть недоступна — тихо пропускаем (журнал не критичен)
            void agentPost('journal', body);
        };

        const finish = (
            id: number,
            after: NonNullable<ReturnType<typeof journalMetrics>>
        ): void => {
            // зеркало хвоста журнала в стор — источник фактов для computeHint
            useLabStore.getState().completeJournalEntry(id, after);
            post({ id, after });
        };

        const flush = (): void => {
            if (fields.length === 0) return;
            const body = {
                ts: Date.now(),
                fields: fields.slice(0, 20),
                ...(before !== null ? { before } : {}),
            };
            fields = [];
            flushInFlight = true;
            agentPost('journal', body)
                .then((r) => (r !== null && r.ok ? r.json() : null))
                .then((j: { id?: unknown } | null) => {
                    if (j === null || typeof j.id !== 'number') return;
                    // серверный журнал очищен (DELETE агентом / рестарт dev) —
                    // id пошли заново: локальное зеркало сбрасываем, чтобы hint
                    // не детектил «плато» по удалённым записям (в dev то же
                    // приходит мгновенно SSE-событием journal-cleared)
                    const mirror = useLabStore.getState().journalEntries;
                    if (mirror.length > 0 && j.id <= mirror[mirror.length - 1].id) {
                        useLabStore.getState().clearJournal();
                    }
                    useLabStore.getState().pushJournalEntry({
                        id: j.id,
                        ts: body.ts,
                        fields: body.fields,
                        before: body.before ?? null,
                        after: null,
                    });
                    // анализ уже успел посчитаться после правки — дозаполняем сразу
                    if (afterCandidate !== null) {
                        finish(j.id, afterCandidate);
                        afterCandidate = null;
                        return;
                    }
                    pendingId = j.id;
                })
                .catch(() => {
                    // dev-сервер недоступен — журнал не критичен
                })
                .finally(() => {
                    flushInFlight = false;
                });
        };

        const unsubscribe = useLabStore.subscribe((s, prev) => {
            if (s.state === prev.state) return;
            // транзиентные sweep-значения в журнал не пишем: это не итерации
            // подбора, а авто-перебор одной ручки (результат — в /api/sweep)
            if (s.sweeping) return;
            // «до» берём синхронно: анализ в этот момент ещё не пересчитан
            const paths: string[] = [];
            diffPaths(prev.state, s.state, '', 0, paths);
            if (paths.length > 0) {
                fields = fields.length === 0 ? paths : [...new Set([...fields, ...paths])];
                const a = s.analysis;
                before = journalMetrics(a);
                beforeAnalysisAt = a?.updatedAt ?? null;
            }
            window.clearTimeout(timer);
            timer = window.setTimeout(flush, 700);
        });

        const unsubscribeAnalysis = useLabStore.subscribe((s, prev) => {
            if (s.analysis === prev.analysis) return;
            // метрики транзиентных sweep-точек не дозаполняют after чужих записей
            if (s.sweeping) return;
            if (s.analysis === null || s.analysis.updatedAt === beforeAnalysisAt) return;
            const metrics = journalMetrics(s.analysis);
            if (metrics === null) return;
            if (pendingId !== null) {
                finish(pendingId, metrics);
                pendingId = null;
                return;
            }
            // запись ещё не ушла (или ждёт id) — запоминаем after для неё
            if (flushInFlight || fields.length > 0) afterCandidate = metrics;
        });

        return () => {
            unsubscribe();
            unsubscribeAnalysis();
            window.clearTimeout(timer);
        };
    }, []);
}

/**
 * Diff-анализ против референса: пересчёт с debounce ~500ms при изменении стейта,
 * активного таргета, режим профиля или агентского override (профиль считается
 * по его оси; при columns ступени/стопы — по P60 яркости колонок, при rays —
 * медиана 16 лучей radial-таргета). Результат кладётся в стор (панель «Анализ»
 * + heat-оверлей); ещё уходит на сервер через POST /api/analysis (транспорт;
 * в dev — /api/__analysis) — агент читает его как GET /api/analysis.
 */
function useAnalysisSync() {
    const setAnalysis = useLabStore((s) => s.setAnalysis);
    const setAnalysisMarker = useLabStore((s) => s.setAnalysisMarker);

    useEffect(() => {
        let timer: number | undefined;

        // анализ недоступен (нет референса / не загрузился) — чистим локальный
        // результат И кэш сервера; шлём cleared всегда, а не только при живом
        // st.analysis, иначе после reload сервер отдаёт устаревший анализ
        const clearAnalysis = () => {
            setAnalysis(null);
            setAnalysisMarker(null);
            void agentPost('analysis', { cleared: true });
        };

        // маркер вместо анализа: сервер кэширует, GET /api/analysis?target=
        // отдаёт 200 с маркером — агент не поллит вечный 404
        const postMarker = (
            body:
                | {
                      target: string;
                      gradientMissing: true;
                  }
                | {
                      target: string;
                      blocked: 'no-reference';
                  }
        ) => {
            void agentPost('analysis', body);
        };

        const run = async () => {
            const st = useLabStore.getState();
            const target = st.analysisTarget ?? st.activeTarget;
            if (st.state.compare.refImage === null) {
                // референса нет: агентский запрос таргета закрываем маркером
                // blocked — агент отличает «нет референса» от «вкладка закрыта»
                if (st.analysisTarget !== null) {
                    setAnalysis(null);
                    setAnalysisMarker(null);
                    postMarker({ target: targetToKey(st.analysisTarget), blocked: 'no-reference' });
                    return;
                }
                clearAnalysis();
                return;
            }
            if (readGradient(st.state, target) === null) {
                // у таргета нет градиента (слой за диапазоном, blurMask без
                // маски, плоский цвет у blurBg/underlay) — честный маркер
                // вместо фиктивного анализа по оси чужого градиента
                setAnalysis(null);
                setAnalysisMarker('gradientMissing');
                postMarker({ target: targetToKey(target), gradientMissing: true });
                return;
            }
            try {
                const refCanvas = await getCanvas(st.state.compare.refImage);
                const { data, diff } = await computeAnalysis(st.state, target, refCanvas, {
                    profile: st.analysisProfile,
                });
                // стейт, таргет или режим успели измениться за время загрузки —
                // результат устарел, новый тик уже взведён изменением
                const now = useLabStore.getState();
                if (
                    now.state !== st.state ||
                    now.activeTarget !== st.activeTarget ||
                    now.analysisTarget !== st.analysisTarget ||
                    now.analysisProfile !== st.analysisProfile
                ) {
                    return;
                }
                // «движение к точке» (методика v2): подсказка перехода фазы по
                // фактам анализа + хвоста журнала — уходит и в UI, и агенту;
                // контекст редактора резолвит журнальные α-стопы (префиксы
                // семейств) в конкретный stops[i].alpha выбранного стопа
                const withHint: Analysis = {
                    ...data,
                    hint: computeHint(data, now.journalEntries, {
                        state: now.state,
                        target: now.activeTarget,
                        selectedStopId: now.selectedStopId,
                    }),
                };
                setAnalysis(withHint, diff);
                void agentPost('analysis', withHint);
            } catch {
                // референс не загрузился — анализ недоступен
                clearAnalysis();
            }
        };

        const unsubscribe = useLabStore.subscribe((s, prev) => {
            if (
                s.state === prev.state &&
                s.activeTarget === prev.activeTarget &&
                s.analysisTarget === prev.analysisTarget &&
                s.analysisProfile === prev.analysisProfile
            ) {
                return;
            }
            window.clearTimeout(timer);
            timer = window.setTimeout(() => void run(), 500);
        });
        // стартовый расчёт: стейт мог прийти из share-ссылки/кэша до подписки
        timer = window.setTimeout(() => void run(), 500);

        return () => {
            unsubscribe();
            window.clearTimeout(timer);
        };
    }, [setAnalysis, setAnalysisMarker]);
}

/** linspace: от from до to включительно, steps точек. */
function linspace(from: number, to: number, steps: number): number[] {
    if (steps <= 1 || from === to) return [from];
    const out: number[] = [];
    for (let i = 0; i < steps; i++) {
        out.push(from + ((to - from) * i) / (steps - 1));
    }
    return out;
}

/** Исход ожидания анализа внутри sweep: метрика / чужое вмешательство / таймаут. */
type SweepWait =
    { kind: 'analysis'; analysis: Analysis } | { kind: 'foreign' } | { kind: 'timeout' };

/**
 * Исполнение заявки авто-перебора (POST /api/sweep → SSE sweep-request в dev /
 * поле sweepRequest полла в прод → стор → этот хук): для каждого значения из
 * linspace(from, to, steps) — транзиентное применение значения поля пути
 * (applyNumericPath: радиус/угол/альфа стопа/прозрачность слоя; без истории и
 * записей журнала, applySweepValue), ожидание пересчитанного анализа (~600ms
 * debounce + расчёт), снятие {value, zoneMatchPercent, maxError}; в конце
 * исходное значение поля восстанавливается (тем же applyNumericPath) и
 * результат уходит POST /api/__sweep. Путь существует в текущем стейте —
 * проверяет resolveNumericPath на старте: отсутствующий (нет градиента,
 * индекс за диапазоном) → aborted без единой точки. Чужое изменение
 * стейта/таргета (юзер вмешался — сравнение по ссылкам, как в анализе) = abort
 * БЕЗ восстановления (не затираем чужую правку); таймаут точки (10 с) —
 * state гарантированно наш, исходное значение восстанавливается и abort
 * уходит с причиной. Результат всё равно отдаётся (частичный + причина).
 * Агент поллит GET /api/sweep?id=... Журнал, warnings и
 * входящие/исходящие синки во время sweep молчат (флаг sweeping, syncGate).
 * Вторая заявка во время активного sweep отклоняется сразу (POST aborted) —
 * агент не зависает в pending.
 */
function useSweepSync() {
    useEffect(() => {
        let disposed = false;
        // последняя разобранная заявка: повторные доставки полла — не рестарт
        let lastId: string | null = null;

        const waitForAnalysis = (
            afterTs: number,
            ours: BlockState,
            target0: GradientTarget
        ): Promise<SweepWait> =>
            new Promise((resolve) => {
                const started = Date.now();
                const tick = (): void => {
                    if (disposed) {
                        resolve({ kind: 'timeout' });
                        return;
                    }
                    const st = useLabStore.getState();
                    if (st.state !== ours) {
                        resolve({ kind: 'foreign' });
                        return;
                    }
                    // юзер переключил таргет анализа — метрики будут чужие
                    if (!sameTarget(st.analysisTarget ?? st.activeTarget, target0)) {
                        resolve({ kind: 'foreign' });
                        return;
                    }
                    const a = st.analysis;
                    if (a !== null && a.updatedAt > afterTs) {
                        resolve({ kind: 'analysis', analysis: a });
                        return;
                    }
                    if (Date.now() - started > 10_000) {
                        resolve({ kind: 'timeout' });
                        return;
                    }
                    window.setTimeout(tick, 120);
                };
                tick();
            });

        const run = async (request: SweepRequest): Promise<void> => {
            const { id, req } = request;
            const store = useLabStore.getState();
            const original = resolveNumericPath(store.state, req.field);
            const target0 = store.analysisTarget ?? store.activeTarget;
            store.setSweeping(true);
            const results: SweepPoint[] = [];
            let aborted: string | null = null;
            let ours: BlockState | null = null;
            try {
                if (original === null) {
                    // формат поля валиден (схема POST), но в текущем стейте пути
                    // нет — градиент не задан/индекс за диапазоном/не числовой лист
                    aborted = `поле "${req.field}" не найдено в текущем стейте (или не числовой лист) — проверь путь по GET /api/state`;
                } else {
                    for (const value of linspace(req.from, req.to, req.steps)) {
                        useLabStore.getState().applySweepValue(req.field, value);
                        ours = useLabStore.getState().state;
                        const wait = await waitForAnalysis(Date.now(), ours, target0);
                        if (wait.kind === 'foreign') {
                            aborted = `state/таргет изменён вне sweep (юзер/агент) на value=${value}; исходное значение не восстановлено`;
                            break;
                        }
                        if (wait.kind === 'timeout') {
                            // state гарантированно наш (чужой шаг wait-цикл
                            // разрешает как foreign) и смениться до этого
                            // синхронного участка не мог — восстанавливаем
                            // исходное значение, иначе поле останется с
                            // последним переборным значением транзиентно (Ctrl+Z
                            // его не вернёт) и уйдёт финальным синком как канон
                            useLabStore.getState().applySweepValue(req.field, original);
                            aborted =
                                'анализ не пересчитался за 10 с (нет референса?); исходное значение восстановлено';
                            break;
                        }
                        results.push({
                            value: Math.round(value * 10) / 10,
                            zoneMatchPercent: wait.analysis.zoneMatchPercent,
                            maxError: wait.analysis.maxError,
                        });
                    }
                    if (aborted === null && ours !== null) {
                        // окно между последним анализом и восстановлением тоже проверяем
                        if (useLabStore.getState().state !== ours) {
                            aborted =
                                'state изменён вне sweep после последней точки; исходное значение не восстановлено';
                        } else {
                            useLabStore.getState().applySweepValue(req.field, original);
                        }
                    }
                }
            } finally {
                useLabStore.getState().setSweeping(false);
                useLabStore.getState().setSweepRequest(null);
            }
            if (aborted !== null) {
                console.warn('gradient-lab: sweep aborted:', aborted);
            }
            // частичные точки при abort тоже полезны агенту (коридор видно)
            const body =
                aborted === null
                    ? { id, results }
                    : results.length > 0
                      ? { id, results, aborted }
                      : { id, aborted };
            void agentPost('sweepResult', body);
        };

        const unsubscribe = useLabStore.subscribe((s, prev) => {
            if (s.sweepRequest === prev.sweepRequest) return;
            const r = s.sweepRequest;
            if (r === null || r.id === lastId) return;
            lastId = r.id;
            // вторая заявка во время активного sweep: отклоняем сразу — иначе
            // агент висит в pending (dev-заявка не повторяется как прод-полл)
            if (useLabStore.getState().sweeping) {
                console.warn('gradient-lab: sweep уже идёт, заявка отклонена:', r.id);
                void agentPost('sweepResult', {
                    id: r.id,
                    aborted: 'sweep уже выполняется (одна заявка за раз), повторите позже',
                });
                return;
            }
            void run(r);
        });

        return () => {
            disposed = true;
            unsubscribe();
        };
    }, []);
}

/**
 * Борт-контроль старта: предупреждения пересчитываются с debounce ~400ms при
 * изменении стейта/анализа/таргета (аспекты картинок подтягиваются асинхронно —
 * null, пока не загрузились, пересчёт по событию загрузки). Результат — в стор
 * (янтарная плашка над стейджем) и на сервере: POST /api/warnings →
 * GET /api/warnings (транспорт; в dev — /api/__warnings). Пустой список шлём
 * как cleared — сервер не отдаёт старьё.
 */
function useWarningsSync() {
    const setWarnings = useLabStore((s) => s.setWarnings);

    useEffect(() => {
        let timer: number | undefined;
        // после unmount таймеры не взводим: аспекты грузятся асинхронно и их
        // .then может прийти позже cleanup — schedule без флага поднял бы
        // таймер вне жизни эффекта
        let disposed = false;
        // аспекты по dataURL с кэшем; srcs хранит, для какого источника посчитан аспект
        const aspects: { base: number | null; ref: number | null } = { base: null, ref: null };
        const srcs: { base: string | null; ref: string | null } = { base: null, ref: null };

        const loadAspect = (key: 'base' | 'ref', src: string | null) => {
            if (src === null) {
                srcs[key] = null;
                aspects[key] = null;
                return;
            }
            if (srcs[key] === src) return;
            srcs[key] = src;
            aspects[key] = null; // грузится — не блокируем расчёт, посчитаем с null
            getImage(src)
                .then((img) => {
                    if (srcs[key] !== src) return;
                    if (img.naturalWidth === 0 || img.naturalHeight === 0) return;
                    const aspect = img.naturalWidth / img.naturalHeight;
                    if (aspects[key] === aspect) return;
                    aspects[key] = aspect;
                    schedule(); // пересчёт по событию загрузки
                })
                .catch(() => {
                    // не загрузилась — предупреждений по аспектам не будет
                });
        };

        const run = () => {
            const st = useLabStore.getState();
            loadAspect('base', st.state.base.kind === 'image' ? st.state.base.image : null);
            loadAspect('ref', st.state.compare.refImage);
            const warnings = validateStart(
                st.state,
                st.analysis,
                { base: aspects.base, ref: aspects.ref },
                st.activeTarget
            );
            // стейт успел измениться за время расчёта — результат устарел
            if (useLabStore.getState().state !== st.state) return;
            setWarnings(warnings);
            void agentPost('warnings', warnings.length > 0 ? { warnings } : { cleared: true });
        };

        const schedule = () => {
            if (disposed) return;
            window.clearTimeout(timer);
            timer = window.setTimeout(run, 400);
        };

        const unsubscribe = useLabStore.subscribe((s, prev) => {
            if (
                s.state === prev.state &&
                s.analysis === prev.analysis &&
                s.activeTarget === prev.activeTarget &&
                s.sweeping === prev.sweeping
            ) {
                return;
            }
            // транзиентные sweep-значения не пересчитываем (шум вроде
            // blur-zero-radius при проходе через 0); конец sweep (sweeping →
            // false) пересчитывает на финальном — восстановленном — стейте
            if (s.sweeping) return;
            schedule();
        });
        schedule();

        return () => {
            disposed = true;
            unsubscribe();
            window.clearTimeout(timer);
        };
    }, [setWarnings]);
}

/** Глобальные шорткаты: Ctrl+Z — undo, Delete/Backspace — удалить выбранный стоп. */
function useShortcuts() {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const active = document.activeElement;
            const inField =
                active instanceof HTMLInputElement ||
                active instanceof HTMLTextAreaElement ||
                active instanceof HTMLSelectElement ||
                (active instanceof HTMLElement && active.isContentEditable);

            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
                if (inField) return; // штатный undo поля ввода
                e.preventDefault();
                useLabStore.getState().undo();
                return;
            }

            if ((e.key === 'Delete' || e.key === 'Backspace') && !inField) {
                const { selectedStopId, activeTarget, state, update, setSelectedStop } =
                    useLabStore.getState();
                const gradient = readGradient(state, activeTarget);
                if (
                    !selectedStopId ||
                    !gradient ||
                    gradient.stops.length < 3 ||
                    !gradient.stops.some((s) => s.id === selectedStopId)
                ) {
                    return;
                }
                e.preventDefault();
                update((d) => {
                    const g = readGradient(d, activeTarget);
                    if (g) g.stops = g.stops.filter((s) => s.id !== selectedStopId);
                });
                setSelectedStop(null);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
}

/** Разовая загрузка стейта из location.hash (#s=...). */
function useHashState(hashLoadedRef: RefObject<boolean>) {
    const replace = useLabStore((s) => s.replace);
    useEffect(() => {
        if (!window.location.hash.startsWith('#s=')) return;
        const state = decodeState(window.location.hash.slice(3));
        if (state !== null) {
            replace(state, { undoable: false });
            // блок из ссылки всегда красиво вписан — вид в Fit
            useLabStore.getState().zoomFit();
            hashLoadedRef.current = true;
        } else {
            console.warn('gradient-lab: не удалось разобрать стейт из ссылки');
        }
    }, [replace, hashLoadedRef]);
}

export default function App() {
    const [codeOpen, setCodeOpen] = useState(false);
    const [presetsOpen, setPresetsOpen] = useState(false);
    const [shareNote, setShareNote] = useState('');
    // сессия прода (sessionStorage + ?join при загрузке): селектор хедера меняет
    // её на лету — useAgentSync перезапускается с чистыми версиями. В dev всегда
    // 'default' (селектор не монтируется).
    const [session, setSessionState] = useState(currentSession);
    const shareTimer = useRef<number | null>(null);
    const canUndo = useLabStore((s) => s.past.length > 0);
    const agentNote = useLabStore((s) => s.agentNote);
    // флаг «стейт загружен из share-ссылки»: sync-хук по нему пропускает
    // первое SSE-событие (initial-кэш), чтобы не затирать стейт из ссылки
    const hashLoadedRef = useRef(false);
    usePasteImage();
    useAgentSync(hashLoadedRef, session);
    useJournalSync();
    useAnalysisSync();
    useSweepSync();
    useWarningsSync();
    useShortcuts();
    useHashState(hashLoadedRef);

    useEffect(() => {
        return () => {
            if (shareTimer.current !== null) window.clearTimeout(shareTimer.current);
        };
    }, []);

    const onShare = async () => {
        const encoded = encodeState(useLabStore.getState().state);
        window.location.hash = `s=${encoded}`;
        const huge = encoded.length > 100_000;
        let note = huge ? 'Ссылка огромная — лучше экспорт в файл' : 'Скопировано ✓';
        try {
            await navigator.clipboard.writeText(window.location.href);
        } catch {
            note = huge ? 'Ссылка огромная — лучше экспорт в файл' : 'Не удалось скопировать';
        }
        // ссылка уже в буфере — чистим hash, чтобы reload не откатывал стейт
        // к моменту шэра (без записи в history)
        history.replaceState(null, '', window.location.pathname + window.location.search);
        setShareNote(note);
        if (shareTimer.current !== null) window.clearTimeout(shareTimer.current);
        shareTimer.current = window.setTimeout(() => setShareNote(''), 2500);
    };

    return (
        <div className="flex h-full flex-col">
            <header className="flex h-12 shrink-0 items-center gap-3 border-b border-lab-border bg-lab-panel px-4">
                <span className="text-sm font-semibold">Gradient Lab</span>
                <span className="hidden text-xs text-lab-muted md:inline">
                    песочница градиентов и масок
                </span>
                <div className="ml-auto flex items-center gap-2">
                    {!import.meta.env.DEV && (
                        <HeaderSession
                            session={session}
                            onSwitch={(id) => {
                                setSession(id);
                                setSessionState(id);
                                // hash-скип одноразовый: стейт из #s= НЕ должен
                                // глотать первый полл новой сессии (иначе под
                                // шильдиком новой сессии остаётся доска старой)
                                hashLoadedRef.current = false;
                            }}
                        />
                    )}
                    {shareNote !== '' && (
                        <span className="text-[10px] whitespace-nowrap text-lab-muted">
                            {shareNote}
                        </span>
                    )}
                    <button
                        type="button"
                        className="cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2.5 py-1.5 text-xs hover:border-lab-accent"
                        onClick={() =>
                            useLabStore.getState().replace(defaultBlockState(), { undoable: true })
                        }
                        title="Сбросить холст к дефолтному блоку (Ctrl+Z вернёт)"
                    >
                        Сброс
                    </button>
                    <button
                        type="button"
                        className="flex cursor-pointer items-center gap-1.5 rounded-md border border-lab-border bg-lab-panel2 px-2.5 py-1.5 text-xs hover:border-lab-accent disabled:cursor-default disabled:opacity-40"
                        disabled={!canUndo}
                        onClick={() => useLabStore.getState().undo()}
                        title="Отменить последнее действие (Ctrl+Z)"
                    >
                        <UndoIcon />
                        Отменить
                    </button>
                    <button
                        type="button"
                        className={`cursor-pointer rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                            presetsOpen
                                ? 'border-transparent bg-lab-accent text-white'
                                : 'border-lab-border bg-lab-panel2 hover:border-lab-accent'
                        }`}
                        onClick={() => setPresetsOpen(!presetsOpen)}
                    >
                        Пресеты
                    </button>
                    <button
                        type="button"
                        className="cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2.5 py-1.5 text-xs hover:border-lab-accent"
                        onClick={() => void onShare()}
                        title="Скопировать ссылку на текущее состояние"
                    >
                        Поделиться
                    </button>
                    <button
                        type="button"
                        className={`cursor-pointer rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                            codeOpen
                                ? 'border-transparent bg-lab-accent text-white'
                                : 'border-lab-border bg-lab-panel2 hover:border-lab-accent'
                        }`}
                        onClick={() => setCodeOpen(!codeOpen)}
                    >
                        CSS
                    </button>
                </div>
            </header>
            {agentNote !== null && (
                <div className="pointer-events-none fixed bottom-10 left-1/2 z-[70] -translate-x-1/2 rounded-md border border-lab-accent/60 bg-lab-panel/95 px-3 py-1.5 text-xs shadow-lg">
                    {agentNote}
                </div>
            )}
            <div className="relative flex min-h-0 min-w-0 flex-1">
                <Stage />
                <Inspector />
                {presetsOpen && <PresetDrawer onClose={() => setPresetsOpen(false)} />}
            </div>
            {codeOpen && <CodePanel />}
            <footer className="flex h-7 shrink-0 items-center overflow-hidden border-t border-lab-border bg-lab-panel px-4 text-[10px] text-lab-muted">
                <span className="truncate">
                    Ctrl+Z — отмена · Delete — удалить стоп · \ — A/B референса · Ctrl+колесо — зум
                    · тяни пустое место — пан · Space/СКМ — пан · Alt+тяни — блок/фон стейджа
                </span>
            </footer>
        </div>
    );
}
