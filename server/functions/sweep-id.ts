import { sweepPayload } from './sweep.ts';
import { K, configured, kvReadJson, notConfigured } from '../kv.ts';
import type { StoredSweep } from '../kv.ts';
import { HttpError, json, route } from '../rest.ts';

/** id sweep — uuid (crypto.randomUUID), в ключе Upstash допустимы [a-zA-Z0-9-]. */
const SWEEP_ID_RE = /^[a-zA-Z0-9-]+$/;

interface SweepIdContext {
    params: Promise<{ id: string }>;
}

/**
 * GET /api/sweep/<id> — статус/результат перебора path-параметром (прод).
 * Query-вариант GET /api/sweep?id=<id> живёт в server/functions/sweep.ts —
 * ответ тот же.
 */
export async function GET(_req: Request, ctx: SweepIdContext): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const { id } = await ctx.params;
        if (!SWEEP_ID_RE.test(id)) {
            throw new HttpError(400, { error: 'некорректный id' });
        }
        const stored = await kvReadJson<StoredSweep>(K.sweep(id));
        if (stored === null) {
            return json(404, { error: `sweep ${id} не найден` });
        }
        return json(200, sweepPayload(id, stored));
    });
}
