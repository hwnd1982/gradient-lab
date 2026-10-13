import { createHash } from 'node:crypto';
import type { BlockState, Notify, SweepPoint, SweepReq } from '../src/schema.ts';
import { ASSET_HASH_RE, extractAssetRefs } from '../shared/assets.ts';
import { DEFAULT_SESSION, HttpError, json } from './rest.ts';

/**
 * Прод-стор Agent API: Upstash Redis через REST — чистый fetch, без пакетов.
 * env KV_REST_API_URL/KV_REST_API_TOKEN проставляет интеграция Upstash
 * (Vercel → Storage → Marketplace). Без env все прод-функции отвечают 503.
 *
 * Команды: GET {url}/get|incr|del|exists/<key>; SET — POST {url}/set/<key> с
 * значением в теле (документированный путь Upstash для больших значений).
 * Картинки-dataURL в слотах НЕ живут: при каждой записи слота выносятся в
 * ассет-ключи lab:asset:sha256-<hex> (см. lightenState), слот хранит только
 * ссылки asset:sha256-<hex> — мегабайты не гоняются полл-тиками и sync-ами
 * (инцидент bandwidth 12GB/10GB, 2026-10-13).
 */

/** Ключи (см. API.md «Прод (Vercel)» и «Сессии»). */
export const K = {
    // legacy-ключи односессионной эпохи: переносятся в слот default при первом
    // обращении к нему (migrateLegacyDefault), после чего удаляются
    legacyState: 'lab:state',
    legacyStatever: 'lab:statever',
    legacyWarnings: 'lab:warnings',
    legacyAnalysis: 'lab:analysis',
    /** индекс сессий [{id, name, updatedAt}], cap SESSIONS_LIMIT */
    sessions: 'lab:sessions',
    /** журнал итераций — ОБЩИЙ для всех сессий (общая лента подбора) */
    journal: 'lab:journal',
    /** индекс имён пресетов (JSON-массив) — пресеты глобальны */
    presetIndex: 'lab:presets',
    preset: (name: string): string => `lab:preset:${name}`,
    // слоты сессий (id — X-Lab-Session, см. API.md «Сессии»)
    /**
     * {version, state, analysisReq?, sweepReq?, notify?, name, updatedAt} —
     * одним ключом, стейт только с asset-ссылками (слот лёгкий; полл-тик
     * вообще не читает его на unchanged — см. K.statever)
     */
    state: (id: string): string => `lab:s/${id}`,
    /**
     * счётчик версий слота (INCR при каждой записи стейта И заявки/notify).
     * Полл GET /api/state?since=N читает сначала ТОЛЬКО его (~16 байт) и не
     * трогает слот, пока версия не свежее since — пустой тик стоит 1 команду.
     */
    statever: (id: string): string => `lab:s/${id}/ver`,
    warnings: (id: string): string => `lab:s/${id}/warnings`,
    analysis: (id: string): string => `lab:s/${id}/analysis`,
    /** результат sweep по id (TTL не нужен — перетирается следующим заходом); id сессии в ключе, чтобы чужой sweep не читался */
    sweep: (id: string, sweepId: string): string => `lab:s/${id}/sweep/${sweepId}`,
    /** dataURL картинок стейта (контент-адресные, SETNX — переживают DELETE сессии: одинаковые кадры дедуплицируются между сессиями) */
    asset: (hash: string): string => `lab:asset:${hash}`,
} as const;

/** Заявка на авто-перебор внутри lab:state (доставка приложению поллом стейта). */
export interface StoredSweepReq {
    id: string;
    req: SweepReq;
}

/**
 * Записанный в lab:state JSON: версия + стейт (только с asset-ссылками) +
 * заявки агента (analysis — таргет анализа, sweep — авто-перебор). Живут в
 * одном ключе, чтобы изменившийся тик полла читал всё разом; пустой тик
 * вообще не читает слот — только микро-ключ K.statever (free-тариф 10k/день).
 */
export interface StoredState {
    version: number;
    state: BlockState | null;
    analysisReq?: string;
    sweepReq?: StoredSweepReq;
    /**
     * Последнее сообщение агента юзеру (POST /api/notify): одно на слот,
     * новое перезаписывает старое; клиент показывает тост по ts (новее
     * последнего показанного) — стирать после доставки не нужно.
     */
    notify?: Notify;
}

