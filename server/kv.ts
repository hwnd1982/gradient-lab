import type { BlockState, SweepPoint, SweepReq } from '../src/schema.ts';
import { HttpError, json } from './rest.ts';

/**
 * Прод-стор Agent API: Upstash Redis через REST — чистый fetch, без пакетов.
 * env KV_REST_API_URL/KV_REST_API_TOKEN проставляет интеграция Upstash
 * (Vercel → Storage → Marketplace). Без env все прод-функции отвечают 503.
 *
 * Команды: GET {url}/get|incr|del/<key>; SET — POST {url}/set/<key> с значением
 * в теле (документированный путь Upstash для больших значений: стейты с
 * dataURL-картинками бывают на мегабайты, URL-путь их не вместит).
 */

/** Ключи (см. API.md «Прод (Vercel) → ключи Upstash»). */
export const K = {
    /** {version, state, analysisReq?, sweepReq?} — одним ключом: полл-тик = 1 команда */
    state: 'lab:state',
    /** счётчик версий стейта (INCR при каждой записи) */
    statever: 'lab:statever',
    warnings: 'lab:warnings',
    analysis: 'lab:analysis',
    journal: 'lab:journal',
    /** индекс имён пресетов (JSON-массив) */
    presetIndex: 'lab:presets',
    preset: (name: string): string => `lab:preset:${name}`,
    /** результат sweep по id (TTL не нужен — перетирается следующим заходом) */
    sweep: (id: string): string => `lab:sweep:${id}`,
} as const;

/** Заявка на авто-перебор внутри lab:state (доставка приложению поллом стейта). */
export interface StoredSweepReq {
    id: string;
    req: SweepReq;
}

/**
 * Записанный в lab:state JSON: версия + стейт + заявки агента (analysis —
 * таргет анализа, sweep — авто-перебор). Обе живут в том же ключе, чтобы
 * полл-тик браузера стоил ровно 1 команду Upstash (free-тариф — 10k/день).
 */
export interface StoredState {
    version: number;
    state: BlockState | null;
    analysisReq?: string;
    sweepReq?: StoredSweepReq;
}

/** Запись lab:sweep:<id>: заявка + статус/результат исполнения. */
export interface StoredSweep {
    req: SweepReq;
    status: 'pending' | 'done' | 'aborted';
    results?: SweepPoint[];
    aborted?: string;
}

const NOT_CONFIGURED_ERROR = {
    error: 'prod API не настроен: добавь Upstash-интеграцию (KV_REST_API_URL/KV_REST_API_TOKEN)',
} as const;

interface KvEnv {
    url: string;
    token: string;
}

/** env от Upstash-интеграции Vercel; null — интеграция не подключена. */
function kvEnv(): KvEnv | null {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (typeof url !== 'string' || url === '' || typeof token !== 'string' || token === '') {
        return null;
    }
    return { url: url.replace(/\/+$/, ''), token };
}

/** Подключена ли Upstash-интеграция (для дешёвого 503 до любых операций). */
export function configured(): boolean {
    return kvEnv() !== null;
}

/** Ответ «прод не настроен» — им отвечают все функции без env. */
export function notConfigured(): Response {
    return json(503, NOT_CONFIGURED_ERROR);
}

function kvError(message: string): HttpError {
    return new HttpError(502, { error: `сбой Upstash REST: ${message}` });
}

async function kvRequest(path: string, init?: RequestInit): Promise<unknown> {
    const env = kvEnv();
    if (env === null) throw new HttpError(503, NOT_CONFIGURED_ERROR);
    const method = init?.method ?? 'GET';
    let res: Response;
    try {
        res = await fetch(`${env.url}/${path}`, {
            ...(init ?? {}),
            headers: { Authorization: `Bearer ${env.token}` },
        });
    } catch (err) {
        throw kvError(`${method} /${path}: ${String(err)}`);
    }
    let body: unknown;
    try {
        body = await res.json();
    } catch {
        throw kvError(`${method} /${path}: ответ не JSON (${res.status})`);
    }
    const isErr = typeof body === 'object' && body !== null && 'error' in body;
    if (!res.ok || isErr) {
        const msg = isErr ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
        throw kvError(`${method} /${path}: ${msg}`);
    }
    return (body as { result?: unknown }).result ?? null;
}

