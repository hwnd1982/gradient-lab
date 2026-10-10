import type { WarningsPayload } from '../src/schema.ts';
import { WarningsPayloadSchema } from '../src/schema.ts';
import { K, configured, kvReadJson, kvWriteJson, notConfigured } from '../server/kv.ts';
import { json, readJsonBody, requireMutationAuth, route } from '../server/rest.ts';

/**
 * GET /api/warnings — борт-контроль старта. До первого POST — 404 с
 * cleared:true (как в dev), чтобы агент не ждал «пусто» как ошибку.
 */
export async function GET(): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const stored = await kvReadJson<WarningsPayload>(K.warnings);
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
 * предупреждения (debounce ~400ms). Cleared-семантика как в dev: payload
 * {"cleared":true} хранится как «пусто» — GET не отдаёт устаревший список.
 */
export async function POST(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const parsed = WarningsPayloadSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
            return json(400, { error: 'invalid warnings payload', issues: parsed.error.issues });
        }
        await kvWriteJson(K.warnings, parsed.data);
        return json(200, { ok: true });
    });
}
