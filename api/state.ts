import { BlockStateSchema } from '../src/schema';
import { configured, kvReadJson, K, notConfigured, writeStateVersion } from '../server/kv';
import type { StoredState } from '../server/kv';
import { HttpError, json, readJsonBody, requireMutationAuth, route } from '../server/rest';

/**
 * GET /api/state — текущий стейт. Без ?since — голый BlockState (как в dev),
 * 404 пока ничего не синкалось. С ?since=N — поллинг-контракт: {version, state}
 * при version > N, иначе {version: N, unchanged: true} (не 404 — поллинг
 * дешёвый). Попутно analysisRequest/sweepRequest — заявки агента (анализ
 * таргета / авто-перебор), живущие в том же ключе lab:state (замена SSE,
 * см. API.md «Прод (Vercel)»).
 */
export async function GET(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const stored = await kvReadJson<StoredState>(K.state);
        const state = stored !== null && stored.state !== null ? stored.state : null;
        const version = stored !== null && Number.isInteger(stored.version) ? stored.version : null;
        const analysisRequest =
            typeof stored?.analysisReq === 'string' ? stored.analysisReq : undefined;
        const reqField = analysisRequest === undefined ? {} : { analysisRequest };
        const sweepField = stored?.sweepReq === undefined ? {} : { sweepRequest: stored.sweepReq };

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

/** PUT /api/state — положить стейт (валидация zod → INCR версии → запись). */
export async function PUT(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const parsed = BlockStateSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
            return json(400, { error: 'invalid BlockState', issues: parsed.error.issues });
        }
        const version = await writeStateVersion(parsed.data);
        return json(200, { ok: true, version });
    });
}
