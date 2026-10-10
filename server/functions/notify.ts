import { NotifySchema } from '../../src/schema.ts';
import { configured, notConfigured, setNotify } from '../kv.ts';
import { json, readJsonBody, requireMutationAuth, route, sessionFromRequest } from '../rest.ts';

/** Тело POST /api/notify: текст сообщения (ts присваивает сервер). */
const NotifyPostSchema = NotifySchema.pick({ text: true });

/**
 * POST /api/notify — короткий статус агенту → юзеру (тост «Агент: <text>» в
 * браузере той же сессии). Пишется в слот lab:s/<id> (X-Lab-Session, default
 * 'default'; одно последнее сообщение — новое перезаписывает старое), браузер
 * забирает его поллом GET /api/state?since= (поле notify). Не чат: агент
 * уведомляет по завершении значимого шага/всей подгонки, не на каждую
 * итерацию. Мутация — Authorization: Bearer при заданном LAB_API_TOKEN.
 */
export async function POST(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const sessionId = sessionFromRequest(req);
        const parsed = NotifyPostSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
            return json(400, { error: 'invalid notify payload', issues: parsed.error.issues });
        }
        const ts = await setNotify(sessionId, parsed.data.text);
        return json(200, { ok: true, ts });
    });
}
