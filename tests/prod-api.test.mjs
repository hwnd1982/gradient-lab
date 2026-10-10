/**
 * Мок-тест прод-функций server/functions/*.ts (источники; api/ — генерат
 * сборки): Upstash REST подменён in-memory Map через global.fetch, хендлеры
 * импортируются jiti как есть (TS, web-standard Request/Response). Контракт —
 * API.md. Запуск: npm test (tests/run.mjs).
 */
import { createJiti } from 'jiti';

const ROOT = new URL('..', import.meta.url).pathname;
const jiti = createJiti(import.meta.url);

export let total = 0;
export let failed = 0;
function check(name, cond, extra = '') {
    total += 1;
    if (cond) console.log(`ok   ${name}`);
    else {
        failed += 1;
        console.error(`FAIL ${name} ${extra}`);
    }
}
const body = async (r) => ({ status: r.status, json: await r.json() });
const req = (method, u, payload, headers = {}) =>
    new Request(u, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

// ── мок Upstash REST: get/set/incr/del через path, set — POST с телом ──
const kv = new Map();
let fetchCount = 0;
globalThis.fetch = async (url, init = {}) => {
    fetchCount += 1;
    const m = String(url).match(/https:\/\/mock\.upstash\.local\/(get|set|incr|del)\/(.+)$/);
    if (m === null) throw new Error('неожиданный fetch: ' + url);
    const op = m[1];
    const key = decodeURIComponent(m[2]);
    const reply = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });
    if (op === 'get') return reply(kv.has(key) ? kv.get(key) : null);
    if (op === 'set') {
        kv.set(key, init.body);
        return reply('OK');
    }
    if (op === 'incr') {
        const n = Number(kv.get(key) ?? '0') + 1;
        kv.set(key, String(n));
        return reply(n);
    }
    return reply(kv.delete(key) ? 1 : 0);
};
const KV_URL = 'https://mock.upstash.local';
process.env.KV_REST_API_URL = KV_URL;
process.env.KV_REST_API_TOKEN = 'test-token';
delete process.env.LAB_API_TOKEN;

// стейт сессии default (X-Lab-Session не задан → 'default'; слот lab:s/default)
const labState = (s = 'default') => JSON.parse(kv.get(`lab:s/${s}`));
const labVersion = () => labState().version;

// ── импорт хендлеров (после подмены fetch: kv.ts замыкает globalThis.fetch при вызове) ──
const stateApi = await jiti.import(`${ROOT}server/functions/state.ts`);
const syncApi = await jiti.import(`${ROOT}server/functions/sync.ts`);
const analysisApi = await jiti.import(`${ROOT}server/functions/analysis.ts`);
const warningsApi = await jiti.import(`${ROOT}server/functions/warnings.ts`);
const journalApi = await jiti.import(`${ROOT}server/functions/journal.ts`);
const presetsApi = await jiti.import(`${ROOT}server/functions/presets.ts`);
const presetApi = await jiti.import(`${ROOT}server/functions/presets-name.ts`);
const sweepApi = await jiti.import(`${ROOT}server/functions/sweep.ts`);
const sweepIdApi = await jiti.import(`${ROOT}server/functions/sweep-id.ts`);
const methodologyApi = await jiti.import(`${ROOT}server/functions/methodology.ts`);
const sessionsApi = await jiti.import(`${ROOT}server/functions/sessions.ts`);
const sessionsIdApi = await jiti.import(`${ROOT}server/functions/sessions-id.ts`);
const { METHODOLOGY } = await jiti.import(`${ROOT}src/lib/methodology.ts`);
const { MethodologySchema, AnalysisSchema, defaultBlockState } = await jiti.import(
    `${ROOT}src/schema.ts`
);

const state = defaultBlockState();

// ── 503 без env Upstash (methodology при этом жива — ей стор не нужен) ──
{
    delete process.env.KV_REST_API_URL;
    const st = await body(await stateApi.GET(req('GET', 'https://x/api/state')));
    check('503: state без env', st.status === 503, `status=${st.status}`);
    const sw = await body(
        await sweepApi.POST(
            req('POST', 'https://x/api/sweep', { field: 'blur.radius', from: 1, to: 2, steps: 2 })
        )
    );
    check('503: sweep без env', sw.status === 503);
    const jn = await body(await journalApi.GET());
    check('503: journal без env', jn.status === 503);
    const pr = await body(await presetsApi.GET());
    check('503: presets без env', pr.status === 503);
    const meth = await body(await methodologyApi.GET());
    check('methodology: 200 даже без env Upstash', meth.status === 200 && meth.json.version === 2);
    process.env.KV_REST_API_URL = KV_URL;
}

