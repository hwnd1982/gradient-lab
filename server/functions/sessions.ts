import { configured, notConfigured, sessionIndex } from '../kv.ts';
import { json, route } from '../rest.ts';

/**
 * GET /api/sessions — список сессий (открыто; Upstash-ключ lab:sessions,
 * cap 50 — при переполнении выкидываются самые неактивные). Формат:
 * {sessions: [{id, name, updatedAt}]} — новые сверху. Источник для селектора
 * хедера приложения и для агентов, выбирающих свой слот доски
 * (X-Lab-Session, см. API.md «Сессии»).
 */
export async function GET(): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        return json(200, { sessions: await sessionIndex() });
    });
}
