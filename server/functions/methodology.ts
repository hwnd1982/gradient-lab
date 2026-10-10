import { METHODOLOGY } from '../../src/lib/methodology.ts';
import { json, route } from '../rest.ts';

/**
 * GET /api/methodology — методика подгонки v2 (исполняемая процедура F0–F6)
 * из одного места: src/lib/methodology.ts — тот же ответ отдаёт dev-middleware.
 * Формат: {version: 2, phases: [{id, title, actions[], exit}], invariants[],
 * text} — text это та же процедура одним блоком. Upstash не нужен: работает
 * всегда, даже без env (503-контракт на остальные прод-функции не влияет).
 */
export async function GET(): Promise<Response> {
    return route(async () => json(200, METHODOLOGY));
}