// ── methodology: формат и dev-импорт ──
{
    const m = METHODOLOGY;
    const parsed = MethodologySchema.safeParse(m);
    check(
        'methodology: 7 фаз + инварианты + text',
        m.phases.length === 7 && m.invariants.length > 0 && m.text.length > 500
    );
    check('methodology: dev-импорт проходит MethodologySchema', parsed.success);
    const before = fetchCount;
    void (await methodologyApi.GET());
    check('methodology: 0 команд Upstash', fetchCount === before);
}

// ── версии стейта: PUT / sync / since / unchanged / валидация ──
{
    const p1 = await body(await stateApi.PUT(req('PUT', 'https://x/api/state', state)));
    check(
        'PUT state: version 1',
        p1.status === 200 && p1.json.version === 1,
        JSON.stringify(p1.json)
    );
    const p2 = await body(await stateApi.PUT(req('PUT', 'https://x/api/state', state)));
    check('PUT state: version 2 (INCR на каждую запись)', p2.json.version === 2);
    const s1 = await body(await syncApi.POST(req('POST', 'https://x/api/sync', { state })));
    check('sync {state}: version 3', s1.status === 200 && s1.json.version === 3);
    const s2 = await body(await syncApi.POST(req('POST', 'https://x/api/sync', state)));
    check('sync голым стейтом: version 4 (совместимость dev-стиля)', s2.json.version === 4);

    const bare = await body(await stateApi.GET(req('GET', 'https://x/api/state')));
    check(
        'GET без since: голый BlockState (без обёртки version)',
        bare.status === 200 && bare.json.version === undefined && bare.json.base !== undefined
    );

    const changed = await body(await stateApi.GET(req('GET', `https://x/api/state?since=3`)));
    check(
        'GET since=3: {version:4, state} (changed)',
        changed.json.version === 4 && changed.json.state !== null && changed.json.unchanged !== true
    );
    const unchanged = await body(await stateApi.GET(req('GET', `https://x/api/state?since=4`)));
    check(
        'GET since=4: unchanged:true (не 404)',
        unchanged.json.version === 4 && unchanged.json.unchanged === true
    );

    const badSince = await body(await stateApi.GET(req('GET', `https://x/api/state?since=abc`)));
    check('GET since=abc: 400', badSince.status === 400);
    const negSince = await body(await stateApi.GET(req('GET', `https://x/api/state?since=-1`)));
    check('GET since=-1: 400', negSince.status === 400);

    const badJson = await body(
        await stateApi.PUT(new Request('https://x/api/state', { method: 'PUT', body: '{"w":' }))
    );
    check('PUT битый JSON: 400', badJson.status === 400);
    const badState = await body(
        await stateApi.PUT(req('PUT', 'https://x/api/state', { ...state, w: 'ширина' }))
    );
    check(
        'PUT невалидный стейт: 400 + issues',
        badState.status === 400 && Array.isArray(badState.json.issues)
    );
}

