import { ASSET_HASH_RE } from '../../shared/assets.ts';
import { configured, getAsset, notConfigured, putAsset } from '../kv.ts';
import { HttpError, json, readBody, requireMutationAuth, route } from '../rest.ts';

/**
 * hash ассета: из пути /api/asset/<hash> (на проде многосегментный путь
 * приходит сюда через rewrite vercel.json в query — УРОК P0) или напрямую из
 * query ?hash=. Поддерживаются ОБЕ формы; остальное — 400.
 */
function hashFromRequest(req: Request): string {
    const segments = new URL(req.url, 'http://localhost').pathname
        .replace(/^\/+|\/+$/g, '')
        .split('/');
    const pathHash = segments[1] === 'asset' ? segments[2] : undefined;
    const hash = pathHash ?? new URL(req.url, 'http://localhost').searchParams.get('hash');
    if (hash === null || hash === undefined || !ASSET_HASH_RE.test(hash)) {
        throw new HttpError(400, {
            error: 'невалидный hash: ожидается sha256-<64 hex lowercase> (см. контракт ассетов в API.md)',
        });
    }
    return hash;
}

/**
 * GET /api/asset/<hash> — dataURL картинки стейта по ассет-ссылке
 * "asset:sha256-<hex>" (см. «Ассеты картинок» в API.md). Ответ — JSON
 * {dataURL}; 404 — ассета нет (микро-ответ). Чтение открыто, как у остального
 * API. Сами ассеты пишет сервер при записи стейта (SETNX) — агенту этот
 * эндпоинт нужен только чтобы разглядеть кадр.
 */
export async function GET(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const hash = hashFromRequest(req);
        const dataUrl = await getAsset(hash);
        if (dataUrl === null) return json(404, { error: `ассет ${hash} не найден` });
        return json(200, { dataURL: dataUrl });
    });
}

/**
 * PUT /api/asset/<hash> — положить dataURL (тело — сырая dataURL-строка)
 * с SETNX-семантикой: существующий ассет не перезаписывается. Хэш сверяется
 * с телом. Мутация — Authorization: Bearer при заданном LAB_API_TOKEN.
 */
export async function PUT(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const hash = hashFromRequest(req);
        await putAsset(hash, await readBody(req));
        return json(200, { ok: true, hash });
    });
}
