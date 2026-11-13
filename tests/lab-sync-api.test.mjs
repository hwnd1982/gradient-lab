/**
 * Контрактный тест lab-sync (~/its/lab-sync/app.mjs) по HTTP — порт
 * прежде удалённого теста прод-API (jiti-импорт хендлеров + мок KV) на
 * реальный standalone-сервер: спавним node app.mjs на случайном порте с
 * LAB_SYNC_DATA во временной папке, готовность — полл GET /api/schema.
 * Контракт — API.md; имена проверок и русский стиль — как в оригинале.
 *
 * Отличия порта: внутренние проверки мок-KV (kv.get/kv.has, счётчики команд
 * хранилища, 503-без-env) заменены наблюдаемыми эквивалентами через HTTP
 * (sync-ответ несёт заявки, полл since= несёт fields) или отброшены — см.
 * комментарии «адаптация:»/«отброшено:» у блоков. Токен-режим и миграция
 * легаси-ключей проверяются на отдельных инстансах сервера (env только на
 * старте; миграция предсеется снапшотом LAB_SYNC_DATA).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP = join(ROOT, '..', 'lab-sync', 'app.mjs');
const jiti = createJiti(import.meta.url);

export let total = 0;
export let failed = 0;
// lab-sync — отдельный репо вне этого чекаута (в CI его нет): сьют
// пропускается — сервер не поднимается, failed не трогается, раннер зелёный
const HAS_APP = existsSync(APP);
const SKIP_SUITE = Symbol('lab-sync отсутствует');
if (!HAS_APP) {
    total += 1;
    console.log('пропущено: нет ~/its/lab-sync/app.mjs');
}
function check(name, cond, extra = '') {
    total += 1;
    if (cond) console.log(`ok   ${name}`);
    else {
        failed += 1;
        console.error(`FAIL ${name} ${extra}`);
    }
}
const body = async (r) => ({ status: r.status, json: await r.json() });
const H = (id) => ({ 'X-Lab-Session': id });

// ── лифцикл сервера: spawn + полл готовности + teardown (tmp-папка) ──
let portSeq = 0;
async function startServer({ token = '', seed = null } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'lab-sync-test-'));
    const dataFile = join(dir, 'state.json');
    if (seed !== null) writeFileSync(dataFile, JSON.stringify(seed));
    const port = 20000 + ((process.pid + portSeq++) % 9000);
    const child = spawn(process.execPath, [APP], {
        env: {
            ...process.env,
            LAB_SYNC_PORT: String(port),
            LAB_SYNC_DATA: dataFile,
            LAB_API_TOKEN: token,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
    });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 5000;
    for (;;) {
        try {
            if ((await fetch(`${base}/api/schema`)).status === 200) break;
        } catch {
            /* ещё не слушает */
        }
        if (Date.now() > deadline) {
            child.kill('SIGKILL');
            rmSync(dir, { recursive: true, force: true });
            throw new Error(`сервер lab-sync не поднялся на ${base}`);
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    const stop = () =>
        new Promise((resolve) => {
            child.once('exit', () => {
                rmSync(dir, { recursive: true, force: true });
                resolve();
            });
            child.kill('SIGTERM');
        });
    return { base, stop };
}

// Хелпер запросов основного инстанса (base фиксируется после старта).
let BASE = '';
async function call(method, path, payload, headers = {}, rawBody = undefined) {
    const opts = { method, headers };
    if (rawBody !== undefined) opts.body = rawBody;
    else if (payload !== undefined) opts.body = JSON.stringify(payload);
    return fetch(`${BASE}${path}`, opts);
}

// ── основной инстанс: без токена, чистое хранилище ──
const main = HAS_APP ? await startServer() : null;
let tokenSrv = null;
let migrateSrv = null;

