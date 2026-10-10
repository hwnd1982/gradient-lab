import type { BlockState } from '../src/schema.ts';
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
    /** {version, state, analysisReq?} — одним ключом: полл-тик = 1 команда */
    state: 'lab:state',
    /** счётчик версий стейта (INCR при каждой записи) */
    statever: 'lab:statever',
    warnings: 'lab:warnings',
    analysis: 'lab:analysis',
    journal: 'lab:journal',
    /** индекс имён пресетов (JSON-массив) */
    presetIndex: 'lab:presets',
    preset: (name: string): string => `lab:preset:${name}`,
} as const;

/**
 * Записанный в lab:state JSON: версия + стейт + заявка агента на анализ
 * таргета (analysisReq). Заявка живёт в том же ключе, чтобы полл-тик браузера
 * стоил ровно 1 команду Upstash (free-тариф — 10k команд/день).
 */
export interface StoredState {
    version: number;
    state: BlockState | null;
    analysisReq?: string;
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
 * Записать новую версию стейта: INCR + write с сохранением ждущей заявки
 * analysisReq (синк браузера и агентский PUT не должны её затирать).
 * Возвращает присвоенную версию.
 */
export async function writeStateVersion(state: BlockState): Promise<number> {
    const prev = await kvReadJson<StoredState>(K.state);
    const version = await kvIncr(K.statever);
    await kvWriteJson(K.state, {
        version,
        state,
        ...(typeof prev?.analysisReq === 'string' ? { analysisReq: prev.analysisReq } : {}),
    });
    return version;
}
