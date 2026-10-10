import type { BlockState, SweepRequest } from '../schema';
import { SweepReqSchema } from '../schema';
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
 * POST стейта браузера (прод: /api/sync, тело {state}) → присвоенная сервером
 * версия, null — не дошло/нет версии. Dev-ветка синка этим путём не ходит
 * (см. useAgentSync в App.tsx — там прежний буквальный запрос).
 */
export async function agentSync(state: BlockState): Promise<number | null> {
    try {
        const r = await fetch(PATHS.sync, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ state }),
        });
        if (!r.ok) return null;
        const j: unknown = await r.json();
        if (
            typeof j === 'object' &&
            j !== null &&
            typeof (j as { version?: unknown }).version === 'number'
        ) {
            return (j as { version: number }).version;
        }
        return null;
    } catch {
        return null;
    }
}

/** Ответ поллинга GET /api/state?since=N (прод). */
export interface StatePoll {
    status: number;
    version?: number;
    unchanged?: boolean;
    state?: unknown;
    /** заявка агента на анализ таргета (замена SSE analysis-request); стирается POST /api/analysis */
    analysisRequest?: string;
    /** заявка агента на авто-перебор (замена SSE sweep-request); стирается POST результата */
    sweepRequest?: SweepRequest;
}

/** Поллинг версии стейта; null — сеть недоступна. */
export async function pollState(since: number): Promise<StatePoll | null> {
    try {
        const r = await fetch(`/api/state?since=${since}`, { headers: headers() });
        const j: unknown = await r.json();
        if (typeof j !== 'object' || j === null) return { status: r.status };
        const o = j as Record<string, unknown>;
        // заявка sweep валидируется на месте: битую молча роняем (не наш sweep)
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
        return {
            status: r.status,
            version: typeof o.version === 'number' ? o.version : undefined,
            unchanged: o.unchanged === true,
            state: 'state' in o ? o.state : undefined,
            analysisRequest: typeof o.analysisRequest === 'string' ? o.analysisRequest : undefined,
            sweepRequest,
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
