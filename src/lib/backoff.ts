/**
 * Пауза фолбэк-поллинга версии стейта: основной канал прод-синхронизации —
 * SSE /api/events (свой lab-sync); поллинг включается только когда SSE не
 * держится (см. App.tsx → useAgentSync и API.md «Прод»).
 *
 * База 3 с: канал только что упал — агентский PUT доходит быстро. Неудачный
 * тик (сеть/429/5xx) удваивает паузу до потолка 30 с; успешный ответ
 * (включая 404 «стейта нет») сбрасывает счётчик — поллинг возвращается к базе.
 */
export const PROD_POLL_BASE_MS = 3_000;
export const PROD_POLL_MAX_MS = 30_000;

/** Задержка следующего тика после `failures` неудач подряд. */
export function pollDelayMs(failures: number): number {
    return Math.min(PROD_POLL_MAX_MS, PROD_POLL_BASE_MS * 2 ** failures);
}
