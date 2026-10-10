import { sweepPayload } from './sweep.ts';
import { K, configured, kvReadJson, notConfigured } from '../kv.ts';
import type { StoredSweep } from '../kv.ts';
import { HttpError, json, route, sessionFromRequest, SWEEP_ID_RE } from '../rest.ts';

/** id из query (?id=...) — прод-rewrite /api/sweep/:id доставляется запросом
 *  /api/sweep?id=... (catch-all [[...path]] матчит только один сегмент). */
function sweepIdFromQuery(req: Request): string {
    return new URL(req.url, 'http://localhost').searchParams.get('id') ?? '';
}

/**
 * GET /api/sweep/<id> — статус/результат перебора path-параметром (прод).
 * Query-вариант GET /api/sweep?id=<id> живёт в api/sweep.ts — ответ тот же.
 */
export async function GET(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const session = sessionFromRequest(req);
        const id = sweepIdFromQuery(req);
        if (!SWEEP_ID_RE.test(id)) {
            throw new HttpError(400, { error: 'некорректный id' });
        }
        const stored = await kvReadJson<StoredSweep>(K.sweep(session, id));
        if (stored === null) {
            return json(404, { error: `sweep ${id} не найден` });
        }
        return json(200, sweepPayload(id, stored));
    });
}
