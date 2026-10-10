/**
 * Пауза прод-поллинга версии стейта (SSE на проде нет; см. App.tsx →
 * useAgentSync и API.md «Прод (Vercel)»).
 *
 * База 10 с: полл-тик = ровно 1 команда Upstash (get lab:state — версия,
 * стейт и заявка analysisReq в одном ключе), активная вкладка 8 ч тратит
 * ~2 880 команд — free-тариф Upstash (10k/день) хватает с запасом.
 * Неудачный тик (429/502/5xx от квоты или сбоя Upstash, сеть) удваивает
 * паузу до потолка 60 с; успешный ответ (включая 404 «стейта нет»)
 * сбрасывает счётчик — поллинг сам возвращается к базе после сброса квоты.
 */
export const PROD_POLL_BASE_MS = 10_000;
export const PROD_POLL_MAX_MS = 60_000;

/** Задержка следующего тика после `failures` неудач подряд. */
export function pollDelayMs(failures: number): number {
    return Math.min(PROD_POLL_MAX_MS, PROD_POLL_BASE_MS * 2 ** failures);
}