/** Запись lab:sweep:<id>: заявка + статус/результат исполнения. */
export interface StoredSweep {
    req: SweepReq;
    status: 'pending' | 'done' | 'aborted';
    results?: SweepPoint[];
    aborted?: string;
}

/** Мета сессии — живёт в том же ключе lab:s/<id>, что и StoredState. */
export interface SessionMeta {
    /** отображаемое имя (PUT /api/sessions/<id>); по умолчанию = id */
    name: string;
    /** ts последней записи в слот (живость в списке /api/sessions) */
    updatedAt: number;
}

/** Запись lab:s/<id>: стейт-слот сессии = StoredState + мета. */
export type StoredSession = StoredState & SessionMeta;

/** Строка индекса lab:sessions (см. K.sessions). */
export interface SessionIndexEntry {
    id: string;
    name: string;
    updatedAt: number;
}

/** Вместимость индекса сессий: при переполнении выкидываем самые неактивные. */
const SESSIONS_LIMIT = 50;

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

/** Есть ли ключ (EXISTS — микро-ответ; GET тянул бы тело значения). */
export async function kvExists(key: string): Promise<boolean> {
    const result = await kvRequest(`exists/${encodeURIComponent(key)}`);
    return Number(result) > 0;
}

/** Прочитать строковое значение ключа как есть (ассет — dataURL); null — ключа нет. */
export async function kvReadString(key: string): Promise<string | null> {
    const result = await kvRequest(`get/${encodeURIComponent(key)}`);
    return typeof result === 'string' ? result : null;
}

