import { z } from 'zod';
import type { BlockState } from '../../src/schema.ts';
import { BlockStateSchema } from '../../src/schema.ts';
import { configured, notConfigured, writeStateVersion } from '../kv.ts';
import { json, readJsonBody, requireMutationAuth, route, sessionFromRequest } from '../rest.ts';

/**
 * Тело POST /api/sync: {state: BlockState} (браузер на проде) или голый
 * BlockState (как в dev — на случай вызова в стиле dev-цикла).
 */
const SyncBodySchema = z.union([z.object({ state: BlockStateSchema }), BlockStateSchema]);

/**
 * POST /api/sync (прод-аналог dev POST /api/__sync) — браузер присылает свой
 * стейт (debounce 300ms) в слот своей сессии (X-Lab-Session из sessionStorage;
 * несуществующая создаётся лениво). Сервер сам инкрементит версию и пишет;
 * ответ {ok, version} — браузер запоминает «моя версия», чтобы поллинг не
 * возвращал её же обратно (эхо-петли нет: sync ничего не броадкастит).
 */
export async function POST(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const sessionId = sessionFromRequest(req);
        const parsed = SyncBodySchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
            return json(400, { error: 'invalid BlockState', issues: parsed.error.issues });
        }
        const state: BlockState = 'state' in parsed.data ? parsed.data.state : parsed.data;
        const version = await writeStateVersion(sessionId, state);
        return json(200, { ok: true, version });
    });
}
