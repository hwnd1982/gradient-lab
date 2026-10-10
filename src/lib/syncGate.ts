/**
 * Решение для подписки стейта в useAgentSync: синкать ли браузерный стейт на
 * сервер в этом тике. Транзиентные значения sweep НЕ синкаются — иначе каждый
 * шаг перебора уходит на сервер лишними командами/версиями, а в окне debounce
 * GET /api/state отдаёт последнее sweep-значение вместо восстановленного.
 * Завершение sweep (sweeping → false при том же стейте) — досылаем финальный
 * контент: восстановленный радиус, а при abort — правку юзера, случившуюся
 * во время перебора (её тик тоже был загашен гейтом).
 */
export interface SyncGateSnapshot {
    state: unknown;
    sweeping: boolean;
}

export function shouldSendSync(s: SyncGateSnapshot, prev: SyncGateSnapshot): boolean {
    if (s.sweeping) return false;
    if (s.state === prev.state) return prev.sweeping;
    return true;
}
