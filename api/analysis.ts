import { AnalysisPostSchema } from '../src/schema.ts';
import { canonicalTargetKey, KNOWN_TARGET_KEYS } from '../shared/targetKeys.ts';
import {
    clearAnalysisReq,
    configured,
    kvDelete,
    kvReadJson,
    kvWriteJson,
    K,
    notConfigured,
    setAnalysisReq,
} from '../server/kv.ts';
import { json, readJsonBody, requireMutationAuth, route } from '../server/rest.ts';

/** Кэш анализа: полный Analysis или маркер — у обоих есть поле target. */
interface StoredAnalysis {
    target?: unknown;
    [key: string]: unknown;
}

/**
 * GET /api/analysis(?target=<key>) — последний diff-анализ. Без ?target —
 * последний посчитанный. С ?target: кэш валиден только при совпадении target;
 * на промахе заявка пишется в analysisReq того же ключа lab:state (браузер
 * забирает её поллингом GET /api/state?since и пересчитывает, POST стирает) —
 * агент повторяет GET раз в ~5 с, пока не придёт ответ с этим target (в dev то
 * же делал SSE). Промах — это запись, поэтому при заданном LAB_API_TOKEN он
 * требует Bearer, как остальные агентские мутации (анти-спам заявок).
 */
export async function GET(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const targetParam = new URL(req.url).searchParams.get('target');
        const stored = await kvReadJson<StoredAnalysis>(K.analysis);

        if (targetParam === null) {
            if (stored === null) {
                return json(404, {
                    error: 'анализа ещё нет: загрузите референс в браузере (секция «Сравнение с макетом») — приложение пришлёт POST /api/analysis',
                });
            }
            return json(200, stored);
        }

        const key = canonicalTargetKey(targetParam);
        if (key === null) {
            return json(400, {
                error: `неизвестный target «${targetParam}»`,
                known: KNOWN_TARGET_KEYS,
            });
        }
        if (stored !== null && stored.target === key) {
            return json(200, stored);
        }
        requireMutationAuth(req);
        // заявка — только через хелпер: inline-запись стирала бы чужую sweep-заявку
        await setAnalysisReq(key);
        return json(404, {
            error: `анализ для target=${key} запрошен у приложения (заявка analysisReq в lab:state, браузер подхватит поллингом ≤10 с); повторите GET через ~5 с, пока ответ не придёт с этим target`,
            requested: key,
        });
    });
}

/**
 * POST /api/analysis (прод-аналог dev POST /api/__analysis) — браузер шлёт
 * diff-анализ/маркер (debounce ~500ms). {"cleared":true} — референс убрали:
 * кэш сбрасываем, старьё не отдаём (заявку не трогаем — если агент ждёт
 * таргет, она разрулится маркером blocked:'no-reference').
 */
export async function POST(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const parsed = AnalysisPostSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
            return json(400, { error: 'invalid Analysis payload', issues: parsed.error.issues });
        }
        if ('cleared' in parsed.data) {
            await kvDelete(K.analysis);
            return json(200, { ok: true });
        }
        await kvWriteJson(K.analysis, parsed.data);
        // свежий анализ (или маркер) закрывает заявку: стираем analysisReq;
        // заявку sweep не трогаем — она ждёт исполнения приложения
        await clearAnalysisReq();
        return json(200, { ok: true });
    });
}
