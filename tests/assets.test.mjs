/**
 * Юнит-тесты контракта ассетов картинок (shared/assets.ts — чистый модуль,
 * общий для браузера/прод-функций/dev-сервера): формат ссылки
 * "asset:sha256-<hex>", вынос dataURL → ссылки (extract) с дедупликацией,
 * резолв ссылок → dataURL (apply), сквозной пропуск ссылок и поведение при
 * недоступном хэше/несрезолвленном ассете. Запуск: npm test (tests/run.mjs).
 */
import { createHash } from 'node:crypto';
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

const {
    ASSET_REF_PREFIX,
    ASSET_HASH_RE,
    isDataUrl,
    isAssetRef,
    hashFromRef,
    hasAssetRefs,
    extractAssetRefs,
    applyAssetRefs,
} = await jiti.import(`${ROOT}shared/assets.ts`);

const PNG_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const HASH_A = 'sha256-' + createHashHex(PNG_A);
const HASH_B = 'sha256-' + createHashHex(PNG_B);

// хэш-помощник теста: тот же алгоритм, что в браузере (crypto.subtle) и на
// сервере (node:crypto) — hex lowercase sha256 от точной строки
function createHashHex(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── формат ссылки и предикаты ──
{
    check('префикс ссылки — asset:', ASSET_REF_PREFIX === 'asset:');
    check('формат хэша: sha256-<64 hex lowercase>', ASSET_HASH_RE.test(HASH_A) && !ASSET_HASH_RE.test('sha256-ABC') && !ASSET_HASH_RE.test('sha256-' + '0'.repeat(63)));
    check('isDataUrl: только data:-строки', isDataUrl(PNG_A) && !isDataUrl('asset:sha256-x') && !isDataUrl('') && !isDataUrl(null));
    // isAssetRef — предикат по префиксу 'asset:' (валидацию хэша делает hashFromRef)
    check('isAssetRef: только asset:-ссылки', isAssetRef(`asset:${HASH_A}`) && isAssetRef('asset:sha256-short') && !isAssetRef(PNG_A) && !isAssetRef('sha256-x') && !isAssetRef(null));
    check('hashFromRef: валидная ссылка → хэш-ключ', hashFromRef(`asset:${HASH_B}`) === HASH_B);
    check('hashFromRef: мусор → null', hashFromRef('asset:xxx') === null && hashFromRef('') === null);
    check('hasAssetRefs: false без ссылок, true со ссылкой', hasAssetRefs({ compare: { refImage: PNG_A } }) === false && hasAssetRefs({ compare: { refImage: `asset:${HASH_A}` } }) === true);
}

// ── extract: замена, дедуп, сквозной пропуск, null-хэш ──
{
    const state = {
        compare: { refImage: PNG_A, mode: 'off' },
        base: { image: PNG_A, kind: 'image' },
        stage: { image: PNG_B },
    };
    const { state: light, assets } = await extractAssetRefs(state, (d) =>
        Promise.resolve('sha256-' + createHashHex(d))
    );
    check('extract: refImage/base.image/stage.image → ссылки', light.compare.refImage === `asset:${HASH_A}` && light.base.image === `asset:${HASH_A}` && light.stage.image === `asset:${HASH_B}`);
    check('extract: одинаковые dataURL дедуплицированы в один ключ', Object.keys(assets).length === 2 && assets[HASH_A] === PNG_A && assets[HASH_B] === PNG_B);
    check('extract: исходный объект не мутирован', state.compare.refImage === PNG_A && state.base.image === PNG_A);
    check('extract: соседние поля не тронуты', light.compare.mode === 'off' && light.base.kind === 'image');

    // ссылки проходят насквозь, инлайн рядом — выносится
    const mixed = {
        compare: { refImage: `asset:${HASH_A}` },
        base: { image: PNG_B },
    };
    const { state: mixed2, assets: mixedAssets } = await extractAssetRefs(mixed, (d) =>
        Promise.resolve('sha256-' + createHashHex(d))
    );
    check('extract: ссылка проходит насквозь', mixed2.compare.refImage === `asset:${HASH_A}`);
    check('extract: инлайн рядом с ссылкой вынесен', mixed2.base.image === `asset:${HASH_B}` && mixedAssets[HASH_B] === PNG_B);

    // без картинок — assets undefined, объект возвращён как есть
    const plain = { compare: { refImage: null }, base: { image: null } };
    const noImg = await extractAssetRefs(plain, () => Promise.resolve(null));
    check('extract: без dataURL — assets undefined, тот же объект', noImg.assets === undefined && noImg.state === plain);

    // хэш недоступен (небезопасный контекст) — инлайн остаётся, словарь пуст
    const { state: inline, assets: inlineAssets } = await extractAssetRefs(
        { compare: { refImage: PNG_A } },
        () => Promise.resolve(null)
    );
    check('extract: null-хэш — инлайн на месте, assets undefined', inline.compare.refImage === PNG_A && inlineAssets === undefined);
}

// ── apply: резолв, 404→null, отсутствие ссылок ──
{
    const withRefs = {
        compare: { refImage: `asset:${HASH_A}` },
        base: { image: `asset:${HASH_B}`, kind: 'image' },
        stage: { image: PNG_B }, // инлайн не трогаем
    };
    const resolved = await applyAssetRefs(withRefs, (hash) =>
        Promise.resolve(hash === HASH_A ? PNG_A : PNG_B)
    );
    check('apply: ссылки → dataURL', resolved.compare.refImage === PNG_A && resolved.base.image === PNG_B);
    check('apply: инлайн-dataURL не тронут', resolved.stage.image === PNG_B);
    check('apply: исходный объект не мутирован', withRefs.compare.refImage === `asset:${HASH_A}`);

    const missing = await applyAssetRefs(
        { compare: { refImage: `asset:${HASH_A}` }, base: { image: null } },
        () => Promise.resolve(null)
    );
    check('apply: несрезолвленная ссылка → null (рендер как без картинки)', missing.compare.refImage === null && missing.base.image === null);

    const noRefs = { compare: { refImage: PNG_A } };
    const same = await applyAssetRefs(noRefs, () => Promise.resolve('x'));
    check('apply: без ссылок — тот же объект без резолва', same === noRefs);

    // битая ссылка (не hex) — поле пустое, не падаем
    const bogus = await applyAssetRefs({ compare: { refImage: 'asset:garbage' } }, () => Promise.resolve(PNG_A));
    check('apply: битый формат ссылки → null', bogus.compare.refImage === null);
}
