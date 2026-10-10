import { z } from 'zod';
import { SweepReqSchema, SweepResultSchema } from '../../src/schema.ts';
import {
    K,
    clearSweepReq,
    configured,
    kvReadJson,
    kvWriteJson,
    notConfigured,
    setSweepReq,
} from '../kv.ts';
import type { StoredSweep } from '../kv.ts';
import { HttpError, json, readJsonBody, requireMutationAuth, route, sessionFromRequest, SWEEP_ID_RE } from '../rest.ts';

/**
 * POST /api/sweep — оба направления одним обработчиком, оба в контексте
 * сессии (X-Lab-Session; результат чужой сессии по id не читается — он в
 * ключе lab:s/<id>/sweep/<sweepId>):
 *  - заявка агента {field, from, to, steps} → {id}; доставка приложению —
 *    поле sweepReq того же слота lab:s/<id>, что и analysisReq (полл-тик
 *    остаётся 1 командой), плюс lab:s/<id>/sweep/<sweepId> = {req, status:'pending'};
 *  - результат приложения {id, results?, aborted?} — на прод приходит через
 *    rewrite /api/__sweep → сюда; обновляет ключ результата и стирает заявку.
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
        const sessionId = sessionFromRequest(req);
        const id = new URL(req.url).searchParams.get('id');
        if (id === null) {
            throw new HttpError(400, { error: 'укажите ?id=<sweep id из POST /api/sweep>' });
        }
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

export async function POST(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const sessionId = sessionFromRequest(req);
        const parsed = SweepPostSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
            return json(400, { error: 'invalid sweep payload', issues: parsed.error.issues });
        }
        const data = parsed.data;

        if ('field' in data) {
            // заявка агента: результат по id, исполнение — браузером (полл ≤10с).
            // Сначала ключ результата, потом заявка: сбой между ними оставит
            // осиротевший pending-ключ (перезатрётся следующим sweep), но не
            // заявку на sweep, которого нет
            const id = crypto.randomUUID();
            await kvWriteJson(K.sweep(sessionId, id), { req: data, status: 'pending' });
            await setSweepReq(sessionId, { id, req: data });
            return json(200, { id });
        }

        // результат приложения (POST /api/__sweep — rewrite ведёт сюда)
        const stored = await kvReadJson<StoredSweep>(K.sweep(sessionId, data.id));
        if (stored === null) {
            return json(404, { error: `sweep ${data.id} не найден` });
        }
        const next: StoredSweep = {
            req: stored.req,
            status: data.aborted !== undefined ? 'aborted' : 'done',
        };
        if (data.results !== undefined) next.results = data.results;
        if (data.aborted !== undefined) next.aborted = data.aborted;
        await kvWriteJson(K.sweep(sessionId, data.id), next);
        await clearSweepReq(sessionId, data.id);
        return json(200, { ok: true, id: data.id });
    });
}
