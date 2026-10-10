import { BlockStateSchema } from '../src/schema';
import type { BlockState } from '../src/schema';

/** Лимит тела запроса — как в dev-middleware. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Управляемый отказ (ловится wrapper'ом route в каждой функции). */
export class HttpError extends Error {
    readonly status: number;
    readonly payload: unknown;

    constructor(status: number, payload: unknown) {
        super(`HTTP ${status}`);
        this.status = status;
        this.payload = payload;
    }
}

export function json(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
}

/** Общий wrapper: HttpError → его код/тело, прочее — 500. */
export async function route(fn: () => Promise<Response>): Promise<Response> {
    try {
        return await fn();
    } catch (err) {
        if (err instanceof HttpError) return json(err.status, err.payload);
        return json(500, { error: String(err) });
    }
}

/** Тело запроса с лимитом 10 МБ (аналог readBody dev-middleware). */
export async function readBody(req: Request): Promise<string> {
    const text = await req.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
        throw new HttpError(413, { error: 'тело запроса больше 10 МБ' });
    }
    return text;
}

/** Тело запроса → JSON; 400 при невалидном JSON. */
export async function readJsonBody(req: Request): Promise<unknown> {
    const raw = await readBody(req);
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        throw new HttpError(400, { error: 'тело запроса не является JSON' });
    }
}

/** Значение → валидный BlockState; при ошибке кидает HttpError(400). */
export function parseStateBody(value: unknown): BlockState {
    const parsed = BlockStateSchema.safeParse(value);
    if (!parsed.success) {
        throw new HttpError(400, { error: 'invalid BlockState', issues: parsed.error.issues });
    }
    return parsed.data;
}

/**
 * Мутации можно закрыть токеном: env LAB_API_TOKEN (сервер) + VITE_LAB_TOKEN
 * (клиент, тот же токен). Не задан — авторизация выключена. Нет заголовка —
 * 401, неверный токен — 403. Чтение (GET) открыто всегда.
 */
export function requireMutationAuth(req: Request): void {
    const token = process.env.LAB_API_TOKEN;
    if (typeof token !== 'string' || token === '') return;
    const auth = req.headers.get('authorization');
    if (auth === null || !auth.startsWith('Bearer ')) {
        throw new HttpError(401, {
            error: 'мутации требуют Authorization: Bearer <LAB_API_TOKEN>',
        });
    }
    if (auth.slice('Bearer '.length) !== token) {
        throw new HttpError(403, { error: 'неверный токен' });
    }
}
