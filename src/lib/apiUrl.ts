/**
 * Единая точка формирования URL запросов к Agent API: путь с /api-префиксом
 * ('/api/state?since=1') остаётся same-origin, либо префикс /api заменяется
 * на базу env VITE_SYNC_BASE (например 'https://sync.lkv.net.ru/api' —
 * standalone-сервис lab-sync вместо Upstash+Vercel; база уже включает /api).
 * Не задан — поведение прежнее: dev — vite-middleware, прод — Vercel-функции.
 */
const SYNC_BASE = (import.meta.env.VITE_SYNC_BASE ?? '').replace(/\/+$/, '');

export function apiUrl(path: string): string {
    return SYNC_BASE === '' ? path : SYNC_BASE + path.slice('/api'.length);
}
