import { BlockStateSchema } from '../../src/schema.ts';
import { configured, ensureSession, notConfigured, writeStateVersion } from '../kv.ts';
import { HttpError, json, readJsonBody, requireMutationAuth, route, sessionFromRequest } from '../rest.ts';

/**
 * GET /api/state — текущий стейт сессии (X-Lab-Session, default 'default';
 * несуществующая сессия создаётся лениво — пустой стейт). Без ?since — голый
 * BlockState (как в dev), 404 пока ничего не синкалось. С ?since=N —
 * поллинг-контракт: {version, state} при version > N, иначе {version: N,
 * unchanged: true} (не 404 — поллинг дешёвый: слот читается ровно 1 командой).
 * Попутно analysisRequest/sweepRequest — заявки агента (анализ таргета /
 * авто-перебор), живущие в том же слоте lab:s/<id> (замена SSE,
 * см. API.md «Прод (Vercel)» и «Сессии»).
 */
export async function GET(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const sessionId = sessionFromRequest(req);
        const stored = await ensureSession(sessionId);
        const state = stored.state !== null ? stored.state : null;
        const version = Number.isInteger(stored.version) ? stored.version : null;
        const analysisRequest =
            typeof stored.analysisReq === 'string' ? stored.analysisReq : undefined;
        const reqField = analysisRequest === undefined ? {} : { analysisRequest };
        const sweepField = stored.sweepReq === undefined ? {} : { sweepRequest: stored.sweepReq };

        const sinceRaw = new URL(req.url).searchParams.get('since');
        if (sinceRaw === null) {
            if (state === null || version === null) {
                return json(404, {
                    error: 'стейт ещё не синкался: откройте приложение в браузере (оно шлёт POST /api/sync) или положите свой через PUT /api/state',
                });
            }
            return json(200, state);
        }
        const since = Number(sinceRaw);
        if (!Number.isInteger(since) || since < 0) {
            throw new HttpError(400, { error: '?since должен быть неотрицательным целым' });
        }
        if (state !== null && version !== null && version > since) {
            return json(200, { version, state, ...reqField, ...sweepField });
        }
        return json(200, { version: since, unchanged: true, ...reqField, ...sweepField });
    });
}

/** PUT /api/state — положить стейт в сессию (валидация zod → INCR версии → запись). */
export async function PUT(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const sessionId = sessionFromRequest(req);
        const parsed = BlockStateSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
            return json(400, { error: 'invalid BlockState', issues: parsed.error.issues });
        }
        const version = await writeStateVersion(sessionId, parsed.data);
        return json(200, { ok: true, version });
    });
}