// ── warnings: 404-cleared до синка, запись, cleared-семантика ──
{
    const g0 = await body(await warningsApi.GET(req('GET', 'https://x/api/warnings')));
    check('warnings: до POST — 404 {cleared:true}', g0.status === 404 && g0.json.cleared === true);
    const warn = {
        warnings: [{ code: 'blur-zero-radius', severity: 'warn', message: 'радиус 0' }],
    };
    await warningsApi.POST(req('POST', 'https://x/api/warnings', warn));
    const g1 = await body(await warningsApi.GET(req('GET', 'https://x/api/warnings')));
    check(
        'warnings: GET отдаёт список',
        g1.status === 200 &&
            g1.json.warnings.length === 1 &&
            g1.json.warnings[0].code === 'blur-zero-radius'
    );
    await warningsApi.POST(req('POST', 'https://x/api/warnings', { cleared: true }));
    const g2 = await body(await warningsApi.GET(req('GET', 'https://x/api/warnings')));
    check(
        'warnings: cleared:true хранится как пусто (не отдаёт старьё)',
        g2.status === 200 && g2.json.cleared === true
    );
    const bad = await body(
        await warningsApi.POST(req('POST', 'https://x/api/warnings', { warnings: [] }))
    );
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
    const g0 = await body(await analysisApi.GET(req('GET', 'https://x/api/analysis')));
    check('analysis: без target и кэша — 404 «анализа ещё нет»', g0.status === 404);

    const alias = await body(
        await analysisApi.GET(req('GET', 'https://x/api/analysis?target=mask'))
    );
    check(
        'analysis: алиас mask → канонический blockMask',
        alias.status === 404 && alias.json.requested === 'blockMask'
    );
    check(
        'analysis: заявка analysisReq=blockMask в lab:state',
        labState().analysisReq === 'blockMask'
    );

    const zeros = await body(
        await analysisApi.GET(req('GET', 'https://x/api/analysis?target=layer:007'))
    );
    check(
        'analysis: layer:007 → канонический layer:7',
        zeros.status === 404 && zeros.json.requested === 'layer:7'
    );
    check('analysis: заявка перезаписалась на layer:7', labState().analysisReq === 'layer:7');

    const bogus = await body(
        await analysisApi.GET(req('GET', 'https://x/api/analysis?target=bogus'))
    );
    check(
        'analysis: неизвестный target — 400 + known',
        bogus.status === 400 && bogus.json.known.includes('blurMask')
    );

    const post = await body(
        await analysisApi.POST(req('POST', 'https://x/api/analysis', analysis))
    );
    check('analysis POST: полный анализ с hint — 200', post.status === 200);
    check('analysis POST: свежий анализ стёр заявку', labState().analysisReq === undefined);

    const hit = await body(
        await analysisApi.GET(req('GET', 'https://x/api/analysis?target=blurMask'))
    );
    check(
        'analysis: кэш-матчинг по target — 200 без новой заявки',
        hit.status === 200 &&
            hit.json.zoneMatchPercent === 95.5 &&
            hit.json.hint === 'Крути blur.radius и форму blur.mask' &&
            labState().analysisReq === undefined
    );
    const noParam = await body(await analysisApi.GET(req('GET', 'https://x/api/analysis')));
    check(
        'analysis: без target — последний (кэш)',
        noParam.status === 200 && noParam.json.target === 'blurMask'
    );

    const marker = { target: 'underlay', blocked: 'no-reference' };
    await analysisApi.POST(req('POST', 'https://x/api/analysis', marker));
    const gm = await body(await analysisApi.GET(req('GET', 'https://x/api/analysis')));
    check(
        'analysis: маркер blocked кэшируется и отдаётся 200-м',
        gm.status === 200 && gm.json.blocked === 'no-reference' && gm.json.target === 'underlay'
    );

    await analysisApi.POST(req('POST', 'https://x/api/analysis', { cleared: true }));
    const gc = await body(await analysisApi.GET(req('GET', 'https://x/api/analysis')));
    check('analysis: cleared:true сбросил кэш (404)', gc.status === 404);
    const badPost = await body(
        await analysisApi.POST(req('POST', 'https://x/api/analysis', { target: 'x' }))
    );
    check('analysis: ни анализ ни маркер — 400 (refine)', badPost.status === 400);
}

