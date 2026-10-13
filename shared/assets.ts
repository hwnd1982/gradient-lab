/**
 * Ассет-ссылки картинок стейта — экономия bandwidth Upstash (2026-10-13:
 * база ушла в suspend на 12 GB / 10 GB в месяц из-за мегабайтных dataURL,
 * гоняемых туда-обратно каждым полл-тиком и синком).
 *
 * В ХРАНИМОМ стейте (слот lab:s/<id> в KV, dev-кэш сервера) поля
 * compare.refImage / base.image / stage.image вместо dataURL несут строку
 * "asset:sha256-<hex>" (hex = sha256 от ТОЧНОЙ dataURL-строки, lowercase).
 * Сама dataURL лежит отдельным ключом lab:asset:sha256-<hex> (SETNX — каждая
 * уникальная картинка пишется один раз) и раздаётся GET /api/asset/<hash>.
 * Локальный стейт браузера всегда хранит dataURL (рендер/анализ/экспорт не
 * меняются) — трансляция только на границе транспорта.
 *
 * Модуль чистый: без zod/node/dom — используется клиентом, прод-функциями и
 * dev-сервером; хэширование и резолв инжектируются вызывающей стороной.
 */

/**
 * Префикс ссылки на ассет в полях-картинках стейта. Полный формат —
 * "asset:sha256-<hex>" (хэш-ключ с собственным префиксом 'sha256-').
 */
export const ASSET_REF_PREFIX = 'asset:';

/** Ключ ассета: в assets-словаре тела sync/PUT и в пути /api/asset/<hash>. */
export const ASSET_HASH_RE = /^sha256-[0-9a-f]{64}$/;

/** Поля-картинки BlockState (dot-пути), выносимые в ассеты. */
export const ASSET_IMAGE_FIELDS: ReadonlyArray<{ top: string; key: string }> = [
    { top: 'compare', key: 'refImage' },
    { top: 'base', key: 'image' },
    { top: 'stage', key: 'image' },
];

/** dataURL-строка (поле-картинка с инлайн-содержимым)? */
export function isDataUrl(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith('data:');
}

/** Ссылка на ассет вида "asset:sha256-<hex>"? */
export function isAssetRef(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(ASSET_REF_PREFIX);
}

/** Хэш-часть ссылки ('sha256-<hex>') или null для чужого формата. */
export function hashFromRef(ref: string): string | null {
    const hash = ref.slice(ASSET_REF_PREFIX.length);
    return ASSET_HASH_RE.test(hash) ? hash : null;
}

interface ImageValue {
    top: string;
    key: string;
    value: string;
}

function collectImages(state: object, pred: (v: unknown) => v is string): ImageValue[] {
    const record = state as Record<string, unknown>;
    const out: ImageValue[] = [];
    for (const f of ASSET_IMAGE_FIELDS) {
        const owner = record[f.top];
        if (owner === null || typeof owner !== 'object') continue;
        const v = (owner as Record<string, unknown>)[f.key];
        if (pred(v)) out.push({ top: f.top, key: f.key, value: v });
    }
    return out;
}

/** В стейте есть хотя бы одна ссылка asset:sha256-*? */
export function hasAssetRefs(state: object): boolean {
    return collectImages(state, isAssetRef).length > 0;
}

export interface ExtractedAssets<S> {
    /** стейт с заменёнными картинками (копия; null-хэш оставляет инлайн) */
    state: S;
    /** dataURL по хэш-ключу ('sha256-<hex>' → dataURL); undefined — выносить нечего */
    assets: Record<string, string> | undefined;
}

/**
 * Заменить dataURL-картинки на ассет-ссылки. toRef возвращает хэш-часть
 * ('sha256-<hex>') или null — хэш недоступен, поле остаётся инлайном (тогда
 * обе стороны сравнения тоже инлайн, байт-в-байт работает). Исходный объект
 * не мутируется (shallow-копии только затронутых веток). Одинаковые dataURL
 * в разных полях дедуплицируются в один ключ.
 */
export async function extractAssetRefs<S extends object>(
    state: S,
    toRef: (dataUrl: string) => Promise<string | null>
): Promise<ExtractedAssets<S>> {
    const found = collectImages(state, isDataUrl);
    if (found.length === 0) return { state, assets: undefined };
    const refs = await Promise.all(found.map((f) => toRef(f.value)));
    const next: Record<string, unknown> = { ...(state as Record<string, unknown>) };
    // копии затронутых веток + индекс копий: исходный объект не мутируем
    const copies = new Map<string, Record<string, unknown>>();
    for (const top of new Set(found.map((f) => f.top))) {
        const copy = { ...(next[top] as object) } as Record<string, unknown>;
        copies.set(top, copy);
        next[top] = copy;
    }
    const assets: Record<string, string> = {};
    found.forEach((f, i) => {
        const hash = refs[i];
        if (hash === null) return;
        copies.get(f.top)![f.key] = `${ASSET_REF_PREFIX}${hash}`;
        assets[hash] = f.value;
    });
    return { state: next as S, assets: Object.keys(assets).length > 0 ? assets : undefined };
}

/**
 * Резолвить ассет-ссылки обратно в dataURL (применение чужого стейта).
 * resolve возвращает dataURL или null — ассета нет, поле становится null
 * (та же семантика, что у стейта без картинки — рендер не ломается).
 */
export async function applyAssetRefs<S extends object>(
    state: S,
    resolve: (hash: string) => Promise<string | null>
): Promise<S> {
    const found = collectImages(state, isAssetRef);
    if (found.length === 0) return state;
    const dataUrls = await Promise.all(
        found.map((f) => {
            const hash = hashFromRef(f.value);
            return hash === null ? Promise.resolve(null) : resolve(hash);
        })
    );
    const next: Record<string, unknown> = { ...(state as Record<string, unknown>) };
    // копии затронутых веток + индекс копий: исходный объект не мутируем
    const copies = new Map<string, Record<string, unknown>>();
    for (const top of new Set(found.map((f) => f.top))) {
        const copy = { ...(next[top] as object) } as Record<string, unknown>;
        copies.set(top, copy);
        next[top] = copy;
    }
    found.forEach((f, i) => {
        copies.get(f.top)![f.key] = dataUrls[i] ?? null;
    });
    return next as S;
}
