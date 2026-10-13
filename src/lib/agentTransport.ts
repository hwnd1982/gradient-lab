import type { BlockState, Notify, SweepRequest } from '../schema';
import { SweepReqSchema } from '../schema';
import { applyAssetRefs, extractAssetRefs } from '../../shared/assets';
import { fetchAssetImage } from './imageCache';
import { currentSession } from './session';

/**
 * Единый транспорт браузер → Agent API (контракт — в API.md).
 *
 * dev: пути /api/__* обслуживает vite-middleware (vite-plugins/agent-api.ts);
 * формат запросов ровно тот же, что был до появления этого модуля. dev всегда
 * однопользовательский — сессии нет, заголовок не шлётся (сессия 'default').
 *
 * prod: те же данные уходят в Vercel-функции api/*.ts (/api/sync, /api/analysis,
 * /api/warnings, /api/journal — dev-имена /api/__* там работают через rewrites
 * в vercel.json); если задан VITE_LAB_TOKEN — добавляется Authorization: Bearer
 * (мутации на проде можно закрыть env LAB_API_TOKEN). Прод мульти-сессионный:
 * каждый вызов несёт X-Lab-Session из sessionStorage (см. lib/session.ts) —
 * значение читается в момент вызова, чтобы селектор хедера переключал сессию
 * на лету; поллинг тоже (своя версия на сессию).
 *
 * Картинки-dataURL живут только в локальном стейте браузера; на границе
 * транспорта (этот модуль) они переводятся в ассет-ссылки asset:sha256-<hex>
 * (sha256 от точной dataURL-строки), содержимое прикладывается словарём
 * assets в теле sync/PUT — сервер кладёт его в дедуплицированные ключи
 * SETNX-ом. Обратно чужой стейт приходит со ссылками — резолвим в dataURL
 * (кэш в imageCache). Итог: KV-слот лёгкий; KV-запись ассета происходит
 * один раз (SETNX), payload синка несёт dataURL каждый раз — квоту Upstash
 * это не тратит (EXISTS-микроответ), только Vercel-трафик (инцидент
 * bandwidth Upstash 12GB/10GB, 2026-10).
 */

const IS_PROD = !import.meta.env.DEV;
const TOKEN = import.meta.env.VITE_LAB_TOKEN;

const PATHS = IS_PROD
    ? {
          sync: '/api/sync',
          analysis: '/api/analysis',
          warnings: '/api/warnings',
          journal: '/api/journal',
          sweepResult: '/api/sweep',
      }
    : {
          sync: '/api/__sync',
          analysis: '/api/__analysis',
          warnings: '/api/__warnings',
          journal: '/api/__journal',
          sweepResult: '/api/__sweep',
      };

export type AgentPath = keyof typeof PATHS;

function headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (TOKEN !== undefined && TOKEN !== '') h.Authorization = `Bearer ${TOKEN}`;
    if (IS_PROD) h['X-Lab-Session'] = currentSession();
    return h;
}

/** Кэш sha256(dataURL) → hex: картинки байт-в-байт повторяются между тиками. */
const hashCache = new Map<string, string>();

/** Вместимость hashCache: ключи — dataURL, бывают мегабайтными. */
const HASH_CACHE_LIMIT = 24;

/** sha256 → hex lowercase; null — crypto.subtle недоступен (небезопасный контекст). */
async function dataUrlHash(dataUrl: string): Promise<string | null> {
    const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
    if (subtle === undefined) return null;
    const cached = hashCache.get(dataUrl);
    if (cached !== undefined) return cached;
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(dataUrl));
    let hex = '';
    for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
    hashCache.set(dataUrl, hex);
    // dataURL-ключи тяжёлые — держим только последние HASH_CACHE_LIMIT штук
    // (Map итерируется в порядке вставки: первый ключ — самый старый)
    if (hashCache.size > HASH_CACHE_LIMIT) {
        const oldest = hashCache.keys().next().value;
        if (oldest !== undefined) hashCache.delete(oldest);
    }
    return hex;
}

/** Хэш-ключ ассета ('sha256-<hex>') или null — картинка уйдёт инлайном. */
async function toAssetHash(dataUrl: string): Promise<string | null> {
    const hex = await dataUrlHash(dataUrl);
    return hex === null ? null : `sha256-${hex}`;
}

/** Транспортный вид стейта: картинки-dataURL → ссылки, содержимое — в словарь. */
export interface StateUpload {
    state: BlockState;
    /** dataURL картинок по хэш-ключу; сервер кладёт их в ассет-ключи (SETNX) */
    assets?: Record<string, string>;
}

/**
 * Подготовить стейт к отправке (sync/PUT): dataURL-картинки → ссылки
 * asset:sha256-<hex>, содержимое прикладывается словарём assets (НЕ внутри
 * state). Локальный стейт не мутируется. При недоступном crypto.subtle
 * картинки остаются инлайном — сервер вынесет их сам (лексически тяжелее,
 * но рабочий путь).
 */
export async function prepareStateUpload(state: BlockState): Promise<StateUpload> {
    return extractAssetRefs(state, toAssetHash);
}

/**
 * Чужой стейт: ссылки asset:sha256-* → dataURL (кэш в imageCache, дедуп
 * in-flight). Несрезолвленная ссылка → null — поле пустое, рендер не ломаем.
 */
export async function resolveStateImages(state: BlockState): Promise<BlockState> {
    return applyAssetRefs(state, (hash) => fetchAssetImage(hash));
}

/**
 * Нормализованный JSON стейта в refs-виде — для identity-сверок (эхо/байт-в-
 * байт-скип в useAgentSync): пришедший стейт несёт asset-ссылки, локальный —
 * dataURL; прямое сравнение давало бы ложное «изменилось» каждый тик. Обе
 * стороны переводятся в один вид (inline-dataURL → ссылка), ссылки — как есть.
 */
