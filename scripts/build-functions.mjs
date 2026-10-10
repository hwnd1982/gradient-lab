/**
 * Сборка прод-функций Vercel: server/functions/*.ts → api/*.js —
 * самодостаточные ESM-бандлы (zod + src/schema + server/{kv,rest} инлайнятся,
 * внешних рантайм-импортов нет). Нужно потому, что @vercel/node НЕ бандлит
 * локальные импорты (компилирует api/ пофайлово, .ts-источники вне api/ в
 * /var/task не попадают) — «сырой» import '../src/schema' на проде =
 * ERR_MODULE_NOT_FOUND. Vercel сканирует api/ ПОСЛЕ buildCommand, поэтому
 * шаг висит в `npm run build`.
 *
 * Бандлер — rolldown из дерева (собственный бандлер vite 8; esbuild в проекте
 * отсутствует, новых зависимостей не добавляем). Опции аналогичны
 * esbuild-набору {bundle, platform:'node', format:'esm'}; явного target нет —
 * исходники es2023, Node 20 покрывает без даунлевела. api/ — генерат,
 * источников там нет; скрипт пересоздаёт папку целиком — идемпотентен и не
 * оставляет устаревших файлов.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { rolldown } from 'rolldown';

const ROOT = new URL('..', import.meta.url).pathname;
const API_DIR = `${ROOT}api`;

/** Явный список: вход в server/functions → outfile в api/ (роуты Vercel). */
const FUNCTIONS = [
    { in: 'state', out: 'state.js' },
    { in: 'sync', out: 'sync.js' },
    { in: 'warnings', out: 'warnings.js' },
    { in: 'analysis', out: 'analysis.js' },
    { in: 'journal', out: 'journal.js' },
    { in: 'presets', out: 'presets.js' },
    // бывший api/presets/[name].ts — динамический роут, имя парсит из URL
    { in: 'presets-name', out: 'presets/[name].js' },
    { in: 'schema', out: 'schema.js' },
    { in: 'sweep', out: 'sweep.js' },
    // бывший api/sweep/[id].ts — path-параметр через контекст Vercel
    { in: 'sweep-id', out: 'sweep/[id].js' },
    { in: 'sessions', out: 'sessions.js' },
    // api/sessions/[id].js — PUT (создать/переименовать) и DELETE слота
    { in: 'sessions-id', out: 'sessions/[id].js' },
    { in: 'methodology', out: 'methodology.js' },
    { in: 'ping', out: 'ping.js' },
];

await rm(API_DIR, { recursive: true, force: true });
await mkdir(API_DIR, { recursive: true });

for (const fn of FUNCTIONS) {
    const input = `${ROOT}server/functions/${fn.in}.ts`;
    const outfile = `${API_DIR}/${fn.out}`;
    const build = await rolldown({ input, platform: 'node' });
    try {
        const { output } = await build.generate({ format: 'esm' });
        const chunks = output.filter((c) => c.type === 'chunk');
        const code = chunks[0]?.code ?? '';
        // самодостаточность: один чанк и ни одного внешнего импорта
        const external = chunks[0]?.imports ?? [];
        if (chunks.length !== 1 || external.length > 0 || code === '') {
            throw new Error(
                `${fn.in}: ожидался 1 самодостаточный чанк, получил ${chunks.length} чанк(ов), внешние импорты: [${external.join(', ')}]`
            );
        }
        await mkdir(outfile.slice(0, outfile.lastIndexOf('/')), { recursive: true });
        await writeFile(outfile, code);
        console.log(`api/${fn.out}  (${(code.length / 1024).toFixed(1)} KiB)`);
    } finally {
        await build.close();
    }
}