// ── sweep: заявка / полл 1 команда / P1-промах / идемпотентность / результат ──
{
    // к этому моменту кэш анализа стёрт (cleared) — промахи честные
    const miss = await body(
        await analysisApi.GET(req('GET', 'https://x/api/analysis?target=blurBg'))
    );
    check(
        'sweep-преамбула: промах blurBg оставил заявку',
        miss.status === 404 && labState().analysisReq === 'blurBg'
    );

    const sw = await body(
        await sweepApi.POST(
            req('POST', 'https://x/api/sweep', { field: 'blur.radius', from: 4, to: 20, steps: 6 })
        )
    );
    const id = sw.json.id ?? '';
    check('sweep POST: 200 {id}', sw.status === 200 && typeof id === 'string' && id !== '');
    check(
        'sweep POST: lab:s/default/sweep/<id> = {req, pending}',
        JSON.parse(kv.get(`lab:s/default/sweep/${id}`)).status === 'pending'
    );
    check(
        'sweep POST: заявка sweepReq в lab:state, analysisReq сохранён',
        labState().sweepReq?.id === id && labState().analysisReq === 'blurBg'
    );
    check('sweep POST: стейт/версия не потеряны', labVersion() > 0 && labState().state !== null);

    // P1: sweep-заявка переживает промах analysis-target (письмо через setAnalysisReq)
    const miss2 = await body(
        await analysisApi.GET(req('GET', 'https://x/api/analysis?target=underlay'))
    );
    check(
        'P1: промах analysis-target не стёр sweep-заявку',
        miss2.status === 404 &&
            labState().analysisReq === 'underlay' &&
            labState().sweepReq?.id === id
    );

    // идемпотентность повторного промаха: get слота + get анализа + get слота
    // (setAnalysisReq), без set
    const before = fetchCount;
    await analysisApi.GET(req('GET', 'https://x/api/analysis?target=underlay'));
    check(
        'промах идемпотентен: 3 команды (get+get+get), без set',
        fetchCount - before === 3,
        `команд: ${fetchCount - before}`
    );

    // cleared-совместимость: анализ/маркер и sync не затирают sweepReq
    await analysisApi.POST(
        req('POST', 'https://x/api/analysis', { target: 'underlay', gradientMissing: true })
    );
    check('маркер анализа не стёр sweepReq', labState().sweepReq?.id === id);
    await syncApi.POST(req('POST', 'https://x/api/sync', { state }));
    check('sync браузера не стёр sweepReq (версия выросла)', labState().sweepReq?.id === id);

    // полл-тик = ровно 1 команда; заявки видны в changed и unchanged
    const v = labVersion();
    const before2 = fetchCount;
    const poll1 = await body(await stateApi.GET(req('GET', `https://x/api/state?since=${v}`)));
    check(
        'полл: ровно 1 команда Upstash',
        fetchCount - before2 === 1,
        `команд: ${fetchCount - before2}`
    );
    check(
        'полл unchanged: несёт sweepRequest + analysisRequest(уже стёрт маркером)',
        poll1.json.unchanged === true &&
            poll1.json.sweepRequest?.id === id &&
            poll1.json.analysisRequest === undefined
    );
    const poll2 = await body(await stateApi.GET(req('GET', `https://x/api/state?since=${v - 1}`)));
    check(
        'полл changed: {version, state, sweepRequest}',
        poll2.json.version === v && poll2.json.state !== null && poll2.json.sweepRequest?.id === id
    );

    // результат по id: done, оба GET-варианта, заявка стёрта
    const results = [
        { value: 4, zoneMatchPercent: 91.2, maxError: 81 },
        { value: 10.4, zoneMatchPercent: 98.4, maxError: 19 },
    ];
    const done = await body(
        await sweepApi.POST(req('POST', 'https://x/api/__sweep', { id, results }))
    );
    check(
        'POST __sweep (rewrite → union-ветка результата): 200',
        done.status === 200 && done.json.ok === true
    );
    const g1 = await body(await sweepApi.GET(req('GET', `https://x/api/sweep?id=${id}`)));
    check(
        'GET ?id=: done + таблица',
        g1.status === 200 &&
            g1.json.status === 'done' &&
            g1.json.results.length === 2 &&
            g1.json.results[1].zoneMatchPercent === 98.4
    );
    const g2 = await body(
        await sweepIdApi.GET(req('GET', `https://x/api/sweep?id=${id}`))
    );
    check(
        'GET /<id>: тот же ответ',
        g2.status === 200 && g2.json.status === 'done' && g2.json.results.length === 2
    );
    check('после результата: sweepReq стёрт', labState().sweepReq === undefined);
    const poll3 = await body(
        await stateApi.GET(req('GET', `https://x/api/state?since=${labVersion()}`))
    );
    check('после результата: полл без sweepRequest', poll3.json.sweepRequest === undefined);

    // abort-ветка: частичные results + причина
    const sw2 = await body(
        await sweepApi.POST(
            req('POST', 'https://x/api/sweep', { field: 'blur.radius', from: 8, to: 14, steps: 2 })
        )
    );
    const id2 = sw2.json.id;
    await sweepApi.POST(
        req('POST', 'https://x/api/__sweep', {
            id: id2,
            results: [{ value: 8, zoneMatchPercent: 90, maxError: 40 }],
            aborted: 'state/таргет изменён вне sweep',
        })
    );
    const ga = await body(await sweepApi.GET(req('GET', `https://x/api/sweep?id=${id2}`)));
    check(
        'abort: status=aborted + причина + частичные results',
        ga.json.status === 'aborted' &&
            ga.json.aborted.includes('вне sweep') &&
            ga.json.results.length === 1
    );

    // ошибки
    check(
        'GET ?id=nope: 404',
        (await body(await sweepApi.GET(req('GET', 'https://x/api/sweep?id=nope')))).status === 404
    );
    check(
        'POST неподдерживаемое поле: 400',
        (
            await body(
                await sweepApi.POST(
                    req('POST', 'https://x/api/sweep', {
                        field: 'blur.opacity',
                        from: 1,
                        to: 2,
                        steps: 3,
                    })
                )
            )
        ).status === 400
    );
    check(
        'POST steps вне 2..12: 400',
        (
            await body(
                await sweepApi.POST(
                    req('POST', 'https://x/api/sweep', {
                        field: 'blur.radius',
                        from: 1,
                        to: 2,
                        steps: 99,
                    })
                )
            )
        ).status === 400
    );
    check(
        '__sweep без results/aborted: 400 (refine)',
        (await body(await sweepApi.POST(req('POST', 'https://x/api/__sweep', { id: 'x' }))))
            .status === 400
    );
    check(
        'GET без ?id: 400',
        (await body(await sweepApi.GET(req('GET', 'https://x/api/sweep')))).status === 400
    );
    check(
        'GET /<id> битый id: 400',
        (
            await body(
                await sweepIdApi.GET(req('GET', 'https://x/api/sweep?id=%zz'))
            )
        ).status === 400
    );
}

