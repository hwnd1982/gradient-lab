import { sweepPayload } from './sweep.ts';
import { K, configured, kvReadJson, notConfigured } from '../kv.ts';
import type { StoredSweep } from '../kv.ts';
import { HttpError, json, route, sessionFromRequest, SWEEP_ID_RE } from '../rest.ts';

interface SweepIdContext {
    params: Promise<{ id: string }>;
}

/**
 * GET /api/sweep/<id> — статус/результат перебора path-параметром (прод), в
 * контексте сессии (X-Lab-Session): чужой sweep по тому же id не читается.
 * Query-вариант GET /api/sweep?id=<id> живёт в server/functions/sweep.ts —
 * ответ тот же.
 */
export async function GET(req: Request, ctx: SweepIdContext): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const sessionId = sessionFromRequest(req);
        const { id } = await ctx.params;
        if (!SWEEP_ID_RE.test(id)) {
            throw new HttpError(400, { error: 'некорректный id' });
        }
        const stored = await kvReadJson<StoredSweep>(K.sweep(sessionId, id));
        if (stored === null) {
            return json(404, { error: `sweep ${id} не найден` });
        }
        return json(200, sweepPayload(id, stored));
    });
}
