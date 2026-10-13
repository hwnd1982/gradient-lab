import { configured, ensureSession, K, kvReadJson, notConfigured, putAsset, writeStateVersion } from '../kv.ts';
import {
    HttpError,
    json,
    parseStateWithAssets,
    readJsonBody,
    requireMutationAuth,
    route,
    sessionFromRequest,
} from '../rest.ts';

/**
 * GET /api/state — текущий стейт сессии (X-Lab-Session, default 'default';
 * несуществующая сессия создаётся лениво — пустой стейт). Без ?since — голый
 * BlockState (как в dev; картинки — asset-ссылками, см. «Ассеты картинок» в
 * API.md), 404 пока ничего не синкалось. С ?since=N — поллинг-контракт с
 * вер-тиком: СНАЧАЛА читается только микро-ключ lab:s/<id>/ver (~16 байт);
 * не свежее N — ответ {version: N, unchanged: true} БЕЗ чтения слота (пустой
 * тик = 1 команда); свежее (или микро-ключа нет — легаси-слот до деплоя) —
 * слот читается целиком: {version, state} при version > N, иначе
 * {version: N, unchanged: true} (не 404). Попутно analysisRequest/sweepRequest
 * — заявки агента и notify — тост; заявки и notify инкрементят версию, поэтому
 * вер-тик их замечает и читает слот (заявки в лёгком слоте — чтение дёшево).
 */
export async function GET(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const sessionId = sessionFromRequest(req);
        const sinceRaw = new URL(req.url, 'http://localhost').searchParams.get('since');
        if (sinceRaw !== null) {
            const since = Number(sinceRaw);
            if (!Number.isInteger(since) || since < 0) {
                throw new HttpError(400, { error: '?since должен быть неотрицательным целым' });
            }
            // вер-тик: пустой тик не читает слот (экономия bandwidth Upstash)
            const ver = await kvReadJson<number>(K.statever(sessionId));
            if (ver !== null && Number.isInteger(ver) && ver <= since) {
                return json(200, { version: since, unchanged: true });
            }
        }
        const stored = await ensureSession(sessionId);
        const state = stored.state !== null ? stored.state : null;
        const version = Number.isInteger(stored.version) ? stored.version : null;
        const analysisRequest =
            typeof stored.analysisReq === 'string' ? stored.analysisReq : undefined;
        const reqField = analysisRequest === undefined ? {} : { analysisRequest };
        const sweepField = stored.sweepReq === undefined ? {} : { sweepRequest: stored.sweepReq };
        const notifyField = stored.notify === undefined ? {} : { notify: stored.notify };

        if (sinceRaw === null) {
            if (state === null || version === null) {
                return json(404, {
                    error: 'стейт ещё не синкался: откройте приложение в браузере (оно шлёт POST /api/sync) или положите свой через PUT /api/state',
                });
            }
            return json(200, state);
        }
        const since = Number(sinceRaw);
        if (state !== null && version !== null && version > since) {
            return json(200, { version, state, ...reqField, ...sweepField, ...notifyField });
        }
        return json(200, {
            version: since,
            unchanged: true,
            ...reqField,
            ...sweepField,
            ...notifyField,
        });
    });
}

/**
 * PUT /api/state — положить стейт в сессию. Тело — BlockState (картинки можно
 * инлайн-dataURL — сервер сам вынесет их в ассет-ключи) или транспортный вид
 * {state, assets} (заявки от браузера/симметрия с POST /api/sync). Валидация
 * zod → ассеты SETNX → INCR версии → запись лёгкого слота.
 */
export async function PUT(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const sessionId = sessionFromRequest(req);
        const body = parseStateWithAssets(await readJsonBody(req));
        // ассеты — ДО записи слота: ссылки из слота сразу резолвятся
        if (body.assets !== undefined) {
            for (const [hash, dataUrl] of Object.entries(body.assets)) await putAsset(hash, dataUrl);
        }
        // pending (заявки агента до записи) здесь не нужен: агентский PUT не
        // доставляет заявки браузеру — их забирает полл/синк
        const { version } = await writeStateVersion(sessionId, body.state);
        return json(200, { ok: true, version });
    });
}