// ── journal: id/after/404/cap 200/DELETE (общая лента: заголовок валидируется, слотов не касается) ──
{
    const g0 = await body(await journalApi.GET(req('GET', 'https://x/api/journal')));
    check('journal: пусто → {entries:[]}', g0.status === 200 && g0.json.entries.length === 0);

    const j1 = await body(
        await journalApi.POST(
            req('POST', 'https://x/api/journal', {
                ts: 1,
                fields: ['blur.radius'],
                before: { zoneMatch: 95, maxErr: 40, verdict: 'x' },
            })
        )
    );
    check('journal start: id=1', j1.status === 200 && j1.json.id === 1);
    const j2 = await body(
        await journalApi.POST(
            req('POST', 'https://x/api/journal', { ts: 2, fields: ['blur.mask'] })
        )
    );
    check('journal start: id=2 (монотонно)', j2.json.id === 2);

    const fin = await body(
        await journalApi.POST(
            req('POST', 'https://x/api/journal', {
                id: 1,
                after: { zoneMatch: 98.4, maxErr: 10, verdict: 'y' },
            })
        )
    );
    check('journal finish: 200', fin.status === 200);
    const entries = (await body(await journalApi.GET(req('GET', 'https://x/api/journal')))).json
        .entries;
    check(
        'journal: after дозаполнен, before сохранён',
        entries[0].after.zoneMatch === 98.4 && entries[0].before.zoneMatch === 95
    );

    check(
        'journal finish несуществующего id: 404',
        (
            await body(
                await journalApi.POST(
                    req('POST', 'https://x/api/journal', {
                        id: 99,
                        after: { zoneMatch: 1, maxErr: 1, verdict: 'z' },
                    })
                )
            )
        ).status === 404
    );
    check(
        'journal битый payload: 400',
        (await body(await journalApi.POST(req('POST', 'https://x/api/journal', { ts: 3 }))))
            .status === 400
    );

    for (let i = 0; i < 203; i++) {
        await journalApi.POST(
            req('POST', 'https://x/api/journal', { ts: 3 + i, fields: ['blur.radius'] })
        );
    }
    const capped = (await body(await journalApi.GET(req('GET', 'https://x/api/journal')))).json
        .entries;
    check('journal: cap 200 (205 записей → 200)', capped.length === 200);

    const del = await body(await journalApi.DELETE(req('DELETE', 'https://x/api/journal')));
    check('journal DELETE: {cleared:200}', del.status === 200 && del.json.cleared === 200);
    check(
        'journal: после DELETE пусто',
        (await body(await journalApi.GET(req('GET', 'https://x/api/journal')))).json.entries
            .length === 0
    );
    const j3 = await body(
        await journalApi.POST(
            req('POST', 'https://x/api/journal', { ts: 9, fields: ['blur.rect'] })
        )
    );
    check('journal: id после DELETE снова с 1', j3.json.id === 1);
}

// ── presets: CRUD + санитизация + грани имён ──
{
    const g0 = await body(await presetsApi.GET());
    check('presets: пустой индекс → {files:[]}', g0.status === 200 && g0.json.files.length === 0);

    const p1 = await body(await presetApi.PUT(req('PUT', 'https://x/api/presets?name=veil', state)));
    check('presets PUT veil: {ok, name}', p1.status === 200 && p1.json.name === 'veil');
    const p2 = await body(
        await presetApi.PUT(req('PUT', 'https://x/api/presets?name=My%20Preset%21.json', state))
    );
    check(
        'presets PUT "My Preset!.json" → санитизация My-Preset',
        p2.status === 200 && p2.json.name === 'My-Preset'
    );
    const p3 = await body(
        await presetApi.PUT(req('PUT', 'https://x/api/presets?name=%D0%BC%D0%BE%D0%B9', state))
    );
    check('presets PUT кириллица → 400 (имя пусто после санитизации)', p3.status === 400);
    const p4 = await body(await presetApi.PUT(req('PUT', 'https://x/api/presets?name=%zz', state)));
    check('presets PUT %zz → 400 (битая %-последовательность)', p4.status === 400);
    const bad = await body(
        await presetApi.PUT(req('PUT', 'https://x/api/presets?name=broken', { ...state, h: null }))
    );
    check('presets PUT невалидный стейт: 400', bad.status === 400);

    const list = await body(await presetsApi.GET());
    check(
        'presets: индекс = оба, отсортирован',
        list.json.files.length === 2 &&
            list.json.files[0].name === 'My-Preset' &&
            list.json.files[1].name === 'veil' &&
            list.json.files[0].state !== undefined
    );
    check(
        'presets: GET конкретного отдаёт стейт',
        (await body(await presetApi.GET(req('GET', 'https://x/api/presets?name=veil')))).status === 200
    );
    check(
        'presets: GET несуществующего — 404',
        (await body(await presetApi.GET(req('GET', 'https://x/api/presets?name=nope')))).status === 404
    );

    const d1 = await body(await presetApi.DELETE(req('DELETE', 'https://x/api/presets?name=veil')));
    check('presets DELETE: 200', d1.status === 200 && d1.json.name === 'veil');
    check(
        'presets DELETE повторно: 404',
        (await body(await presetApi.DELETE(req('DELETE', 'https://x/api/presets?name=veil')))).status ===
            404
    );
    const list2 = await body(await presetsApi.GET());
    check(
        'presets: индекс после DELETE без veil',
        list2.json.files.length === 1 && list2.json.files[0].name === 'My-Preset'
    );
}

