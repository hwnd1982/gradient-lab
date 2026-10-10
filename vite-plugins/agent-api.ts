import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { z } from 'zod';
import {
    AnalysisPostSchema,
    BlockStateSchema,
    JournalPostSchema,
    SweepReqSchema,
    SweepResultSchema,
    WarningsPayloadSchema,
} from '../src/schema.ts';
import type { JournalEntry, SweepPoint, SweepReq } from '../src/schema.ts';
import { METHODOLOGY } from '../src/lib/methodology.ts';
// чистые хелперы, общие с прод-функциями api/ (единый источник KNOWN_TARGET_KEYS)
import { canonicalTargetKey, KNOWN_TARGET_KEYS, sanitizeName } from '../shared/targetKeys.ts';

/** Интервал heartbeat для SSE-клиентов. */
const HEARTBEAT_MS = 25_000;

/** Вместимость кольцевого буфера журнала итераций (в памяти, в памяти dev-сервера). */
const JOURNAL_LIMIT = 200;

/** Лимит тела запроса — больше не читаем и не парсим. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Управляемый отказ из readBody (ловится в catch middleware → ответ с кодом). */
interface HttpBodyError {
    code: number;
    payload: unknown;
}

interface PresetFileOk {
    name: string;
    state: unknown;
}
interface PresetFileErr {
    name: string;
    error: string;
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let tooLarge = false;
        req.on('data', (chunk: Buffer) => {
            if (tooLarge) return; // остаток запроса дочитываем, но не копим
            received += chunk.length;
            if (received > MAX_BODY_BYTES) {
                tooLarge = true;
                chunks.length = 0;
                const err: HttpBodyError = {
                    code: 413,
                    payload: { error: 'тело запроса больше 10 МБ' },
                };
                reject(err);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
        });
        req.on('error', reject);
    });
}

/** Тело запроса -> валидный BlockState; при ошибке кидает { code, payload }. */
function parseStateBody(raw: string): { code: number; payload: unknown } | { data: string } {
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        return { code: 400, payload: { error: 'тело запроса не является JSON' } };
    }
    const parsed = BlockStateSchema.safeParse(json);
    if (!parsed.success) {
        return { code: 400, payload: { error: 'invalid BlockState', issues: parsed.error.issues } };
    }
    return { data: JSON.stringify(parsed.data) };
}

/**
 * Dev-only Agent API (см. API.md): чтение/запись стейта live через SSE,
 * JSON-schema, файловые пресеты в presets/. В build неактивен (apply: 'serve').
 */
