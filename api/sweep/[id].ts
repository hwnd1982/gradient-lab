import { sweepPayload } from '../sweep';
import { K, configured, kvReadJson, notConfigured } from '../../server/kv';
import type { StoredSweep } from '../../server/kv';
import { HttpError, json, route } from '../../server/rest';

/** id sweep — uuid (crypto.randomUUID), в ключе Upstash допустимы [a-zA-Z0-9-]. */
const SWEEP_ID_RE = /^[a-zA-Z0-9-]+$/;

/** id из пути /api/sweep/<id> (Node-функции не дают ctx.params — парсим URL). */
function sweepIdFromUrl(req: Request): string {
    const segments = new URL(req.url).pathname.replace(/^\/+|\/+$/g, '').split('/');
    return segments[2] ?? '';
}

/**
 * GET /api/sweep/<id> — статус/результат перебора path-параметром (прод).
 * Query-вариант GET /api/sweep?id=<id> живёт в api/sweep.ts — ответ тот же.
 */
export async function GET(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const id = sweepIdFromUrl(req);
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

export default async function handler(req: Request): Promise<Response> {
    if (req.method === 'GET') return GET(req);
    return json(405, { error: `метод ${req.method} не поддерживается` });
}
