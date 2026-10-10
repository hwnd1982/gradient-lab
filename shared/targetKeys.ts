/**
 * Общие чистые хелперы Agent API для dev (vite-plugins/agent-api.ts) и прода
 * (api/*.ts): канонизация таргетов анализа и санитизация имён пресетов.
 *
 * Валидные ключи ?target= — единый источник: 400-ответ (known) и список в
 * разделе API.md «GET /api/analysis» держать синхронным с этим массивом.
 * 'layer:<index>' — шаблон; канонический ключ — 'layer:N' без ведущих нулей.
 */
export const KNOWN_TARGET_KEYS = [
    'base',
    'blockMask',
    'blurMask',
    'blurBg',
    'underlay',
    'clipText',
    'animFrom',
    'animTo',
    'layer:<index>',
] as const;

/**
 * Валидный ?target= → канонический ключ (текстом: сервер только валидирует и
 * передаёт, разбор в таргет делает приложение). 'mask' — алиас blockMask,
 * числовой суффикс layer нормализуется (layer:007 → layer:7).
 */
export function canonicalTargetKey(raw: string): string | null {
    if (raw === 'mask') return 'blockMask';
    if ((KNOWN_TARGET_KEYS as readonly string[]).includes(raw)) return raw;
    const m = raw.match(/^layer:(\d+)$/);
    if (m !== null) return `layer:${Number(m[1])}`;
    return null;
}

/** 'мой пресет!.json' -> 'my-preset-' безопасное имя (латиница, цифры, _ и -). */
export function sanitizeName(raw: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return null; // malformed %-последовательность (напр. '%zz')
    }
    return decoded
        .replace(/\.json$/i, '')
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .replace(/^-+|-+$/g, '');
}