try {
    if (main === null) throw SKIP_SUITE; // app.mjs нет — сьют пропущен (см. гард)
    BASE = main.base;
    const { MethodologySchema, AnalysisSchema, defaultBlockState } = await jiti.import(
        `${ROOT}src/schema.ts`
    );
    const state = defaultBlockState();

    // ── methodology: снапшот статикой (503-блок отброшен: у lab-sync нет env-гейта) ──
    {
        const meth = await body(await call('GET', '/api/methodology'));
        check('methodology: 200 и version 2', meth.status === 200 && meth.json.version === 2);
        const m = meth.json;
        check(
            'methodology: 7 фаз + инварианты + text',
            m.phases.length === 7 && m.invariants.length > 0 && m.text.length > 500
        );
        // адаптация: вместо dev-импорта — снапшот сервера против MethodologySchema
        const parsed = MethodologySchema.safeParse(m);
        check('methodology: снапшот проходит MethodologySchema', parsed.success);
        // отброшено: «methodology: 0 команд хранилища» — счётчик команд мока
    }

    // ── версии стейта: PUT / sync / since / unchanged / валидация ──
    {
        const p1 = await body(await call('PUT', '/api/state', state));
        check(
            'PUT state: version 1',
            p1.status === 200 && p1.json.version === 1,
            JSON.stringify(p1.json)
        );
        const p2 = await body(await call('PUT', '/api/state', state));
        check('PUT state: version 2 (INCR на каждую запись)', p2.json.version === 2);
        const s1 = await body(await call('POST', '/api/sync', { state }));
        check('sync {state}: version 3', s1.status === 200 && s1.json.version === 3);
        const s2 = await body(await call('POST', '/api/sync', state));
        check('sync голым стейтом: version 4 (совместимость dev-стиля)', s2.json.version === 4);

        const bare = await body(await call('GET', '/api/state'));
        check(
            'GET без since: голый BlockState (без обёртки version)',
            bare.status === 200 && bare.json.version === undefined && bare.json.base !== undefined
        );

        const changed = await body(await call('GET', '/api/state?since=3'));
        check(
            'GET since=3: {version:4, state} (changed)',
            changed.json.version === 4 && changed.json.state !== null && changed.json.unchanged !== true
        );
        const unchanged = await body(await call('GET', '/api/state?since=4'));
        check(
            'GET since=4: unchanged:true (не 404)',
            unchanged.json.version === 4 && unchanged.json.unchanged === true
        );

        const badSince = await body(await call('GET', '/api/state?since=abc'));
        check('GET since=abc: 400', badSince.status === 400);
        const negSince = await body(await call('GET', '/api/state?since=-1'));
        check('GET since=-1: 400', negSince.status === 400);

        const badJson = await body(await call('PUT', '/api/state', undefined, {}, '{"w":'));
        check('PUT битый JSON: 400', badJson.status === 400);
        const badState = await body(
            await call('PUT', '/api/state', { ...state, w: 'ширина' })
        );
        check(
            'PUT невалидный стейт: 400 + issues',
            badState.status === 400 && Array.isArray(badState.json.issues)
        );

        // легаси-плоский blur (до слоёв): парсер заворачивает в layers[0]
        const legacy = {
            ...state,
            blur: {
                enabled: true,
                radius: 10,
                background: null,
                mask: null,
                underlay: state.blur.underlay,
            },
        };
        const putLegacy = await body(await call('PUT', '/api/state', legacy));
        check('PUT легаси-плоский blur: 200 (миграция на лету)', putLegacy.status === 200);
        const gotLegacy = await body(await call('GET', '/api/state'));
        check(
            'GET после легаси-PUT: канонический слоевой формат',
            Array.isArray(gotLegacy.json.blur.layers) &&
                gotLegacy.json.blur.layers.length === 1 &&
                gotLegacy.json.blur.layers[0].radius === 10,
            JSON.stringify(gotLegacy.json.blur)
        );
    }

    // ── гонка вер-тика с синком: заявки агента до синка едут в ответе синка ──
    {
        // агент записал заявку анализа промахом target в версию N…
        await call('PUT', '/api/state', state, H('race'));
        const miss = await body(await call('GET', '/api/analysis?target=blurMask', undefined, H('race')));
        // адаптация: вместо kv — полл since=1 несёт заявку (версия выросла)
        const tick = await body(await call('GET', '/api/state?since=1', undefined, H('race')));
        check(
            'гонка: промах analysis-target записал заявку (версия N)',
            miss.status === 404 &&
                tick.json.version === 2 &&
                tick.json.analysisRequest === 'blurMask'
        );
        // …браузерный синк делает N+1: вер-тик полла заявку уже не отдаст —
        // ответ синка обязан нести её сам
        const s = await body(await call('POST', '/api/sync', { state }, H('race')));
        check(
            'гонка: ответ sync несёт analysisRequest (заявка до синка)',
            s.status === 200 && s.json.version === 3 && s.json.analysisRequest === 'blurMask'
        );
        check(
            'гонка: sweepRequest/notify в ответе sync отсутствуют',
            s.json.sweepRequest === undefined && s.json.notify === undefined
        );
        // чистый синк в сессии без заявок — только {ok, version}
        const clean = await body(await call('POST', '/api/sync', { state }, H('race-clean')));
        check(
            'чистый sync без заявок: полей заявок в ответе нет',
            clean.status === 200 &&
                clean.json.ok === true &&
                clean.json.version === 1 &&
                clean.json.analysisRequest === undefined &&
                clean.json.sweepRequest === undefined &&
                clean.json.notify === undefined
        );
    }

    // ── warnings: 404-cleared до синка, запись, cleared-семантика ──
    {
        const g0 = await body(await call('GET', '/api/warnings'));
        check('warnings: до POST — 404 {cleared:true}', g0.status === 404 && g0.json.cleared === true);
        const warn = {
            warnings: [{ code: 'blur-zero-radius', severity: 'warn', message: 'радиус 0' }],
        };
        await call('POST', '/api/warnings', warn);
        const g1 = await body(await call('GET', '/api/warnings'));
        check(
            'warnings: GET отдаёт список',
            g1.status === 200 &&
                g1.json.warnings.length === 1 &&
                g1.json.warnings[0].code === 'blur-zero-radius'
        );
        await call('POST', '/api/warnings', { cleared: true });
        const g2 = await body(await call('GET', '/api/warnings'));
        check(
            'warnings: cleared:true хранится как пусто (не отдаёт старьё)',
            g2.status === 200 && g2.json.cleared === true
        );
        const bad = await body(await call('POST', '/api/warnings', { warnings: [] }));
        check('warnings: пустой список (min 1) — 400', bad.status === 400);
    }

    // ── analysis: матчинг/алиасы/заявка/маркеры/cleared ──
    const analysis = AnalysisSchema.parse({
        matchPercent: 90,
        zoneMatchPercent: 95.5,
        maxError: 40,
        tolerance: 10,
        target: 'blurMask',
        profile: 'axis',
        axisSpace: 'blur.rect',
        zone: { x: 0, y: 60, w: 100, h: 40 },
        axis: [],
        transitions: [],
        suggestedStops: [],
        residuals: [{ pos: 50, err: 44, kind: 'blur' }],
        verdict:
            'остатки в blur-зоне: крутите радиус/стопы маски (топ-10: кромки 0, blur 6, уровень 2, приблизительно 0)',
        hint: 'Крути blur.radius и форму blur.mask',
        updatedAt: Date.now(),
    });
    {
        const g0 = await body(await call('GET', '/api/analysis'));
        check('analysis: без target и кэша — 404 «анализа ещё нет»', g0.status === 404);

        const alias = await body(await call('GET', '/api/analysis?target=mask'));
        check(
            'analysis: алиас mask → канонический blockMask',
            alias.status === 404 && alias.json.requested === 'blockMask'
        );
        // адаптация: заявка видна в ответе sync (sync заявку не стирает)
        const s1 = await body(await call('POST', '/api/sync', { state }));
        check('analysis: заявка analysisReq=blockMask (sync несёт)', s1.json.analysisRequest === 'blockMask');

        const zeros = await body(await call('GET', '/api/analysis?target=layer:007'));
        check(
            'analysis: layer:007 → канонический layer:7',
            zeros.status === 404 && zeros.json.requested === 'layer:7'
        );
        const s2 = await body(await call('POST', '/api/sync', { state }));
        check('analysis: заявка перезаписалась на layer:7', s2.json.analysisRequest === 'layer:7');

        const bogus = await body(await call('GET', '/api/analysis?target=bogus'));
        check(
            'analysis: неизвестный target — 400 + known',
            bogus.status === 400 && bogus.json.known.includes('blurMask')
        );

        const post = await body(await call('POST', '/api/analysis', analysis));
        check('analysis POST: полный анализ с hint — 200', post.status === 200);
        const s3 = await body(await call('POST', '/api/sync', { state }));
        check('analysis POST: свежий анализ стёр заявку', s3.json.analysisRequest === undefined);

        const hit = await body(await call('GET', '/api/analysis?target=blurMask'));
        const s4 = await body(await call('POST', '/api/sync', { state }));
        check(
            'analysis: кэш-матчинг по target — 200 без новой заявки',
            hit.status === 200 &&
                hit.json.zoneMatchPercent === 95.5 &&
                hit.json.hint === 'Крути blur.radius и форму blur.mask' &&
                s4.json.analysisRequest === undefined
        );
        const noParam = await body(await call('GET', '/api/analysis'));
        check(
            'analysis: без target — последний (кэш)',
            noParam.status === 200 && noParam.json.target === 'blurMask'
        );

        const marker = { target: 'underlay', blocked: 'no-reference' };
        await call('POST', '/api/analysis', marker);
        const gm = await body(await call('GET', '/api/analysis'));
        check(
            'analysis: маркер blocked кэшируется и отдаётся 200-м',
            gm.status === 200 && gm.json.blocked === 'no-reference' && gm.json.target === 'underlay'
        );

        await call('POST', '/api/analysis', { cleared: true });
        const gc = await body(await call('GET', '/api/analysis'));
        check('analysis: cleared:true сбросил кэш (404)', gc.status === 404);
        const badPost = await body(await call('POST', '/api/analysis', { target: 'x' }));
        check('analysis: ни анализ ни маркер — 400 (refine)', badPost.status === 400);
    }

    // ── sweep: заявка / полл / P1-промах / идемпотентность / результат ──
    {
        // к этому моменту кэш анализа стёрт (cleared) — промахи честные
        const miss = await body(await call('GET', '/api/analysis?target=blurBg'));
        const pre = await body(await call('POST', '/api/sync', { state }));
        check(
            'sweep-преамбула: промах blurBg оставил заявку',
            miss.status === 404 && pre.json.analysisRequest === 'blurBg'
        );

        const sw = await body(
            await call('POST', '/api/sweep', { field: 'blur.radius', from: 4, to: 20, steps: 6 })
        );
        const id = sw.json.id ?? '';
        check('sweep POST: 200 {id}', sw.status === 200 && typeof id === 'string' && id !== '');
        // адаптация: вместо чтения ключа KV — статус по id
        const pend = await body(await call('GET', `/api/sweep?id=${id}`));
        check('sweep POST: статус по id = pending', pend.status === 200 && pend.json.status === 'pending');
        // адаптация: заявки слота видны в changed-полле (стейт/версия не потеряны)
        const pollSweep = await body(await call('GET', `/api/state?since=${pre.json.version}`));
        check(
            'sweep POST: заявка sweepReq в слоте, analysisReq сохранён, стейт на месте',
            pollSweep.json.version === pre.json.version + 1 &&
                pollSweep.json.state !== null &&
                pollSweep.json.sweepRequest?.id === id &&
                pollSweep.json.analysisRequest === 'blurBg'
        );

        // P1: sweep-заявка переживает промах analysis-target
        const miss2 = await body(await call('GET', '/api/analysis?target=underlay'));
        const tickP1 = await body(await call('GET', `/api/state?since=${pollSweep.json.version}`));
        check(
            'P1: промах analysis-target не стёр sweep-заявку',
            miss2.status === 404 &&
                tickP1.json.analysisRequest === 'underlay' &&
                tickP1.json.sweepRequest?.id === id
        );
        // отброшено: «промах идемпотентен: 3 команды» — счётчик команд мока

        // cleared-совместимость: анализ/маркер и sync не затирают sweepReq
        await call('POST', '/api/analysis', { target: 'underlay', gradientMissing: true });
        const syncM = await body(await call('POST', '/api/sync', { state }));
        check('маркер анализа не стёр sweepReq', syncM.json.sweepRequest?.id === id);
        const syncB = await body(await call('POST', '/api/sync', { state }));
        check(
            'sync браузера не стёр sweepReq (версия выросла)',
            syncB.json.version === syncM.json.version + 1 && syncB.json.sweepRequest?.id === id
        );

        // полл-тик без изменений: {version, unchanged:true} без тела слота
        // (счётчики команд «1 команда»/«слот не читался» — специфика мока)
        const v = syncB.json.version;
        const poll1 = await body(await call('GET', `/api/state?since=${v}`));
        check(
            'полл unchanged: {version, unchanged:true} без тела слота',
            poll1.json.unchanged === true && poll1.json.version === v && poll1.json.state === undefined
        );
        const poll2 = await body(await call('GET', `/api/state?since=${v - 1}`));
        check(
            'полл changed: {version, state, sweepRequest}',
            poll2.json.version === v && poll2.json.state !== null && poll2.json.sweepRequest?.id === id
        );

        // результат по id: done, оба GET-варианта, заявка стёрта
        const results = [
            { value: 4, zoneMatchPercent: 91.2, maxError: 81 },
            { value: 10.4, zoneMatchPercent: 98.4, maxError: 19 },
        ];
        const done = await body(await call('POST', '/api/__sweep', { id, results }));
        check(
            'POST __sweep (rewrite → union-ветка результата): 200',
            done.status === 200 && done.json.ok === true
        );
        const g1 = await body(await call('GET', `/api/sweep?id=${id}`));
        check(
            'GET ?id=: done + таблица',
            g1.status === 200 &&
                g1.json.status === 'done' &&
                g1.json.results.length === 2 &&
                g1.json.results[1].zoneMatchPercent === 98.4
        );
        const g2 = await body(await call('GET', `/api/sweep/${id}`));
        check(
            'GET /<id>: тот же ответ',
            g2.status === 200 && g2.json.status === 'done' && g2.json.results.length === 2
        );
        // адаптация: стёртость заявки видна в changed-полле по версии ДО заявки
        const poll3 = await body(await call('GET', `/api/state?since=${pre.json.version}`));
        check(
            'после результата: полл без sweepRequest (заявка стёрта)',
            poll3.json.state !== null && poll3.json.sweepRequest === undefined
        );

        // abort-ветка: частичные results + причина
        const sw2 = await body(
            await call('POST', '/api/sweep', { field: 'blur.radius', from: 8, to: 14, steps: 2 })
        );
        const id2 = sw2.json.id;
        await call('POST', '/api/__sweep', {
            id: id2,
            results: [{ value: 8, zoneMatchPercent: 90, maxError: 40 }],
            aborted: 'state/таргет изменён вне sweep',
        });
        const ga = await body(await call('GET', `/api/sweep?id=${id2}`));
        check(
            'abort: status=aborted + причина + частичные results',
            ga.json.status === 'aborted' &&
                ga.json.aborted.includes('вне sweep') &&
                ga.json.results.length === 1
        );

        // ошибки
        check(
            'GET ?id=nope: 404',
            (await body(await call('GET', '/api/sweep?id=nope'))).status === 404
        );
        check(
            'POST неподдерживаемое поле: 400',
            (
                await body(
                    await call('POST', '/api/sweep', {
                        field: 'blur.opacity',
                        from: 1,
                        to: 2,
                        steps: 3,
                    })
                )
            ).status === 400
        );
        check(
            'POST steps вне 2..12: 400',
            (
                await body(
                    await call('POST', '/api/sweep', {
                        field: 'blur.radius',
                        from: 1,
                        to: 2,
                        steps: 99,
                    })
                )
            ).status === 400
        );
        check(
            '__sweep без results/aborted: 400 (refine)',
            (await body(await call('POST', '/api/__sweep', { id: 'x' }))).status === 400
        );
        check('GET без ?id: 400', (await body(await call('GET', '/api/sweep'))).status === 400);
        check(
            'GET /<id> битый id: 400',
            (await body(await call('GET', '/api/sweep/%zz'))).status === 400
        );
    }

    // ── ассеты картинок: лёгкий слот, roundtrip, SETNX-дедуп, заявки/notify ──
    const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
    const PNG_A =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const PNG_B =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const HASH_A = `sha256-${sha(PNG_A)}`;
    const HASH_B = `sha256-${sha(PNG_B)}`;
    {
        // агентский PUT с инлайн-dataURL: сервер выносит картинки — слот лёгкий
        const withImgs = {
            ...state,
            base: { ...state.base, kind: 'image', image: PNG_A },
            compare: { ...state.compare, refImage: PNG_A },
            stage: { ...state.stage, image: PNG_B },
        };
        const put = await body(await call('PUT', '/api/state', withImgs, H('img')));
        check('ассеты: PUT с инлайн-картинками — 200', put.status === 200);
        const got = await body(await call('GET', '/api/state', undefined, H('img')));
        // адаптация: вместо чтения слота KV — голый GET /api/state
        check(
            'ассеты: слот хранит asset-ссылки (refImage/base.image/stage.image)',
            got.status === 200 &&
                got.json.compare.refImage === `asset:${HASH_A}` &&
                got.json.base.image === `asset:${HASH_A}` &&
                got.json.stage.image === `asset:${HASH_B}`
        );
        check(
            'ассеты: GET /api/state отдаёт ссылки как есть',
            got.json.compare.refImage === `asset:${HASH_A}`
        );
        // отброшено: «дедуп — один ключ, каждый в KV» — внутренний KV
        // (функционально покрыт GET /api/asset обеих форм ниже)

        // /api/asset: обе формы (query — прод-rewrite из path, path — напрямую)
        const a1 = await body(await call('GET', `/api/asset?hash=${HASH_A}`));
        check('GET /api/asset?hash=: {dataURL}', a1.status === 200 && a1.json.dataURL === PNG_A);
        const a2 = await body(await call('GET', `/api/asset/${HASH_B}`));
        check(
            'GET /api/asset/<hash> (path-форма): {dataURL}',
            a2.status === 200 && a2.json.dataURL === PNG_B
        );
        const a404 = await body(
            await call('GET', `/api/asset/sha256-${sha('data:image/png;base64,NOPE')}`)
        );
        check('GET /api/asset несуществующего: 404', a404.status === 404);
        const aBad = await body(await call('GET', '/api/asset?hash=sha256-XX'));
        check('GET /api/asset битый hash: 400', aBad.status === 400);

        // PUT /api/asset: повторная загрузка существующего — 200 без перезаписи
        // (SENTINEL-проверка мока отброшена — внутренний KV)
        const putA = await body(
            await call('PUT', `/api/asset?hash=${HASH_A}`, undefined, {}, PNG_A)
        );
        check('PUT asset существующего: 200 (SETNX-скип)', putA.status === 200 && putA.json.ok === true);
        const reGet = await body(await call('GET', `/api/asset?hash=${HASH_A}`));
        check('SETNX-дедуп: кадр не изменился', reGet.json.dataURL === PNG_A);

        // PUT /api/asset: валидации нового ассета
        const freshHash = `sha256-${sha(PNG_B + '-другой-кадр')}`;
        const mismatch = await body(
            await call('PUT', `/api/asset?hash=${freshHash}`, undefined, {}, PNG_B)
        );
        check('PUT asset: хэш не сходится с телом — 400', mismatch.status === 400);
        const notData = await body(
            await call('PUT', `/api/asset?hash=sha256-${sha('zzz')}`, undefined, {}, 'zzz')
        );
        check('PUT asset: не dataURL — 400', notData.status === 400);
        const badHash = await body(await call('PUT', '/api/asset?hash=abc', undefined, {}, PNG_A));
        check('PUT asset: битый hash — 400', badHash.status === 400);

        // sync в транспортном виде {state, assets} (путь браузера)
        const PNG_C = 'data:image/png;base64,QkFTRTY0X0M=';
        const HASH_C = `sha256-${sha(PNG_C)}`;
        const syncRes = await body(
            await call(
                'POST',
                '/api/sync',
                {
                    state: { ...state, compare: { ...state.compare, refImage: `asset:${HASH_C}` } },
                    assets: { [HASH_C]: PNG_C },
                },
                H('img')
            )
        );
        check('sync {state, assets}: 200', syncRes.status === 200);
        // адаптация: вместо KV — GET ассета + голый GET стейта
        const assetC = await body(await call('GET', `/api/asset?hash=${HASH_C}`));
        const gotC = await body(await call('GET', '/api/state', undefined, H('img')));
        check(
            'sync: ассет из словаря доступен, ссылка в стейте прошла насквозь',
            assetC.status === 200 &&
                assetC.json.dataURL === PNG_C &&
                gotC.json.compare.refImage === `asset:${HASH_C}`
        );

        // notify инкрементирует версию — вер-тик полла замечает (наблюдаемо
        // как changed-полл: проверка счётчика версии слита с доставкой)
        const vNotify = syncRes.json.version;
        await call('POST', '/api/notify', { text: 'кадры на месте' }, H('img'));
        const tickNotify = await body(
            await call('GET', `/api/state?since=${vNotify}`, undefined, H('img'))
        );
        check(
            'полл после notify: сообщение доставлено (версия выросла)',
            tickNotify.json.notify?.text === 'кадры на месте' &&
                tickNotify.json.unchanged !== true &&
                tickNotify.json.state !== null
        );
        const tickSeen = await body(
            await call('GET', `/api/state?since=${vNotify + 1}`, undefined, H('img'))
        );
        check('полл на свежей версии: снова unchanged', tickSeen.json.unchanged === true);

        const vSweep = vNotify + 1;
        await call(
            'POST',
            '/api/sweep',
            { field: 'blur.radius', from: 1, to: 3, steps: 2 },
            H('img')
        );
        const tickSweep = await body(
            await call('GET', `/api/state?since=${vSweep}`, undefined, H('img'))
        );
        check(
            'sweep-заявка: версия инкрементнулась, полл доставляет заявку',
            tickSweep.json.unchanged !== true && tickSweep.json.sweepRequest?.req.field === 'blur.radius'
        );
        // отброшено: «легаси-слот без /ver» — манипуляция внутренним ключом KV
    }

    // ── journal: id/after/404/cap 200/DELETE (общая лента) ──
    {
        const g0 = await body(await call('GET', '/api/journal'));
        check('journal: пусто → {entries:[]}', g0.status === 200 && g0.json.entries.length === 0);

        const j1 = await body(
            await call('POST', '/api/journal', {
                ts: 1,
                fields: ['blur.radius'],
                before: { zoneMatch: 95, maxErr: 40, verdict: 'x' },
            })
        );
        check('journal start: id=1', j1.status === 200 && j1.json.id === 1);
        const j2 = await body(
            await call('POST', '/api/journal', { ts: 2, fields: ['blur.mask'] })
        );
        check('journal start: id=2 (монотонно)', j2.json.id === 2);

        const fin = await body(
            await call('POST', '/api/journal', {
                id: 1,
                after: { zoneMatch: 98.4, maxErr: 10, verdict: 'y' },
            })
        );
        check('journal finish: 200', fin.status === 200);
        const entries = (await body(await call('GET', '/api/journal'))).json.entries;
        check(
            'journal: after дозаполнен, before сохранён',
            entries[0].after.zoneMatch === 98.4 && entries[0].before.zoneMatch === 95
        );

        check(
            'journal finish несуществующего id: 404',
            (
                await body(
                    await call('POST', '/api/journal', {
                        id: 99,
                        after: { zoneMatch: 1, maxErr: 1, verdict: 'z' },
                    })
                )
            ).status === 404
        );
        check(
            'journal битый payload: 400',
            (await body(await call('POST', '/api/journal', { ts: 3 }))).status === 400
        );

        for (let i = 0; i < 203; i++) {
            await call('POST', '/api/journal', { ts: 3 + i, fields: ['blur.radius'] });
        }
        const capped = (await body(await call('GET', '/api/journal'))).json.entries;
        check('journal: cap 200 (205 записей → 200)', capped.length === 200);

        const del = await body(await call('DELETE', '/api/journal'));
        check('journal DELETE: {cleared:200}', del.status === 200 && del.json.cleared === 200);
        check(
            'journal: после DELETE пусто',
            (await body(await call('GET', '/api/journal'))).json.entries.length === 0
        );
        const j3 = await body(
            await call('POST', '/api/journal', { ts: 9, fields: ['blur.rect'] })
        );
        check('journal: id после DELETE снова с 1', j3.json.id === 1);
    }

    // ── presets: CRUD + санитизация + грани имён ──
    {
        const g0 = await body(await call('GET', '/api/presets'));
        check('presets: пустой индекс → {files:[]}', g0.status === 200 && g0.json.files.length === 0);

        const p1 = await body(await call('PUT', '/api/presets?name=veil', state));
        check('presets PUT veil: {ok, name}', p1.status === 200 && p1.json.name === 'veil');
        const p2 = await body(await call('PUT', '/api/presets?name=My%20Preset%21.json', state));
        check(
            'presets PUT "My Preset!.json" → санитизация My-Preset',
            p2.status === 200 && p2.json.name === 'My-Preset'
        );
        const p3 = await body(await call('PUT', '/api/presets?name=%D0%BC%D0%BE%D0%B9', state));
        check('presets PUT кириллица → 400 (имя пусто после санитизации)', p3.status === 400);
        const p4 = await body(await call('PUT', '/api/presets?name=%zz', state));
        check('presets PUT %zz → 400 (битая %-последовательность)', p4.status === 400);
        const bad = await body(
            await call('PUT', '/api/presets?name=broken', { ...state, h: null })
        );
        check('presets PUT невалидный стейт: 400', bad.status === 400);

        const list = await body(await call('GET', '/api/presets'));
        check(
            'presets: индекс = оба, отсортирован',
            list.json.files.length === 2 &&
                list.json.files[0].name === 'My-Preset' &&
                list.json.files[1].name === 'veil' &&
                list.json.files[0].state !== undefined
        );
        check(
            'presets: GET конкретного отдаёт стейт',
            (await body(await call('GET', '/api/presets?name=veil'))).status === 200
        );
        check(
            'presets: GET несуществующего — 404',
            (await body(await call('GET', '/api/presets?name=nope'))).status === 404
        );

        const d1 = await body(await call('DELETE', '/api/presets?name=veil'));
        check('presets DELETE: 200', d1.status === 200 && d1.json.name === 'veil');
        check(
            'presets DELETE повторно: 404',
            (await body(await call('DELETE', '/api/presets?name=veil'))).status === 404
        );
        const list2 = await body(await call('GET', '/api/presets'));
        check(
            'presets: индекс после DELETE без veil',
            list2.json.files.length === 1 && list2.json.files[0].name === 'My-Preset'
        );
    }

    // ── авторизация: 401/403 при LAB_API_TOKEN, чтение открыто (отдельный инстанс: env на старте) ──
    tokenSrv = await startServer({ token: 'secret' });
    {
        const prev = BASE;
        BASE = tokenSrv.base;
        const no = await body(await call('PUT', '/api/state', state));
        check('токен: мутация без Authorization — 401', no.status === 401);
        const wrong = await body(
            await call('PUT', '/api/state', state, { Authorization: 'Bearer wrong' })
        );
        check('токен: неверный Bearer — 403', wrong.status === 403);
        const okPut = await body(
            await call('PUT', '/api/state', state, { Authorization: 'Bearer secret' })
        );
        check('токен: верный Bearer — 200', okPut.status === 200);
        const openRead = await body(await call('GET', '/api/state?since=999'));
        check('токен: чтение без токена открыто', openRead.status === 200);
        BASE = prev;
    }

    // ── миграция legacy-ключей односессионной эпохи (инстанс с предсеенным снапшотом) ──
    migrateSrv = await startServer({
        seed: {
            savedAt: Date.now(),
            kv: [
                [
                    'lab:state',
                    {
                        version: 42,
                        state: { ...state, w: 777 },
                        analysisReq: 'blurMask',
                        sweepReq: {
                            id: 'legacy-sweep',
                            req: { field: 'blur.radius', from: 1, to: 2, steps: 2 },
                        },
                    },
                ],
                ['lab:statever', 42],
                [
                    'lab:warnings',
                    {
                        warnings: [{ code: 'dup-stops', severity: 'info', message: 'x' }],
                    },
                ],
                ['lab:analysis', analysis],
            ],
        },
    });
    {
        const prev = BASE;
        BASE = migrateSrv.base;
        const mg = await body(await call('GET', '/api/state?since=0'));
        check(
            'миграция: слот default создан из legacy (version/state/заявки)',
            mg.status === 200 &&
                mg.json.version === 42 &&
                mg.json.state.w === 777 &&
                mg.json.analysisRequest === 'blurMask' &&
                mg.json.sweepRequest?.id === 'legacy-sweep'
        );
        check(
            'миграция: GET отдал legacy-стейт + заявки',
            mg.json.version === 42 && mg.json.state.w === 777 && mg.json.sweepRequest?.id === 'legacy-sweep'
        );
        // адаптация: переезд warnings/analysis виден через их GET (вместо KV)
        const mw = await body(await call('GET', '/api/warnings'));
        const ma = await body(await call('GET', '/api/analysis'));
        check(
            'миграция: warnings/analysis переехали в слот',
            mw.status === 200 && mw.json.warnings[0].code === 'dup-stops' && ma.json.target === 'blurMask'
        );
        // отброшено: «счётчик продолжается с 42» (KV) и «legacy-ключи удалены» (KV)
        const pm = await body(await call('PUT', '/api/state', state));
        check('миграция: следующая версия 43 (счётчик перенесён)', pm.json.version === 43);
        BASE = prev;
    }

    // ── сессии: миграция → изоляция → ленивое создание → индекс/CRUD → cap ──
    {
        // изоляция двух сессий + независимые счётчики версий
        const sa = { ...state, w: 111 };
        const sb = { ...state, w: 222 };
        const pa = await body(await call('PUT', '/api/state', sa, H('alpha')));
        const pb1 = await body(await call('PUT', '/api/state', sb, H('beta')));
        check(
            'сессии: обе версии начинаются с 1 (счётчики независимы)',
            pa.json.version === 1 && pb1.json.version === 1
        );
        const pb2 = await body(await call('PUT', '/api/state', sb, H('beta')));
        // адаптация: версия alpha — поллом unchanged по since=1
        const tickAlpha = await body(await call('GET', '/api/state?since=1', undefined, H('alpha')));
        check(
            'сессии: beta растёт (2), alpha нет (1)',
            pb2.json.version === 2 && tickAlpha.json.unchanged === true
        );
        const ga = await body(await call('GET', '/api/state', undefined, H('alpha')));
        const gb = await body(await call('GET', '/api/state', undefined, H('beta')));
        check('сессии: изоляция стейтов', ga.json.w === 111 && gb.json.w === 222);
        const gd = await body(await call('GET', '/api/state'));
        check(
            'сессии: default не затронут (777→посл. PUT state)',
            gd.json.w !== 111 && gd.json.w !== 222
        );

        // warnings/analysis — в слоте сессии
        await call(
            'POST',
            '/api/warnings',
            { warnings: [{ code: 'blur-zero-radius', severity: 'warn', message: 'радиус 0' }] },
            H('alpha')
        );
        const wa = await body(await call('GET', '/api/warnings', undefined, H('alpha')));
        const wb = await body(await call('GET', '/api/warnings', undefined, H('beta')));
        check(
            'сессии: warnings alpha виден, beta — 404 cleared',
            wa.status === 200 && wb.status === 404 && wb.json.cleared === true
        );
        // отброшено: «ключ warnings в слоте alpha» — внутренний KV
        await call('POST', '/api/analysis', analysis, H('alpha'));
        const ab = await body(await call('GET', '/api/analysis', undefined, H('beta')));
        check('сессии: анализ beta не видит alpha', ab.status === 404);

        // sweep — в слоте сессии: чужой по id не читается
        const sw = await body(
            await call('POST', '/api/sweep', { field: 'blur.radius', from: 4, to: 8, steps: 2 }, H('alpha'))
        );
        const sid = sw.json.id;
        // отброшено: «sweep-ключ в слоте alpha» — внутренний KV
        const fromBeta = await body(await call('GET', `/api/sweep?id=${sid}`, undefined, H('beta')));
        const fromBetaPath = await body(
            await call('GET', `/api/sweep/${sid}`, undefined, H('beta'))
        );
        check(
            'сессии: чужой sweep не читается (?id= и /<id>) — 404',
            fromBeta.status === 404 && fromBetaPath.status === 404
        );
        const fromAlpha = await body(await call('GET', `/api/sweep?id=${sid}`, undefined, H('alpha')));
        check(
            'сессии: свой sweep читается',
            fromAlpha.status === 200 && fromAlpha.json.status === 'pending'
        );

        // ленивое создание несуществующей сессии (включая GET)
        const list0a = await body(await call('GET', '/api/sessions'));
        const ghostAbsent = !list0a.json.sessions.some((e) => e.id === 'ghost');
        const gh = await body(await call('GET', '/api/state?since=0', undefined, H('ghost')));
        const list0b = await body(await call('GET', '/api/sessions'));
        check(
            'сессии: ленивое создание — пустой слот (unchanged), появилась в индексе',
            ghostAbsent &&
                gh.status === 200 &&
                gh.json.unchanged === true &&
                list0b.json.sessions.some((e) => e.id === 'ghost')
        );

        // невалидный id — 400 (и на journal: заголовок валидируется везде)
        check(
            'сессии: невалидный id — 400',
            (await body(await call('GET', '/api/state?since=0', undefined, H('bad id!')))).status === 400
        );
        check(
            'сессии: id длиннее 64 — 400',
            (
                await body(await call('GET', '/api/state?since=0', undefined, H('x'.repeat(65))))
            ).status === 400
        );
        check(
            'сессии: невалидный id на journal — 400 (валидация глобальна)',
            (await body(await call('GET', '/api/journal', undefined, H('bad id!')))).status === 400
        );
        // journal — общая лента: под валидным заголовком те же записи (после
        // DELETE-теста выше в журнале одна запись с id=1 — продолжаем её нумерацию)
        const jAlpha = await body(
            await call('POST', '/api/journal', { ts: 5, fields: ['blur.radius'] }, H('alpha'))
        );
        check('journal: общий — запись из alpha с id=2', jAlpha.status === 200 && jAlpha.json.id === 2);
        check(
            'journal: общий — виден из beta',
            (await body(await call('GET', '/api/journal', undefined, H('beta')))).json.entries.length === 2
        );

        // индекс: список, имя, переименование
        const list0 = await body(await call('GET', '/api/sessions'));
        check(
            'сессии: GET /api/sessions отдаёт созданные',
            list0.status === 200 &&
                list0.json.sessions.some((e) => e.id === 'alpha') &&
                list0.json.sessions.some((e) => e.id === 'beta') &&
                list0.json.sessions.some((e) => e.id === 'ghost')
        );
        const ren = await body(
            await call('PUT', '/api/sessions?id=alpha', { name: 'Карусель heroes' })
        );
        check(
            'сессии: PUT rename — 200 {id, name}',
            ren.status === 200 && ren.json.name === 'Карусель heroes'
        );
        const list1 = await body(await call('GET', '/api/sessions'));
        // адаптация: имя слота не наблюдаемо без KV — индекс несёт имя
        check(
            'сессии: индекс несёт имя',
            list1.json.sessions.find((e) => e.id === 'alpha')?.name === 'Карусель heroes'
        );
        const badPut = await body(
            await call('PUT', '/api/sessions?id=ok-id', { name: '' })
        );
        check('сессии: PUT пустое имя — 400', badPut.status === 400);
        const badId = await body(await call('PUT', '/api/sessions?id=%zz', { name: 'x' }));
        check('сессии: PUT невалидный id — 400', badId.status === 400);

        // DELETE: слот целиком, повтор — 404, индекс чистеет
        const del = await body(await call('DELETE', '/api/sessions?id=alpha'));
        check(
            'сессии: DELETE — 200 {ok, id}',
            del.status === 200 && del.json.ok === true && del.json.id === 'alpha'
        );
        // отброшено: «слот удалён целиком» — внутренний KV (GET пересоздал бы слот)
        check(
            'сессии: повторный DELETE — 404',
            (await body(await call('DELETE', '/api/sessions?id=x1'))).status === 404
        );
        const list2 = await body(await call('GET', '/api/sessions'));
        check(
            'сессии: индекс после DELETE без alpha',
            !list2.json.sessions.some((e) => e.id === 'alpha')
        );

        // авторизация мутаций сессий (на токен-инстансе)
        const prev = BASE;
        BASE = tokenSrv.base;
        check(
            'сессии: PUT без токена — 401',
            (await body(await call('PUT', '/api/sessions?id=x1'))).status === 401
        );
        check(
            'сессии: DELETE без токена — 401',
            (await body(await call('DELETE', '/api/sessions?id=x1'))).status === 401
        );
        const okRen = await body(
            await call('PUT', '/api/sessions?id=x1', { name: 'x' }, { Authorization: 'Bearer secret' })
        );
        check('сессии: PUT с токеном — 200', okRen.status === 200);
        BASE = prev;

        // cap 50: 52 новых сессий → индекс 50, выкинуты самые старые
        for (let i = 0; i < 52; i++) {
            await call('PUT', '/api/state', state, H(`cap-${i}`));
        }
        const capList = await body(await call('GET', '/api/sessions'));
        check(
            'сессии: индекс cap 50',
            capList.json.sessions.length === 50,
            `len=${capList.json.sessions.length}`
        );
        check(
            'сессии: выкинуты самые старые (beta/ghost), свежие на месте',
            !capList.json.sessions.some((e) => e.id === 'beta') &&
                !capList.json.sessions.some((e) => e.id === 'ghost') &&
                capList.json.sessions.some((e) => e.id === 'cap-51')
        );
        // evicted-слот жив (ключи не удалялись) и пересоздаёт строку при записи
        await call('PUT', '/api/state', state, H('beta'));
        const listBeta = await body(await call('GET', '/api/sessions'));
        check(
            'сессии: evicted beta вернулась в индекс записью (cap держится)',
            listBeta.json.sessions.some((e) => e.id === 'beta') &&
                listBeta.json.sessions.length === 50 &&
                !listBeta.json.sessions.some((e) => e.id === 'cap-2')
        );
    }

    // ── SSE /api/events: retry, initial-стейт, broadcast мутаций, изоляция ──
    {
        // слушатель сессии: fetch + разбор чанков потока в data:-события;
        // таймауты ожидания (2.5с) заведомо меньше heartbeat (25с) — его не ждём
        const listen = async (session) => {
            const ctrl = new AbortController();
            const r = await fetch(`${BASE}/api/events?session=${session}`, {
                signal: ctrl.signal,
            });
            const acc = { lines: [], events: [], buf: '' };
            if (r.body !== null) {
                const reader = r.body.getReader();
                const dec = new TextDecoder();
                void (async () => {
                    try {
                        for (;;) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            acc.buf += dec.decode(value, { stream: true });
                            let cut;
                            while ((cut = acc.buf.indexOf('\n\n')) !== -1) {
                                const frame = acc.buf.slice(0, cut);
                                acc.buf = acc.buf.slice(cut + 2);
                                for (const line of frame.split('\n')) {
                                    acc.lines.push(line);
                                    if (line.startsWith('data: ')) acc.events.push(line.slice(6));
                                }
                            }
                        }
                    } catch {
                        /* abort при teardown слушателя — штатно */
                    }
                })();
            }
            return { r, ctrl, ...acc };
        };
        const waitEvent = async (l, seen, pred, ms = 2500) => {
            const deadline = Date.now() + ms;
            for (;;) {
                const hit = l.events.slice(seen).find(pred);
                if (hit !== undefined) return hit;
                if (Date.now() > deadline) return null;
                await new Promise((res) => setTimeout(res, 20));
            }
        };
        const isState = (d) => d.includes('"type":"state"');

        // непустой слот A (сеем PUT'ом) → initial при подключении
        await call('PUT', '/api/state', { ...state, w: 501 }, H('sse-a'));
        const a = await listen('sse-a');
        let b = null;
        try {
            check(
                'events: 200 text/event-stream',
                a.r.status === 200 &&
                    (a.r.headers.get('content-type') ?? '').includes('text/event-stream')
            );
            const initial = await waitEvent(a, 0, isState);
            check(
                'events: initial state при непустом слоте (посеян PUT)',
                initial !== null && JSON.parse(initial).state.w === 501
            );
            check('events: поток начинается с retry:', a.lines[0]?.startsWith('retry:'));

            // broadcast: PUT в ту же сессию приезжает следующим событием
            const seenA = a.events.length;
            await call('PUT', '/api/state', { ...state, w: 502 }, H('sse-a'));
            const fresh = await waitEvent(a, seenA, isState);
            check(
                'events: broadcast state при PUT в ту же сессию',
                fresh !== null && JSON.parse(fresh).state.w === 502
            );

            // изоляция: подписчик B (пустой слот) не получает мутации A
            b = await listen('sse-b');
            const seenB = b.events.length; // слот пуст — initial нет, только retry
            const seenA2 = a.events.length;
            await call('PUT', '/api/state', { ...state, w: 503 }, H('sse-a'));
            const delivered = await waitEvent(a, seenA2, isState);
            await new Promise((res) => setTimeout(res, 500)); // окно тишины для B
            check(
                'events: изоляция — PUT сессии A не приходит подписчику B',
                delivered !== null &&
                    JSON.parse(delivered).state.w === 503 &&
                    b.events.length === seenB
            );
        } finally {
            a.ctrl.abort();
            if (b !== null) b.ctrl.abort();
        }
    }
} catch (err) {
    // SKIP_SUITE — штатный пропуск (нет lab-sync); прочее роняет сьют как раньше
    if (err !== SKIP_SUITE) throw err;
} finally {
    // при любом падении серверы гасятся и tmp-папки чистятся
    if (main !== null) await main.stop();
    if (tokenSrv !== null) await tokenSrv.stop();
    if (migrateSrv !== null) await migrateSrv.stop();
}

console.log(
    `\nlab-sync-api: ${total - failed}/${total} проверок прошли${failed > 0 ? `, УПАЛО: ${failed}` : ''}`
);
if (failed > 0) process.exitCode = 1;
