import { z } from 'zod';
import { configured, deleteSession, notConfigured, upsertSession } from '../kv.ts';
import {
    HttpError,
    json,
    readJsonBody,
    requireMutationAuth,
    route,
    SESSION_ID_RE,
} from '../rest.ts';

/** id из пути /api/sessions/<id> (catch-all роутер). */
function sessionIdFromUrl(req: Request): string {
    const segments = new URL(req.url, 'http://localhost').pathname.replace(/^\/+|\/+$/g, '').split('/');
    return segments[2] ?? '';
}

/** id с валидацией; невалидный — HttpError 400 (формат как у X-Lab-Session). */
async function sessionId(req: Request): Promise<string> {
    const id = sessionIdFromUrl(req);
    if (!SESSION_ID_RE.test(id)) {
        throw new HttpError(400, {
            error: `невалидный id сессии «${id}»: допустимы [a-zA-Z0-9_-], 1..64 символа`,
        });
    }
    return id;
}

const SessionPutSchema = z.object({ name: z.string().min(1).max(64) });

/**
 * PUT /api/sessions/<id> тело {name} — создать сессию (пустой слот) или
 * переименовать существующую. Под requireMutationAuth, как прочие мутации.
 * Создать слот можно и просто обратившись к любому эндпоинту с заголовком
 * X-Lab-Session: <id> (лениво) — PUT нужен ради осмысленного имени в списке.
 */
export async function PUT(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const id = await sessionId(req);
        const parsed = SessionPutSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
            return json(400, {
                error: 'тело {name}: строка 1..64 символа',
                issues: parsed.error.issues,
            });
        }
        await upsertSession(id, parsed.data.name);
        return json(200, { ok: true, id, name: parsed.data.name });
    });
}

/**
 * DELETE /api/sessions/<id> — удалить слот целиком: стейт, счётчик версий,
 * warnings, analysis и заявки (analysisReq/sweepReq жили в слоте). Единственная
 * операция, требующая существования сессии (404). Под requireMutationAuth.
 */
export async function DELETE(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const id = await sessionId(req);
        if (!(await deleteSession(id))) {
            return json(404, { error: `сессия ${id} не найдена` });
        }
        return json(200, { ok: true, id });
    });
}