/** sha256 → hex lowercase (серверная сторона ассетов). */
function sha256Hex(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Записать dataURL в ассет-ключ lab:asset:sha256-<hex> с SETNX-семантикой:
 * сначала EXISTS, существующий НЕ перезаписываем (повторная загрузка того же
 * кадра не тратит bandwidth на перезапись мегабайт). Хэш сверяется с телом —
 * ключи контент-адресные, на этом держится дедуп и кэш браузера.
 */
export async function putAsset(hash: string, dataUrl: string): Promise<void> {
    if (!ASSET_HASH_RE.test(hash)) {
        throw new HttpError(400, { error: `невалидный hash ассета: ожидается sha256-<64 hex>` });
    }
    if (!dataUrl.startsWith('data:')) {
        throw new HttpError(400, { error: 'ассет — dataURL-строка (data:image/...;base64,...)' });
    }
    const key = K.asset(hash);
    if (await kvExists(key)) return;
    if (sha256Hex(dataUrl) !== hash.slice('sha256-'.length)) {
        throw new HttpError(400, { error: 'hash ассета не совпадает с содержимым dataURL' });
    }
    await kvRequest(`set/${encodeURIComponent(key)}`, { method: 'POST', body: dataUrl });
}

/** dataURL ассета по хэшу (GET /api/asset); null — ассета нет. */
export async function getAsset(hash: string): Promise<string | null> {
    return kvReadString(K.asset(hash));
}

/**
 * Вынести dataURL-картинки стейта в ассет-ключи: слот остаётся лёгким, каждая
 * уникальная картинка пишется в KV один раз (SETNX в putAsset). Ссылки
 * asset:sha256-* проходят насквозь; легаси-инлайн (слоты до деплоя) конвертится
 * первым же писателем — отдельной миграции не нужно. Ассеты пишутся ДО записи
 * слота, чтобы ссылка из слота всегда резолвилась.
 */
async function lightenState(state: BlockState | null): Promise<BlockState | null> {
    if (state === null) return null;
    const { state: light, assets } = await extractAssetRefs(state, (dataUrl) =>
        Promise.resolve(`sha256-${sha256Hex(dataUrl)}`)
    );
    if (assets !== undefined) {
        for (const [hash, dataUrl] of Object.entries(assets)) await putAsset(hash, dataUrl);
    }
    return light;
}

/**
 * Незакрытые заявки (analysisReq/sweepReq) и непоказанное сообщение (notify)
 * переносятся в новую запись слота: синк браузера и агентский PUT не должны
 * затирать их, пока приложение не забрало/не исполнило заявку.
 */
function withPending(
    next: { version: number; state: BlockState | null },
    prev: StoredSession
): StoredSession {
    const out: StoredSession = { ...next, name: prev.name, updatedAt: Date.now() };
    if (typeof prev.analysisReq === 'string') out.analysisReq = prev.analysisReq;
    if (prev.sweepReq !== undefined) out.sweepReq = prev.sweepReq;
    if (prev.notify !== undefined) out.notify = prev.notify;
    return out;
}

/** Прочитать индекс сессий (как есть, порядок — по updatedAt по возрастанию). */
async function readIndex(): Promise<SessionIndexEntry[]> {
    return (await kvReadJson<SessionIndexEntry[]>(K.sessions)) ?? [];
}

/** Индекс сессий для ответа GET /api/sessions: новые сверху. */
export async function sessionIndex(): Promise<SessionIndexEntry[]> {
    return (await readIndex()).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Upsert строки сессии в индекс (cap 50: выкидываем самые неактивные —
 * сортировка по updatedAt). Не транзакционно, как весь стор: потерянная
 * параллельным пишущим строка самовосстанавливается следующим touchIndex
 * этой сессии (слот при обращении пересоздаёт строку).
 */
async function touchIndex(id: string, name: string): Promise<void> {
    const index = await readIndex();
    const next = index.filter((e) => e.id !== id);
    next.push({ id, name, updatedAt: Date.now() });
    next.sort((a, b) => a.updatedAt - b.updatedAt);
    const capped = next.length > SESSIONS_LIMIT ? next.slice(next.length - SESSIONS_LIMIT) : next;
    await kvWriteJson(K.sessions, capped);
}

/**
 * Разовая миграция односессионной эпохи → слот default: lab:state (плюс
 * счётчик/warnings/analysis) переносится в lab:s/default*, legacy-ключи
 * удаляются. Вызывается только при первом обращении к default, когда слота
 * ещё нет. Не транзакционно (как весь стор): параллельные первые обращения
 * читают одни и те же legacy-ключи и пишут эквивалентный слот.
 */
async function migrateLegacyDefault(): Promise<StoredSession | null> {
    const legacy = await kvReadJson<StoredState>(K.legacyState);
    if (legacy === null) return null;
    const session: StoredSession = { ...legacy, name: DEFAULT_SESSION, updatedAt: Date.now() };
    await kvWriteJson(K.state(DEFAULT_SESSION), session);
    // счётчик продолжается с прежнего места — версия не регрессирует
    const ver = await kvReadJson<number>(K.legacyStatever);
    await kvWriteJson(K.statever(DEFAULT_SESSION), ver ?? legacy.version);
    // warnings/analysis — сессионные вещи: переезжают в слот
    const warnings = await kvReadJson<unknown>(K.legacyWarnings);
    if (warnings !== null) await kvWriteJson(K.warnings(DEFAULT_SESSION), warnings);
    const analysis = await kvReadJson<unknown>(K.legacyAnalysis);
    if (analysis !== null) await kvWriteJson(K.analysis(DEFAULT_SESSION), analysis);
    await kvDelete(K.legacyState);
    await kvDelete(K.legacyStatever);
    await kvDelete(K.legacyWarnings);
    await kvDelete(K.legacyAnalysis);
    await touchIndex(DEFAULT_SESSION, DEFAULT_SESSION);
    return session;
}

/**
 * Слот сессии по обращению — лениво: несуществующая сессия создаётся с пустым
 * стейтом (версия 0) и попадает в индекс; DELETE /api/sessions/<id> сюда не
 * ходит (там 404 на несуществующую). Для default при первом обращении
 * переносит legacy lab:state (см. migrateLegacyDefault). Существующий слот —
 * ровно 1 команда (полл-тик дешевле не сделать).
 */
export async function ensureSession(id: string): Promise<StoredSession> {
    const existing = await kvReadJson<StoredSession>(K.state(id));
    if (existing !== null) return existing;
    if (id === DEFAULT_SESSION) {
        const migrated = await migrateLegacyDefault();
        if (migrated !== null) return migrated;
    }
    // перечитываем перед fresh-записью: параллельный первый заход (или миграция
    // default) мог успеть создать слот — пустышкой его не затираем (RMW-гонка,
    // окно миллисекунды, но перечитывание дешевле потери слота)
    const raced = await kvReadJson<StoredSession>(K.state(id));
    if (raced !== null) return raced;
    const fresh: StoredSession = { version: 0, state: null, name: id, updatedAt: Date.now() };
    await kvWriteJson(K.state(id), fresh);
    // микро-ключ версий создаём сразу: вер-тик полла по нему понимает
    // «нечего читать» без обращения к слоту (легаси-слоты без ключа
    // читаются целиком — обратная совместимость в GET /api/state)
    await kvWriteJson(K.statever(id), 0);
    await touchIndex(id, id);
    return fresh;
}

/**
 * Незакрытые заявки (analysisReq/sweepReq) и непоказанный notify слота ДО
 * записи — writeStateVersion отдаёт их вызывающему: синк браузера несёт их
 * в ответе (гонка «заявка в версии N, синк делает N+1» — вер-тик полла по
 * `ver <= since` такую заявку больше никогда не отдаст).
 */
export interface PendingReqs {
    analysisReq?: string;
    sweepReq?: StoredSweepReq;
    notify?: Notify;
}

/**
 * Записать новую версию стейта слота: INCR + write с сохранением ждущих заявок
 * analysisReq/sweepReq. Картинки-dataURL выносятся в ассет-ключи (lightenState),
 * в слоте остаются ссылки. Возвращает присвоенную версию и незакрытые
 * заявки/notify слота ДО записи (pending; null — их не было). Бонусом —
 * touchIndex: живость сессии в списке /api/sessions и порядок eviction по ней же.
 */
export async function writeStateVersion(
    sessionId: string,
    state: BlockState
): Promise<{ version: number; pending: PendingReqs | null }> {
    const prev = await ensureSession(sessionId);
    const light = await lightenState(state);
    const version = await kvIncr(K.statever(sessionId));
    await kvWriteJson(K.state(sessionId), withPending({ version, state: light }, prev));
    await touchIndex(sessionId, prev.name);
    let pending: PendingReqs | null = null;
    if (
        typeof prev.analysisReq === 'string' ||
        prev.sweepReq !== undefined ||
        prev.notify !== undefined
    ) {
        pending = {};
        if (typeof prev.analysisReq === 'string') pending.analysisReq = prev.analysisReq;
        if (prev.sweepReq !== undefined) pending.sweepReq = prev.sweepReq;
        if (prev.notify !== undefined) pending.notify = prev.notify;
    }
    return { version, pending };
}

/**
 * Положить заявку sweep в слот (доставка приложению поллом) с сохранением
 * analysisReq и notify. Версия ИНКРЕМЕНТИТСЯ: полл сначала смотрит только
 * микро-ключ lab:s/<id>/ver и на unchanged слот не читает — заявку он заметит
 * исключительно по сурпу версии.
 */
export async function setSweepReq(sessionId: string, req: StoredSweepReq): Promise<void> {
    const st = await ensureSession(sessionId);
    const state = await lightenState(st.state);
    const version = await kvIncr(K.statever(sessionId));
    const next: StoredSession = {
        version,
        state,
        name: st.name,
        updatedAt: Date.now(),
        sweepReq: req,
    };
    if (typeof st.analysisReq === 'string') next.analysisReq = st.analysisReq;
    if (st.notify !== undefined) next.notify = st.notify;
    await kvWriteJson(K.state(sessionId), next);
}

/**
 * Положить заявку анализа в слот (доставка приложению поллом) с сохранением
 * sweep-заявки и notify. Версия инкрементится — как у setSweepReq (заявку полл
 * видит по микро-ключу версий). Единственный писатель analysisReq кроме
 * clearAnalysisReq — чтобы промах GET ?target= не стирал чужую sweep-заявку.
 * Идемпотентна: та же заявка не пишет и не инкрементит (без лишних команд).
 */
export async function setAnalysisReq(sessionId: string, key: string): Promise<void> {
    const st = await ensureSession(sessionId);
    if (st.analysisReq === key) return;
    const state = await lightenState(st.state);
    const version = await kvIncr(K.statever(sessionId));
    const next: StoredSession = {
        version,
        state,
        name: st.name,
        updatedAt: Date.now(),
        analysisReq: key,
    };
    if (st.sweepReq !== undefined) next.sweepReq = st.sweepReq;
    if (st.notify !== undefined) next.notify = st.notify;
    await kvWriteJson(K.state(sessionId), next);
}

/** Стереть заявку sweep по id (результат получен); анализ-заявку и notify сохраняет. Версию не трогает. */
export async function clearSweepReq(sessionId: string, id: string): Promise<void> {
    const st = await kvReadJson<StoredSession>(K.state(sessionId));
    if (st === null || st.sweepReq === undefined || st.sweepReq.id !== id) return;
    const state = await lightenState(st.state);
    const next: StoredSession = {
        version: st.version,
        state,
        name: st.name,
        updatedAt: st.updatedAt,
    };
    if (typeof st.analysisReq === 'string') next.analysisReq = st.analysisReq;
    if (st.notify !== undefined) next.notify = st.notify;
    await kvWriteJson(K.state(sessionId), next);
}

/** Стереть заявку анализа (свежий анализ получен); sweep-заявку и notify сохраняет. Версию не трогает. */
export async function clearAnalysisReq(sessionId: string): Promise<void> {
    const st = await kvReadJson<StoredSession>(K.state(sessionId));
    if (st === null || typeof st.analysisReq !== 'string') return;
    const state = await lightenState(st.state);
    const next: StoredSession = {
        version: st.version,
        state,
        name: st.name,
        updatedAt: st.updatedAt,
    };
    if (st.sweepReq !== undefined) next.sweepReq = st.sweepReq;
    if (st.notify !== undefined) next.notify = st.notify;
    await kvWriteJson(K.state(sessionId), next);
}

/**
 * Положить сообщение агента юзеру в слот (POST /api/notify): одно последнее,
 * новое перезаписывает старое; версия инкрементится — как у заявок, полл
 * забирает notify по сурпу версий. Соседние analysisReq/sweepReq сохраняет.
 * Возвращает ts сообщения (клиент фильтрует показ по нему).
 */
export async function setNotify(sessionId: string, text: string): Promise<number> {
    const st = await ensureSession(sessionId);
    const state = await lightenState(st.state);
    const ts = Date.now();
    const version = await kvIncr(K.statever(sessionId));
    const next: StoredSession = {
        version,
        state,
        name: st.name,
        updatedAt: ts,
        notify: { text, ts },
    };
    if (typeof st.analysisReq === 'string') next.analysisReq = st.analysisReq;
    if (st.sweepReq !== undefined) next.sweepReq = st.sweepReq;
    await kvWriteJson(K.state(sessionId), next);
    return ts;
}

/**
 * Создать/переименовать сессию (PUT /api/sessions/<id>): несуществующая —
 * пустой слот с данным именем, существующая — только имя + updatedAt.
 */
export async function upsertSession(id: string, name: string): Promise<void> {
    const existing = await kvReadJson<StoredSession>(K.state(id));
    if (existing !== null) {
        await kvWriteJson(K.state(id), { ...existing, name, updatedAt: Date.now() });
    } else {
        await kvWriteJson(K.state(id), { version: 0, state: null, name, updatedAt: Date.now() });
    }
    await touchIndex(id, name);
}

/**
 * Удалить слот сессии (DELETE /api/sessions/<id>): стейт, счётчик версий,
 * warnings, analysis — заявки жили в слоте, удалились вместе с ним. Ассеты
 * lab:asset:* НЕ удаляются: ключи контент-адресные и дедуплицированы между
 * сессиями (один и тот же кадр в другой сессии ссылается на них же).
 * Возвращает false, если сессии не было. Ключи результатов sweep
 * (lab:s/<id>/sweep/<uuid>) не перечислимы без SCAN — остаются орфанными
 * (не читаются без uuid, перезатираются новыми sweep той же сессии). Для
 * default заодно сносим legacy-ключи, чтобы удаление было честным сбросом
 * (иначе следующий заход пере-мигрировал бы старьё).
 */
export async function deleteSession(id: string): Promise<boolean> {
    const existing = await kvReadJson<StoredSession>(K.state(id));
    if (existing === null) return false;
    await kvDelete(K.state(id));
    await kvDelete(K.statever(id));
    await kvDelete(K.warnings(id));
    await kvDelete(K.analysis(id));
    if (id === DEFAULT_SESSION) {
        await kvDelete(K.legacyState);
        await kvDelete(K.legacyStatever);
        await kvDelete(K.legacyWarnings);
        await kvDelete(K.legacyAnalysis);
    }
    const index = await readIndex();
    const next = index.filter((e) => e.id !== id);
    if (next.length !== index.length) await kvWriteJson(K.sessions, next);
    return true;
}