/** Прочитать JSON-значение ключа; null — ключа нет. */
export async function kvReadJson<T>(key: string): Promise<T | null> {
    const result = await kvRequest(`get/${encodeURIComponent(key)}`);
    if (result === null || result === undefined) return null;
    if (typeof result !== 'string') return result as T; // числа/массивы REST отдаёт как есть
    try {
        return JSON.parse(result) as T;
    } catch {
        throw kvError(`ключ ${key}: значение не JSON`);
    }
}

/** Записать значение как JSON (телом POST — см. примечание в шапке модуля). */
export async function kvWriteJson(key: string, value: unknown): Promise<void> {
    await kvRequest(`set/${encodeURIComponent(key)}`, {
        method: 'POST',
        body: JSON.stringify(value),
    });
}

/** INCR счётчика; возвращает новое значение. */
export async function kvIncr(key: string): Promise<number> {
    const result = await kvRequest(`incr/${encodeURIComponent(key)}`);
    const n = Number(result);
    if (!Number.isInteger(n)) throw kvError(`incr ${key}: результат не целое число`);
    return n;
}

export async function kvDelete(key: string): Promise<void> {
    await kvRequest(`del/${encodeURIComponent(key)}`);
}

/**
 * Незакрытые заявки (analysisReq/sweepReq) переносятся в новую запись lab:state:
 * синк браузера и агентский PUT не должны затирать их, пока приложение не
 * забрало/не исполнило заявку.
 */
function withPending(
    next: { version: number; state: BlockState | null },
    prev: StoredState | null
): StoredState {
    const out: StoredState = { ...next };
    if (typeof prev?.analysisReq === 'string') out.analysisReq = prev.analysisReq;
    if (prev?.sweepReq !== undefined) out.sweepReq = prev.sweepReq;
    return out;
}

/**
 * Записать новую версию стейта: INCR + write с сохранением ждущих заявок
 * analysisReq/sweepReq. Возвращает присвоенную версию.
 */
export async function writeStateVersion(state: BlockState): Promise<number> {
    const prev = await kvReadJson<StoredState>(K.state);
    const version = await kvIncr(K.statever);
    await kvWriteJson(K.state, withPending({ version, state }, prev));
    return version;
}

/**
 * Положить заявку sweep в lab:state (доставка приложению поллом; версия не
 * инкрементится — как у analysisReq) с сохранением analysisReq.
 */
export async function setSweepReq(req: StoredSweepReq): Promise<void> {
    const st = await kvReadJson<StoredState>(K.state);
    const next: StoredState = {
        version: st?.version ?? 0,
        state: st?.state ?? null,
        sweepReq: req,
    };
    if (typeof st?.analysisReq === 'string') next.analysisReq = st.analysisReq;
    await kvWriteJson(K.state, next);
}

/**
 * Положить заявку анализа в lab:state (доставка приложению поллом; версия не
 * инкрементится) с сохранением sweep-заявки. Единственный писатель analysisReq
 * кроме clearAnalysisReq — чтобы промах GET ?target= не стирал чужую sweep-заявку.
 * Идемпотентна: та же заявка не перезаписывается (без лишних команд).
 */
export async function setAnalysisReq(key: string): Promise<void> {
    const st = await kvReadJson<StoredState>(K.state);
    if (st !== null && st.analysisReq === key) return;
    const next: StoredState = {
        version: st?.version ?? 0,
        state: st?.state ?? null,
        analysisReq: key,
    };
    if (st?.sweepReq !== undefined) next.sweepReq = st.sweepReq;
    await kvWriteJson(K.state, next);
}

/** Стереть заявку sweep по id (результат получен); анализ-заявку сохраняет. */
export async function clearSweepReq(id: string): Promise<void> {
    const st = await kvReadJson<StoredState>(K.state);
    if (st === null || st.sweepReq === undefined || st.sweepReq.id !== id) return;
    const next: StoredState = { version: st.version, state: st.state };
    if (typeof st.analysisReq === 'string') next.analysisReq = st.analysisReq;
    await kvWriteJson(K.state, next);
}

/** Стереть заявку анализа (свежий анализ получен); sweep-заявку сохраняет. */
export async function clearAnalysisReq(): Promise<void> {
    const st = await kvReadJson<StoredState>(K.state);
    if (st === null || typeof st.analysisReq !== 'string') return;
    const next: StoredState = { version: st.version, state: st.state };
    if (st.sweepReq !== undefined) next.sweepReq = st.sweepReq;
    await kvWriteJson(K.state, next);
}
