import { z } from 'zod';
import { SweepReqSchema, SweepResultSchema } from '../src/schema';
import {
    K,
    clearSweepReq,
    configured,
    kvReadJson,
    kvWriteJson,
    notConfigured,
    setSweepReq,
} from '../server/kv';
import type { StoredSweep } from '../server/kv';
import { HttpError, json, readJsonBody, requireMutationAuth, route } from '../server/rest';

/** id sweep — uuid (crypto.randomUUID), в ключе Upstash допустимы [a-zA-Z0-9-]. */
const SWEEP_ID_RE = /^[a-zA-Z0-9-]+$/;

/**
 * POST /api/sweep — оба направления одним обработчиком:
 *  - заявка агента {field, from, to, steps} → {id}; доставка приложению —
 *    поле sweepReq того же ключа lab:state, что и analysisReq (полл-тик
 *    остаётся 1 командой), плюс lab:sweep:<id> = {req, status:'pending'};
 *  - результат приложения {id, results?, aborted?} — на прод приходит через
 *    rewrite /api/__sweep → сюда; обновляет lab:sweep:<id> и стирает заявку.
 */
const SweepPostSchema = z.union([SweepReqSchema, SweepResultSchema]);

/** Тело ответа статуса (общее для ?id= и /api/sweep/<id>). */
export function sweepPayload(
    id: string,
    s: StoredSweep
): {
    id: string;
    status: StoredSweep['status'];
    results?: StoredSweep['results'];
    aborted?: string;
} {
    return {
        id,
        status: s.status,
        ...(s.results !== undefined ? { results: s.results } : {}),
        ...(s.aborted !== undefined ? { aborted: s.aborted } : {}),
    };
}

/** GET /api/sweep?id=<id> — статус/результат перебора (прод-аналог dev GET). */
export async function GET(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const id = new URL(req.url).searchParams.get('id');
        if (id === null) {
            throw new HttpError(400, { error: 'укажите ?id=<sweep id из POST /api/sweep>' });
        }
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

export async function POST(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const parsed = SweepPostSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
            return json(400, { error: 'invalid sweep payload', issues: parsed.error.issues });
        }
        const data = parsed.data;

        if ('field' in data) {
            // заявка агента: результат по id, исполнение — браузером (полл ≤10с)
            const id = crypto.randomUUID();
            await setSweepReq({ id, req: data });
            await kvWriteJson(K.sweep(id), { req: data, status: 'pending' });
            return json(200, { id });
        }

        // результат приложения (POST /api/__sweep — rewrite ведёт сюда)
        const stored = await kvReadJson<StoredSweep>(K.sweep(data.id));
        if (stored === null) {
            return json(404, { error: `sweep ${data.id} не найден` });
        }
        const next: StoredSweep = {
            req: stored.req,
            status: data.aborted !== undefined ? 'aborted' : 'done',
        };
        if (data.results !== undefined) next.results = data.results;
        if (data.aborted !== undefined) next.aborted = data.aborted;
        await kvWriteJson(K.sweep(data.id), next);
        await clearSweepReq(data.id);
        return json(200, { ok: true, id: data.id });
    });
}
