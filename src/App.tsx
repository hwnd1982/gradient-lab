import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { CodePanel } from './components/CodePanel';
import { Inspector } from './components/Inspector';
import { PresetDrawer } from './components/PresetDrawer';
import { Stage } from './components/Stage';
import { UndoIcon } from './components/icons';
import { agentPost, agentSync, pollState } from './lib/agentTransport';
import { computeAnalysis } from './lib/analysis';
import { pollDelayMs } from './lib/backoff';
import { getCanvas, getImage } from './lib/imageCache';
import { decodeState, encodeState } from './lib/shareUrl';
import { validateStart } from './lib/validate';
import { BlockStateSchema, defaultBlockState } from './schema';
import { readGradient, targetFromString, targetToKey } from './targets';
import { useLabStore } from './store';
import type { Analysis, BlockState } from './types';

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
 * агентского PUT, юзерские правки поверх — обычный last-writer-wins.
 *
 * прод: вместо SSE — поллинг версий GET /api/state?since=N раз в ~10с (пауза
 * при document.hidden; бэкофф до 60с при квоте/сбоях Upstash — lib/backoff).
 * Эхо закрыто по версиям: свой POST /api/sync запоминает присвоенную сервером
 * версию и поллинг её не возвращает (unchanged), чужую версию применяем и не
 * отсылаем обратно (identity-чек, как в dev); потерянный ответ синка страховён
 * контент-сверкой в applyForeign. Полный контракт — API.md «Прод (Vercel)».
 */
function useAgentSync(hashLoadedRef: RefObject<boolean>) {
    const replace = useLabStore((s) => s.replace);
    const setDevApiAvailable = useLabStore((s) => s.setDevApiAvailable);
    const setAnalysisTarget = useLabStore((s) => s.setAnalysisTarget);
    // ссылка последнего применённого с сервера стейта: identity-сравнение в подписке
    const justAppliedRef = useRef<BlockState | null>(null);

    useEffect(() => {
        // защита от эха: строка последнего отправленного POST /api/__sync
        let lastSyncJson = '';
        let timer: number | undefined;

        if (!import.meta.env.DEV) {
            // ── прод: поллинг версий (транспорт — src/lib/agentTransport.ts) ──
            // версия, которую браузер уже видел (свой синк подтягивает её сразу)
            let lastKnownVersion = 0;
            // первую выдачу не затираем, если стейт пришёл из share-ссылки
            let firstPoll = true;
            let pollTimer: number | undefined;
            // подряд неудачные тики (429/502/5xx от квоты Upstash, сеть) — бэкофф
            let failures = 0;

            const send = (): void => {
                const state = useLabStore.getState().state;
                lastSyncJson = JSON.stringify(state);
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
                const parsed = BlockStateSchema.safeParse(state);
                if (!parsed.success) return;
                // ссылка применяемого объекта: подписка по ней не шлёт /api/sync
                justAppliedRef.current = parsed.data;
                lastKnownVersion = version;
                replace(parsed.data, { undoable: false });
            };

            const arm = (): void => {
                pollTimer = window.setTimeout(() => void poll(), pollDelayMs(failures));
            };

            const poll = async (): Promise<void> => {
                if (document.hidden) {
                    arm(); // вкладка скрыта — не запрашиваем, ждём visibilitychange
                    return;
                }
                const res = await pollState(lastKnownVersion);
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
                if (s.state === prev.state) return;
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
            if (s.state === prev.state) return;
            // стейт просто применён из SSE-события агентского PUT — эхо не шлём:
            // сервер уже знает этот стейт, а гонка echo/PUT портила поля;
            // юзерские правки ПОВЕРХ применённого — новый объект, синкается как обычно
            if (s.state === justAppliedRef.current) return;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                const json = JSON.stringify(useLabStore.getState().state);
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

        let es: EventSource | null = null;
        // стейт из share-ссылки уже применён — первое SSE-событие после
        // подключения (initial-кэш сервера) не должно его затирать;
        // флаг сбрасывается после пропуска, дальше PUT-ы применяются штатно
        let skipInitialEvent = false;
        const openEvents = () => {
            skipInitialEvent = hashLoadedRef.current;
            es = new EventSource('/api/events');
            es.onmessage = (ev: MessageEvent<string>) => {
                let msg: { type?: string; state?: unknown; target?: unknown };
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
                if (msg.type !== 'state' || msg.state === undefined) return;
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
            es?.close();
        };
    }, [replace, setDevApiAvailable, setAnalysisTarget, hashLoadedRef]);
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
            post({ id, after });
        };

        const flush = (): void => {
            if (fields.length === 0) return;
            const body = { ts: Date.now(), fields: fields.slice(0, 20), before };
            fields = [];
            flushInFlight = true;
            agentPost('journal', body)
                .then((r) => (r !== null && r.ok ? r.json() : null))
                .then((j: { id?: unknown } | null) => {
                    if (j === null || typeof j.id !== 'number') return;
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
                setAnalysis(data, diff);
                void agentPost('analysis', data);
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
                s.activeTarget === prev.activeTarget
            ) {
                return;
            }
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
    const shareTimer = useRef<number | null>(null);
    const canUndo = useLabStore((s) => s.past.length > 0);
    // флаг «стейт загружен из share-ссылки»: sync-хук по нему пропускает
    // первое SSE-событие (initial-кэш), чтобы не затирать стейт из ссылки
    const hashLoadedRef = useRef(false);
    usePasteImage();
    useAgentSync(hashLoadedRef);
    useJournalSync();
    useAnalysisSync();
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