export function agentApi(): Plugin {
    let root = process.cwd();
    /** Последний стейт (канонический JSON): от браузера (POST /__sync) или агента (PUT /state). */
    let cachedState: string | null = null;
    /** Последний diff-анализ (JSON) от браузера (POST /__analysis). */
    let cachedAnalysis: string | null = null;
    /** Таргет последнего закэшированного анализа (из payload.target). */
    let cachedAnalysisTarget: string | null = null;
    /** Последний payload борт-контроля (JSON): {"warnings":[...]} или {"cleared":true}. */
    let cachedWarnings: string | null = null;
    /** Кольцевой буфер журнала итераций (в памяти; DELETE /api/journal чистит). */
    let journal: JournalEntry[] = [];
    let journalSeq = 0;
    /**
     * Исполнение sweep (авто-перебор): заявки и результаты по id в памяти
     * dev-сервера. Заявка доставляется приложению SSE-событием sweep-request,
     * результат приложение шлёт POST /api/__sweep; агент поллит GET /api/sweep?id=.
     */
    const sweeps = new Map<
        string,
        {
            req: SweepReq;
            status: 'pending' | 'done' | 'aborted';
            results?: SweepPoint[];
            aborted?: string;
        }
    >();
    const sseClients = new Set<ServerResponse>();

    const presetsDir = (): string => path.resolve(root, 'presets');

    const broadcast = (payload: unknown): void => {
        const data = `data: ${JSON.stringify(payload)}\n\n`;
        for (const res of sseClients) res.write(data);
    };

    async function listPresets(): Promise<(PresetFileOk | PresetFileErr)[]> {
        const dir = presetsDir();
        await mkdir(dir, { recursive: true });
        const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
        return Promise.all(
            names.map(async (fileName): Promise<PresetFileOk | PresetFileErr> => {
                const name = fileName.replace(/\.json$/, '');
                try {
                    const json: unknown = JSON.parse(
                        await readFile(path.join(dir, fileName), 'utf8')
                    );
                    const parsed = BlockStateSchema.safeParse(json);
                    return parsed.success
                        ? { name, state: parsed.data }
                        : { name, error: 'файл не проходит валидацию BlockState' };
                } catch (err) {
                    return { name, error: `не удалось прочитать: ${String(err)}` };
                }
            })
        );
    }

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = req.url ?? '/';
        const method = (req.method ?? 'GET').toUpperCase();

        if (method === 'GET' && url === '/schema') {
            sendJson(res, 200, {
                $schema: 'http://json-schema.org/draft-2020-12/schema#',
                title: 'BlockState',
                ...z.toJSONSchema(BlockStateSchema),
            });
            return;
        }

        // методика подгонки v2 — из одного места (src/lib/methodology.ts);
        // тот же ответ отдаёт прод api/methodology.ts, стейт/Upstash не нужны
        if (method === 'GET' && url.split('?')[0] === '/methodology') {
            sendJson(res, 200, METHODOLOGY);
            return;
        }

        // браузер присылает текущий стейт (кэшируется, НЕ броадкастится)
        if (method === 'POST' && url === '/__sync') {
            const result = parseStateBody(await readBody(req));
            if ('payload' in result) {
                sendJson(res, result.code, result.payload);
                return;
            }
            cachedState = result.data;
            sendJson(res, 200, { ok: true });
            return;
        }

        if (method === 'GET' && url === '/state') {
            if (cachedState === null) {
                sendJson(res, 404, {
                    error: 'стейт ещё не синкался: откройте приложение в браузере (оно шлёт POST /api/__sync) или положите свой через PUT /api/state',
                });
                return;
            }
            sendJson(res, 200, JSON.parse(cachedState));
            return;
        }

        // браузер присылает diff-анализ против референса (debounce ~500ms,
        // считается при загруженном compare.refImage); {"cleared":true} — референс
        // убрали; {target, gradientMissing|blocked} — честный маркер «анализ
        // невозможен» вместо фиктивного (нет градиента у таргета / нет референса)
        if (method === 'POST' && url === '/__analysis') {
            const raw = await readBody(req);
            let json: unknown;
            try {
                json = JSON.parse(raw);
            } catch {
                sendJson(res, 400, { error: 'тело запроса не является JSON' });
                return;
            }
            const parsed = AnalysisPostSchema.safeParse(json);
            if (!parsed.success) {
                sendJson(res, 400, {
                    error: 'invalid Analysis payload',
                    issues: parsed.error.issues,
                });
                return;
            }
            if ('cleared' in parsed.data) {
                cachedAnalysis = null;
                cachedAnalysisTarget = null;
                sendJson(res, 200, { ok: true });
                return;
            }
            cachedAnalysis = JSON.stringify(parsed.data);
            cachedAnalysisTarget = parsed.data.target;
            sendJson(res, 200, { ok: true });
            return;
        }

        if (method === 'GET' && url.split('?')[0] === '/analysis') {
            const queryStart = url.indexOf('?');
            const query = queryStart >= 0 ? new URLSearchParams(url.slice(queryStart + 1)) : null;
            const targetParam = query?.get('target') ?? null;

            if (targetParam === null) {
                // без ?target — как раньше: последний анализ (активный UI-таргет)
                if (cachedAnalysis === null) {
                    sendJson(res, 404, {
                        error: 'анализа ещё нет: загрузите референс в браузере (секция «Сравнение с макетом») — приложение пришлёт POST /api/__analysis',
                    });
                    return;
                }
                sendJson(res, 200, JSON.parse(cachedAnalysis));
                return;
            }

            const key = canonicalTargetKey(targetParam);
            if (key === null) {
                sendJson(res, 400, {
                    error: `неизвестный target «${targetParam}»`,
                    known: KNOWN_TARGET_KEYS,
                });
                return;
            }
            // кэш валиден, только если считался для того же таргета
            if (cachedAnalysis !== null && cachedAnalysisTarget === key) {
                sendJson(res, 200, JSON.parse(cachedAnalysis));
                return;
            }
            // просим приложение пересчитать под запрошенный таргет (SSE; стор
            // игнорирует повторные запросы того же таргета) и отвечаем
            // ошибкой-инструкцией; агент поллит до совпадения target в ответе
            broadcast({ type: 'analysis-request', target: key });
            sendJson(res, 404, {
                error: `анализ для target=${key} запрошен у приложения (SSE analysis-request); повторите GET через ~1 с, пока ответ не придёт с этим target`,
                requested: key,
            });
            return;
        }

        // авто-перебор значения (методика v2, F2): агент оставляет заявку
        // (браузер получает SSE sweep-request и исполняет: транзиентные значения
        // → анализ → таблица), результат принимает POST /api/__sweep, агент
        // поллит статус GET /api/sweep?id=
        if (method === 'POST' && url === '/sweep') {
            const raw = await readBody(req);
            let json: unknown;
            try {
                json = JSON.parse(raw);
            } catch {
                sendJson(res, 400, { error: 'тело запроса не является JSON' });
                return;
            }
            const parsed = SweepReqSchema.safeParse(json);
            if (!parsed.success) {
                sendJson(res, 400, { error: 'invalid sweep request', issues: parsed.error.issues });
                return;
            }
            const id = crypto.randomUUID();
            sweeps.set(id, { req: parsed.data, status: 'pending' });
            broadcast({ type: 'sweep-request', id, req: parsed.data });
            sendJson(res, 200, { id });
            return;
        }

        if (method === 'GET' && url.split('?')[0] === '/sweep') {
            const queryStart = url.indexOf('?');
            const query = queryStart >= 0 ? new URLSearchParams(url.slice(queryStart + 1)) : null;
            const id = query?.get('id') ?? null;
            if (id === null) {
                sendJson(res, 400, { error: 'укажите ?id=<sweep id из POST /api/sweep>' });
                return;
            }
            const s = sweeps.get(id);
            if (s === undefined) {
                sendJson(res, 404, { error: `sweep ${id} не найден (dev-сервер перезапускался?)` });
                return;
            }
            sendJson(res, 200, {
                id,
                status: s.status,
                ...(s.results !== undefined ? { results: s.results } : {}),
                ...(s.aborted !== undefined ? { aborted: s.aborted } : {}),
            });
            return;
        }

        // браузер шлёт результат исполнения заявки: таблица точек и/или abort
        if (method === 'POST' && url === '/__sweep') {
            const raw = await readBody(req);
            let json: unknown;
            try {
                json = JSON.parse(raw);
            } catch {
                sendJson(res, 400, { error: 'тело запроса не является JSON' });
                return;
            }
            const parsed = SweepResultSchema.safeParse(json);
            if (!parsed.success) {
                sendJson(res, 400, { error: 'invalid sweep result', issues: parsed.error.issues });
                return;
            }
            const data = parsed.data;
            const s = sweeps.get(data.id);
            if (s === undefined) {
                sendJson(res, 404, { error: `sweep ${data.id} не найден` });
                return;
            }
            if (data.results !== undefined) s.results = data.results;
            if (data.aborted !== undefined) {
                s.aborted = data.aborted;
                s.status = 'aborted';
            } else {
                s.status = 'done';
            }
            sendJson(res, 200, { ok: true, id: data.id });
            return;
        }

        // браузер присылает предупреждения борт-контроля (debounce ~400ms);
        // {"cleared":true} — предупреждений нет (кэш сбрасываем, старьё не отдаём)
        if (method === 'POST' && url === '/__warnings') {
            const raw = await readBody(req);
            let json: unknown;
            try {
                json = JSON.parse(raw);
            } catch {
                sendJson(res, 400, { error: 'тело запроса не является JSON' });
                return;
            }
            const parsed = WarningsPayloadSchema.safeParse(json);
            if (!parsed.success) {
                sendJson(res, 400, {
                    error: 'invalid warnings payload',
                    issues: parsed.error.issues,
                });
                return;
            }
            cachedWarnings = JSON.stringify(parsed.data);
            sendJson(res, 200, { ok: true });
            return;
        }

        if (method === 'GET' && url === '/warnings') {
            if (cachedWarnings === null) {
                // до первого синка — cleared, чтобы агент не ждал «пусто» как ошибку
                sendJson(res, 404, {
                    cleared: true,
                    error: 'предупреждения ещё не синкались: откройте приложение в браузере — оно шлёт POST /api/__warnings',
                });
                return;
            }
            sendJson(res, 200, JSON.parse(cachedWarnings));
            return;
        }

        // журнал итераций: приложение шлёт записи при изменении стейта (start
        // {ts, fields, before}) и дозаполняет метрики после анализа (finish
        // {id, after}); агент читает GET /api/journal, чтобы откатиться к
        // удачной итерации, и может очистить DELETE
        if (method === 'POST' && url === '/__journal') {
            const raw = await readBody(req);
            let json: unknown;
            try {
                json = JSON.parse(raw);
            } catch {
                sendJson(res, 400, { error: 'тело запроса не является JSON' });
                return;
            }
            const parsed = JournalPostSchema.safeParse(json);
            if (!parsed.success) {
                sendJson(res, 400, {
                    error: 'invalid journal payload',
                    issues: parsed.error.issues,
                });
                return;
            }
            const data = parsed.data;
            if ('id' in data) {
                const entry = journal.find((e) => e.id === data.id);
                if (entry === undefined) {
                    sendJson(res, 404, { error: `запись журнала ${data.id} не найдена` });
                    return;
                }
                entry.after = data.after;
                sendJson(res, 200, { ok: true, id: entry.id });
                return;
            }
            journalSeq += 1;
            const entry: JournalEntry = {
                id: journalSeq,
                ts: data.ts,
                fields: data.fields,
                before: data.before ?? null,
                after: null,
            };
            journal.push(entry);
            if (journal.length > JOURNAL_LIMIT) {
                journal = journal.slice(journal.length - JOURNAL_LIMIT);
            }
            sendJson(res, 200, { ok: true, id: entry.id });
            return;
        }

        if (method === 'GET' && url === '/journal') {
            sendJson(res, 200, { entries: journal });
            return;
        }

        if (method === 'DELETE' && url === '/journal') {
            const cleared = journal.length;
            journal = [];
            // локальное зеркало журнала в приложении тоже чистим — иначе hint
            // «плато радиуса» видит удалённые записи (прод: id-регрессия в App)
            broadcast({ type: 'journal-cleared' });
            sendJson(res, 200, { ok: true, cleared });
            return;
        }

        // агент кладёт стейт — все подключённые браузеры получают его по SSE
        if (method === 'PUT' && url === '/state') {
            const result = parseStateBody(await readBody(req));
            if ('payload' in result) {
                sendJson(res, result.code, result.payload);
                return;
            }
            cachedState = result.data;
            broadcast({ type: 'state', state: JSON.parse(result.data) });
            sendJson(res, 200, { ok: true });
            return;
        }

        if (method === 'GET' && url === '/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            });
            res.write('retry: 2000\n\n');
            if (cachedState !== null) {
                res.write(
                    `data: ${JSON.stringify({ type: 'state', state: JSON.parse(cachedState) })}\n\n`
                );
            }
            sseClients.add(res);
            const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
            req.on('close', () => {
                clearInterval(heartbeat);
                sseClients.delete(res);
            });
            return;
        }

        const presetMatch = url.match(/^\/presets(?:\/([^/]+))?$/);
        if (presetMatch) {
            const dir = presetsDir();

            if (method === 'GET' && presetMatch[1] === undefined) {
                sendJson(res, 200, { files: await listPresets() });
                return;
            }

            if (presetMatch[1] !== undefined) {
                const name = sanitizeName(presetMatch[1]);
                if (name === null) {
                    sendJson(res, 400, {
                        error: 'имя содержит некорректную %-последовательность',
                    });
                    return;
                }
                if (name === '') {
                    sendJson(res, 400, { error: 'имя после санитизации пусто' });
                    return;
                }
                const file = path.join(dir, `${name}.json`);

                if (method === 'GET') {
                    try {
                        const raw = await readFile(file, 'utf8');
                        sendJson(res, 200, JSON.parse(raw));
                    } catch {
                        sendJson(res, 404, { error: `пресет ${name} не найден` });
                    }
                    return;
                }

                if (method === 'PUT') {
                    const result = parseStateBody(await readBody(req));
                    if ('payload' in result) {
                        sendJson(res, result.code, result.payload);
                        return;
                    }
                    await mkdir(dir, { recursive: true });
                    await writeFile(
                        file,
                        `${JSON.stringify(JSON.parse(result.data), null, 4)}\n`,
                        'utf8'
                    );
                    sendJson(res, 200, { ok: true, name });
                    return;
                }

                if (method === 'DELETE') {
                    try {
                        await rm(file);
                        sendJson(res, 200, { ok: true, name });
                    } catch {
                        sendJson(res, 404, { error: `пресет ${name} не найден` });
                    }
                    return;
                }
            }
        }

        sendJson(res, 404, { error: `неизвестный маршрут: ${method} /api${url}` });
    }

    return {
        name: 'gradient-lab:agent-api',
        apply: 'serve',
        configResolved(config) {
            root = config.root;
        },
        configureServer(server) {
            server.middlewares.use('/api', (req, res) => {
                void handle(req, res).catch((err: unknown) => {
                    if (!res.headersSent) {
                        // управляемый отказ (напр. 413 из readBody) — отвечаем его кодом
                        if (
                            err !== null &&
                            typeof err === 'object' &&
                            'code' in err &&
                            'payload' in err &&
                            typeof (err as HttpBodyError).code === 'number'
                        ) {
                            const httpErr = err as HttpBodyError;
                            sendJson(res, httpErr.code, httpErr.payload);
                            return;
                        }
                        sendJson(res, 500, { error: String(err) });
                    } else {
                        res.end();
                    }
                });
            });
        },
    };
}