// ── авторизация: 401/403 при LAB_API_TOKEN, чтение открыто ──
{
    process.env.LAB_API_TOKEN = 'secret';
    const no = await body(await stateApi.PUT(req('PUT', 'https://x/api/state', state)));
    check('токен: мутация без Authorization — 401', no.status === 401);
    const wrong = await body(
        await stateApi.PUT(
            req('PUT', 'https://x/api/state', state, { Authorization: 'Bearer wrong' })
        )
    );
    check('токен: неверный Bearer — 403', wrong.status === 403);
    const okPut = await body(
        await stateApi.PUT(
            req('PUT', 'https://x/api/state', state, { Authorization: 'Bearer secret' })
        )
    );
    check('токен: верный Bearer — 200', okPut.status === 200);
    const openRead = await body(await stateApi.GET(req('GET', 'https://x/api/state?since=999')));
    check('токен: чтение без токена открыто', openRead.status === 200);
    delete process.env.LAB_API_TOKEN;
}

// ── сессии: миграция legacy → изоляция → ленивое создание → индекс/CRUD → cap ──
{
    const H = (id) => ({ 'X-Lab-Session': id });

    // миграция односессионной эпохи: симулируем legacy-стор (слота default нет)
    kv.delete('lab:s/default');
    kv.delete('lab:s/default/ver');
    kv.delete('lab:s/default/warnings');
    kv.delete('lab:s/default/analysis');
    kv.delete('lab:sessions');
    kv.set(
        'lab:state',
        JSON.stringify({
            version: 42,
            state: { ...state, w: 777 },
            analysisReq: 'blurMask',
            sweepReq: { id: 'legacy-sweep', req: { field: 'blur.radius', from: 1, to: 2, steps: 2 } },
        })
    );
    kv.set('lab:statever', '42');
    kv.set(
        'lab:warnings',
        JSON.stringify({
            warnings: [{ code: 'dup-stops', severity: 'info', message: 'x' }],
        })
    );
    kv.set('lab:analysis', JSON.stringify(analysis));
    const mg = await body(await stateApi.GET(req('GET', 'https://x/api/state?since=0')));
    check(
        'миграция: слот lab:s/default создан из legacy (version/state/заявки/мета)',
        labState().version === 42 &&
            labState().state.w === 777 &&
            labState().analysisReq === 'blurMask' &&
            labState().sweepReq.id === 'legacy-sweep' &&
            labState().name === 'default'
    );
    check(
        'миграция: GET отдал legacy-стейт + заявки',
        mg.json.version === 42 && mg.json.state.w === 777 && mg.json.sweepRequest?.id === 'legacy-sweep'
    );
    check('миграция: счётчик продолжается с 42', kv.get('lab:s/default/ver') === '42');
    check(
        'миграция: warnings/analysis переехали в слот',
        JSON.parse(kv.get('lab:s/default/warnings')).warnings[0].code === 'dup-stops' &&
            JSON.parse(kv.get('lab:s/default/analysis')).target === 'blurMask'
    );
    check(
        'миграция: legacy-ключи удалены',
        !kv.has('lab:state') && !kv.has('lab:statever') && !kv.has('lab:warnings') && !kv.has('lab:analysis')
    );
    const pm = await body(await stateApi.PUT(req('PUT', 'https://x/api/state', state)));
    check('миграция: следующая версия 43 (счётчик перенесён)', pm.json.version === 43);

    // изоляция двух сессий + независимые счётчики версий
    const sa = { ...state, w: 111 };
    const sb = { ...state, w: 222 };
    const pa = await body(await stateApi.PUT(req('PUT', 'https://x/api/state', sa, H('alpha'))));
    const pb1 = await body(await stateApi.PUT(req('PUT', 'https://x/api/state', sb, H('beta'))));
    check(
        'сессии: обе версии начинаются с 1 (счётчики независимы)',
        pa.json.version === 1 && pb1.json.version === 1
    );
    const pb2 = await body(await stateApi.PUT(req('PUT', 'https://x/api/state', sb, H('beta'))));
    check('сессии: beta растёт (2), alpha нет (1)', pb2.json.version === 2 && labState('alpha').version === 1);
    const ga = await body(
        await stateApi.GET(req('GET', 'https://x/api/state', undefined, H('alpha')))
    );
    const gb = await body(
        await stateApi.GET(req('GET', 'https://x/api/state', undefined, H('beta')))
    );
    check('сессии: изоляция стейтов', ga.json.w === 111 && gb.json.w === 222);
    check('сессии: default не затронут (777→посл. PUT state)', labState().state.w !== 111 && labState().state.w !== 222);

    // warnings/analysis — в слоте сессии
    await warningsApi.POST(
        req(
            'POST',
            'https://x/api/warnings',
            { warnings: [{ code: 'blur-zero-radius', severity: 'warn', message: 'радиус 0' }] },
            H('alpha')
        )
    );
    const wa = await body(
        await warningsApi.GET(req('GET', 'https://x/api/warnings', undefined, H('alpha')))
    );
    const wb = await body(
        await warningsApi.GET(req('GET', 'https://x/api/warnings', undefined, H('beta')))
    );
    check(
        'сессии: warnings alpha виден, beta — 404 cleared',
        wa.status === 200 && wb.status === 404 && wb.json.cleared === true
    );
    check('сессии: ключ warnings в слоте alpha', kv.has('lab:s/alpha/warnings'));
    await analysisApi.POST(req('POST', 'https://x/api/analysis', analysis, H('alpha')));
    const ab = await body(
        await analysisApi.GET(req('GET', 'https://x/api/analysis', undefined, H('beta')))
    );
    check('сессии: анализ beta не видит alpha', ab.status === 404);

    // sweep — в слоте сессии: чужой по id не читается
    const sw = await body(
        await sweepApi.POST(
            req('POST', 'https://x/api/sweep', { field: 'blur.radius', from: 4, to: 8, steps: 2 }, H('alpha'))
        )
    );
    const sid = sw.json.id;
    check('сессии: sweep-ключ в слоте alpha', kv.has(`lab:s/alpha/sweep/${sid}`));
    const fromBeta = await body(
        await sweepApi.GET(req('GET', `https://x/api/sweep?id=${sid}`, undefined, H('beta')))
    );
    const fromBetaPath = await body(
        await sweepIdApi.GET(req('GET', `https://x/api/sweep?id=${sid}`, undefined, H('beta')))
    );
    check(
        'сессии: чужой sweep не читается (?id= и /<id>) — 404',
        fromBeta.status === 404 && fromBetaPath.status === 404
    );
    const fromAlpha = await body(
        await sweepApi.GET(req('GET', `https://x/api/sweep?id=${sid}`, undefined, H('alpha')))
    );
    check('сессии: свой sweep читается', fromAlpha.status === 200 && fromAlpha.json.status === 'pending');

    // ленивое создание несуществующей сессии (включая GET)
    check('сессии: до обращения слота ghost нет', !kv.has('lab:s/ghost'));
    const gh = await body(
        await stateApi.GET(req('GET', 'https://x/api/state?since=0', undefined, H('ghost')))
    );
    check(
        'сессии: ленивое создание — пустой слот, unchanged',
        gh.status === 200 && gh.json.unchanged === true && kv.has('lab:s/ghost')
    );

    // невалидный id — 400 (и на journal: заголовок валидируется везде)
    check(
        'сессии: невалидный id — 400',
        (await body(await stateApi.GET(req('GET', 'https://x/api/state?since=0', undefined, H('bad id!'))))).status === 400
    );
    check(
        'сессии: id длиннее 64 — 400',
        (await body(await stateApi.GET(req('GET', 'https://x/api/state?since=0', undefined, H('x'.repeat(65)))))).status === 400
    );
    check(
        'сессии: невалидный id на journal — 400 (валидация глобальна)',
        (await body(await journalApi.GET(req('GET', 'https://x/api/journal', undefined, H('bad id!'))))).status === 400
    );
    // journal — общая лента: под валидным заголовком те же записи (после
    // DELETE-теста выше в журнале одна запись с id=1 — продолжаем её нумерацию)
    const jAlpha = await body(
        await journalApi.POST(req('POST', 'https://x/api/journal', { ts: 5, fields: ['blur.radius'] }, H('alpha')))
    );
    check('journal: общий — запись из alpha с id=2', jAlpha.status === 200 && jAlpha.json.id === 2);
    check(
        'journal: общий — виден из beta',
        (await body(await journalApi.GET(req('GET', 'https://x/api/journal', undefined, H('beta'))))).json
            .entries.length === 2
    );

    // индекс: список, имя, переименование
    const list0 = await body(await sessionsApi.GET());
    check(
        'сессии: GET /api/sessions отдаёт созданные',
        list0.status === 200 &&
            list0.json.sessions.some((e) => e.id === 'alpha') &&
            list0.json.sessions.some((e) => e.id === 'beta') &&
            list0.json.sessions.some((e) => e.id === 'ghost')
    );
    const ren = await body(
        await sessionsIdApi.PUT(
            req('PUT', 'https://x/api/sessions?id=alpha', { name: 'Карусель heroes' })
        )
    );
    check('сессии: PUT rename — 200 {id, name}', ren.status === 200 && ren.json.name === 'Карусель heroes');
    const list1 = await body(await sessionsApi.GET());
    check(
        'сессии: индекс и слот несут имя',
        list1.json.sessions.find((e) => e.id === 'alpha')?.name === 'Карусель heroes' &&
            labState('alpha').name === 'Карусель heroes'
    );
    const badPut = await body(
        await sessionsIdApi.PUT(
            req('PUT', 'https://x/api/sessions?id=ok-id', { name: '' })
        )
    );
    check('сессии: PUT пустое имя — 400', badPut.status === 400);
    const badId = await body(
        await sessionsIdApi.PUT(req('PUT', 'https://x/api/sessions?id=%zz', { name: 'x' }))
    );
    check('сессии: PUT невалидный id — 400', badId.status === 400);

    // DELETE: слот целиком, повтор — 404, индекс чистеет
    const del = await body(
        await sessionsIdApi.DELETE(req('DELETE', 'https://x/api/sessions?id=alpha'))
    );
    check('сессии: DELETE — 200 {ok, id}', del.status === 200 && del.json.ok === true && del.json.id === 'alpha');
    check(
        'сессии: слот удалён целиком (стейт/ver/warnings/analysis/sweep)',
        !kv.has('lab:s/alpha') &&
            !kv.has('lab:s/alpha/ver') &&
            !kv.has('lab:s/alpha/warnings') &&
            !kv.has('lab:s/alpha/analysis')
    );
    check(
        'сессии: повторный DELETE — 404',
        (await body(await sessionsIdApi.DELETE(req('DELETE', 'https://x/api/sessions?id=x1')))).status === 404
    );
    const list2 = await body(await sessionsApi.GET());
    check('сессии: индекс после DELETE без alpha', !list2.json.sessions.some((e) => e.id === 'alpha'));

    // авторизация мутаций сессий
    process.env.LAB_API_TOKEN = 'secret';
    check(
        'сессии: PUT без токена — 401',
        (await body(await sessionsIdApi.PUT(req('PUT', 'https://x/api/sessions?id=x1')))).status === 401
    );
    check(
        'сессии: DELETE без токена — 401',
        (await body(await sessionsIdApi.DELETE(req('DELETE', 'https://x/api/sessions?id=x1')))).status === 401
    );
    const okRen = await body(
        await sessionsIdApi.PUT(
            req('PUT', 'https://x/api/sessions?id=x1', { name: 'x' }, { Authorization: 'Bearer secret' })
        )
    );
    check('сессии: PUT с токеном — 200', okRen.status === 200);
    delete process.env.LAB_API_TOKEN;

    // cap 50: 52 новых сессий → индекс 50, выкинуты самые старые
    for (let i = 0; i < 52; i++) {
        await stateApi.PUT(req('PUT', 'https://x/api/state', state, H(`cap-${i}`)));
    }
    const capList = await body(await sessionsApi.GET());
    check('сессии: индекс cap 50', capList.json.sessions.length === 50, `len=${capList.json.sessions.length}`);
    check(
        'сессии: выкинуты самые старые (beta/ghost), свежие на месте',
        !capList.json.sessions.some((e) => e.id === 'beta') &&
            !capList.json.sessions.some((e) => e.id === 'ghost') &&
            capList.json.sessions.some((e) => e.id === 'cap-51')
    );
    // evicted-слот жив (ключи не удалялись) и пересоздаёт строку при записи
    await stateApi.PUT(req('PUT', 'https://x/api/state', state, H('beta')));
    const listBeta = await body(await sessionsApi.GET());
    check(
        'сессии: evicted beta вернулась в индекс записью (cap держится)',
        listBeta.json.sessions.some((e) => e.id === 'beta') &&
            listBeta.json.sessions.length === 50 &&
            !listBeta.json.sessions.some((e) => e.id === 'cap-2')
    );
}
