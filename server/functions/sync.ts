import { configured, notConfigured, putAsset, writeStateVersion } from '../kv.ts';
import {
    json,
    parseStateWithAssets,
    readJsonBody,
    requireMutationAuth,
    route,
    sessionFromRequest,
} from '../rest.ts';

/**
 * POST /api/sync (прод-аналог dev POST /api/__sync) — браузер присылает свой
 * стейт (debounce 300ms) в слот своей сессии (X-Lab-Session из sessionStorage;
 * несуществующая создаётся лениво). Тело — {state, assets?} (транспортный вид:
 * картинки-dataURL вынесены в словарь, в стейте — ссылки asset:sha256-*,
 * браузер готовит вид в lib/agentTransport) или голый BlockState (dev-стиль,
 * инлайн-картинки сервер вынесет сам). Ассеты кладутся SETNX до записи слота —
 * каждая уникальная картинка пишется в KV один раз. Ответ {ok, version} —
 * браузер запоминает «моя версия», чтобы поллинг не возвращал её же обратно
 * (эхо-петли нет: sync ничего не броадкастит). Ответ дополнительно несёт
 * заявки агента, записанные ДО синка (analysisRequest/sweepRequest/notify —
 * форма полей как у GET /api/state?since): гонка «заявка в версии N, синк
 * делает N+1» — вер-тик полла (ver <= since) заявку уже никогда не отдаст,
 * иначе заявка оставалась бы невидимой для браузера навсегда.
 */
export async function POST(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const sessionId = sessionFromRequest(req);
        const body = parseStateWithAssets(await readJsonBody(req));
        if (body.assets !== undefined) {
            for (const [hash, dataUrl] of Object.entries(body.assets)) await putAsset(hash, dataUrl);
        }
        const { version, pending } = await writeStateVersion(sessionId, body.state);
        // симметрично сериализации GET /api/state?since (server/functions/state.ts):
        // поля добавляются только при наличии незакрытых заявок/непоказанного notify
        const reqField =
            typeof pending?.analysisReq === 'string' ? { analysisRequest: pending.analysisReq } : {};
        const sweepField = pending?.sweepReq === undefined ? {} : { sweepRequest: pending.sweepReq };
        const notifyField = pending?.notify === undefined ? {} : { notify: pending.notify };
        return json(200, { ok: true, version, ...reqField, ...sweepField, ...notifyField });
    });
}
