import type { WarningsPayload } from '../../src/schema.ts';
import { WarningsPayloadSchema } from '../../src/schema.ts';
import { K, configured, ensureSession, kvReadJson, kvWriteJson, notConfigured } from '../kv.ts';
import { json, readJsonBody, requireMutationAuth, route, sessionFromRequest } from '../rest.ts';

/**
 * GET /api/warnings — борт-контроль старта сессии (X-Lab-Session; несуществующая
 * создаётся лениво). До первого POST — 404 с cleared:true (как в dev), чтобы
 * агент не ждал «пусто» как ошибку.
 */
export async function GET(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const sessionId = sessionFromRequest(req);
        await ensureSession(sessionId);
        const stored = await kvReadJson<WarningsPayload>(K.warnings(sessionId));
        if (stored === null) {
            return json(404, {
                cleared: true,
                error: 'предупреждения ещё не синкались: откройте приложение в браузере — оно шлёт POST /api/warnings',
            });
        }
        return json(200, stored);
    });
}

/**
 * POST /api/warnings (прод-аналог dev POST /api/__warnings) — браузер шлёт
 * предупреждения (debounce ~400ms) в слот своей сессии. Cleared-семантика как
 * в dev: payload {"cleared":true} хранится как «пусто» — GET не отдаёт
 * устаревший список.
 */
export async function POST(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const sessionId = sessionFromRequest(req);
        await ensureSession(sessionId);
        const parsed = WarningsPayloadSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
            return json(400, { error: 'invalid warnings payload', issues: parsed.error.issues });
        }
        await kvWriteJson(K.warnings(sessionId), parsed.data);
        return json(200, { ok: true });
    });
}