export async function normalizedStateJson(state: unknown): Promise<string> {
    if (state === null || typeof state !== 'object') return JSON.stringify(state);
    const { state: refs } = await extractAssetRefs(state as object, toAssetHash);
    return JSON.stringify(refs);
}

/**
 * POST JSON в агентский API; null — сеть недоступна (тихий пропуск тика, как
 * .catch(() => {}) до появления транспорта). Ответ не парсится — журнал ждёт
 * {id} из него сам.
 */
export async function agentPost(path: AgentPath, body: unknown): Promise<Response | null> {
    try {
        return await fetch(PATHS[path], {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(body),
        });
    } catch {
        return null;
    }
}

/**
 * Заявки агента и notify в ответах полла и синка (одинаковые поля — см.
 * server/functions/state.ts и sync.ts): analysisRequest — заявка на анализ
 * таргета, sweepRequest — заявка на авто-перебор, notify — сообщение юзеру.
 */
export interface AgentPending {
    /** заявка агента на анализ таргета (замена SSE analysis-request); стирается POST /api/analysis */
    analysisRequest?: string;
    /** заявка агента на авто-перебор (замена SSE sweep-request); стирается POST результата */
    sweepRequest?: SweepRequest;
    /** последнее сообщение агента юзеру (POST /api/notify) — тост «Агент: …»; показ только если ts новее последнего */
    notify?: Notify;
}

/**
 * Разобрать заявки/notify из тела ответа (полл GET ?since и POST /api/sync
 * несут их одинаковым видом). Заявка sweep валидируется на месте: битую молча
 * роняем (не наш sweep); notify без строкового text/числового ts — тоже.
 */
function parsePending(o: Record<string, unknown>): AgentPending {
    let sweepRequest: SweepRequest | undefined;
    const sr = o.sweepRequest;
    if (
        typeof sr === 'object' &&
        sr !== null &&
        typeof (sr as { id?: unknown }).id === 'string'
    ) {
        const req = SweepReqSchema.safeParse((sr as { req?: unknown }).req);
        if (req.success) {
            sweepRequest = { id: (sr as { id: string }).id, req: req.data };
        }
    }
    const nf = o.notify;
    const notify: Notify | undefined =
        typeof nf === 'object' &&
        nf !== null &&
        typeof (nf as { text?: unknown }).text === 'string' &&
        typeof (nf as { ts?: unknown }).ts === 'number'
            ? (nf as Notify)
            : undefined;
    return {
        analysisRequest: typeof o.analysisRequest === 'string' ? o.analysisRequest : undefined,
        sweepRequest,
        notify,
    };
}

/** Ответ POST /api/sync: версия + заявки агента, записанные до синка. */
export interface SyncReply extends AgentPending {
    version: number;
}

/**
 * POST транспортного вида стейта браузера (прод: /api/sync, тело {state,
 * assets?}; dev: /api/__sync — middleware понимает тот же формат) → ответ
 * сервера: {version, analysisRequest?, sweepRequest?, notify?}, null — не
 * дошло/нет версии. Заявки/notify в ответе — записанные агентом ДО синка
 * (гонка с вер-тиком полла, см. sync.ts); их обработка — та же, что у полла.
 * Dev-ветка синка этим путём не ходит (см. useAgentSync в App.tsx — там
 * прежний буквальный запрос, но тоже в транспортном виде).
 */
export async function agentSync(payload: StateUpload): Promise<SyncReply | null> {
    try {
        const r = await fetch(PATHS.sync, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(payload),
        });
        if (!r.ok) return null;
        const j: unknown = await r.json();
        if (typeof j !== 'object' || j === null) return null;
        const o = j as Record<string, unknown>;
        if (typeof o.version !== 'number') return null;
        return { version: o.version, ...parsePending(o) };
    } catch {
        return null;
    }
}

/** Ответ поллинга GET /api/state?since=N (прод). */
export interface StatePoll extends AgentPending {
    status: number;
    version?: number;
    unchanged?: boolean;
    state?: unknown;
}

/** Поллинг версии стейта; null — сеть недоступна. */
export async function pollState(since: number): Promise<StatePoll | null> {
    try {
        const r = await fetch(`/api/state?since=${since}`, { headers: headers() });
        const j: unknown = await r.json();
        if (typeof j !== 'object' || j === null) return { status: r.status };
        const o = j as Record<string, unknown>;
        return {
            status: r.status,
            version: typeof o.version === 'number' ? o.version : undefined,
            unchanged: o.unchanged === true,
            state: 'state' in o ? o.state : undefined,
            ...parsePending(o),
        };
    } catch {
        return null;
    }
}

/** Строка ответа GET /api/sessions (прод): слот доски для селектора хедера. */
export interface SessionInfo {
    id: string;
    name: string;
    updatedAt: number;
}

/**
 * GET /api/sessions — список живых сессий (прод; чтение открыто). null — сеть
 * недоступна или прод-API не настроен (503): селектор покажет «не удалось».
 */
export async function fetchSessions(): Promise<SessionInfo[] | null> {
    try {
        const r = await fetch('/api/sessions', { headers: headers() });
        if (!r.ok) return null;
        const j: unknown = await r.json();
        const sessions = (j as { sessions?: unknown }).sessions;
        if (!Array.isArray(sessions)) return null;
        return sessions.filter(
            (e): e is SessionInfo =>
                typeof e === 'object' &&
                e !== null &&
                typeof (e as { id?: unknown }).id === 'string' &&
                typeof (e as { name?: unknown }).name === 'string' &&
                typeof (e as { updatedAt?: unknown }).updatedAt === 'number'
        );
    } catch {
        return null;
    }
}
