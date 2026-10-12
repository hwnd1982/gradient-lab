/**
 * Раннер тестов без зависимостей: каждый tests/*.test.mjs исполняется как
 * ESM-модуль (сторона эффектов), экспортирует live-binding счётчики
 * {total, failed}. Раннер суммирует и ставит exitCode.
 *
 * Импорт TS-хендлеров — через jiti (уже в дереве: транзитивная зависимость
 * vite@8 для загрузки vite.config.ts; api/*.ts при этом используют .ts-
 * расширения, а src/store.ts — extensionless-импорты, нативный strip-types
 * их не резолвит). jiti-мок-подход: global.fetch подменяется на in-memory
 * Upstash REST (Map) — см. prod-api.test.mjs.
 */
import { pathToFileURL } from 'node:url';

const FILES = [
    './prod-api.test.mjs',
    './sync-gate.test.mjs',
    './analysis.test.mjs',
    './sweep-path.test.mjs',
    './gray-compare.test.mjs',
];

let total = 0;
let failed = 0;
for (const file of FILES) {
    const url = pathToFileURL(new URL(file, import.meta.url).pathname).href;
    const m = await import(url);
    total += m.total ?? 0;
    failed += m.failed ?? 0;
}

console.log(
    `\n${total - failed}/${total} проверок прошли${failed > 0 ? `, УПАЛО: ${failed}` : ''}`
);
if (failed > 0 || total === 0) process.exitCode = 1;
