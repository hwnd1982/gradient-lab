import type { BlockState } from '../types';

/**
 * Резолвер путей sweep (POST /api/sweep): dot-путь числового листа стейта →
 * значение/запись. Грамматика сегментов (после split('.')): именованные узлы
 * `blur|mask|base|layers|gradient|underlay|stops`, индексные доступы
 * `stops[N]`/`layers[N]` (скобки, каноничны для агента) и голые числа
 * (`stops.2` — формат журнала); последний сегмент — имя числового листа
 * (`radius|angle|alpha|opacity`). Формат пути в целом (белый список семейств)
 * проверяет SWEEP_FIELD_RE в schema.ts на POST; здесь — существование пути в
 * конкретном стейте: null/градиент не задан, индекс за диапазоном, на конце
 * не число → null/false, без бросков.
 */

/** Именованные узлы стейта, допустимые внутри пути (не последний сегмент). */
const NAME_SEGMENT = /^(?:blur|mask|base|layers|gradient|underlay|stops)$/;

/** Имена числовых листьев — единственно допустимый последний сегмент. */
const LEAF_SEGMENT = /^(?:radius|angle|alpha|opacity)$/;

/** Скобочный индексный доступ: `stops[2]`, `layers[0]`. */
const BRACKET_SEGMENT = /^(stops|layers)\[(\d+)\]$/;

type PathToken = { kind: 'name'; name: string } | { kind: 'index'; index: number };

/** Сентинел отсутствия значения при обходе (отличен от легитимных null-полей). */
const MISSING = Symbol('missing');

/**
 * Путь → токены; null — грамматика нарушена (не-именованный сегмент, индекс
 * или число в позиции листа, пустой сегмент).
 */
function tokenizePath(path: string): PathToken[] | null {
    const segments = path.split('.');
    const tokens: PathToken[] = [];
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const isLeaf = i === segments.length - 1;
        const bracket = BRACKET_SEGMENT.exec(seg);
        if (bracket !== null) {
            if (isLeaf) return null; // доступ — не лист
            tokens.push({ kind: 'name', name: bracket[1] });
            tokens.push({ kind: 'index', index: Number(bracket[2]) });
            continue;
        }
        if (/^\d+$/.test(seg)) {
            if (isLeaf) return null; // индекс — не лист
            tokens.push({ kind: 'index', index: Number(seg) });
            continue;
        }
        if (!isLeaf && !NAME_SEGMENT.test(seg)) return null;
        tokens.push({ kind: 'name', name: seg });
    }
    return tokens;
}

/** Один шаг обхода: свойство объекта или элемент массива; MISSING — мимо. */
function stepInto(cur: unknown, token: PathToken): unknown {
    if (token.kind === 'index') {
        if (!Array.isArray(cur)) return MISSING;
        const v = cur[token.index];
        return v === undefined ? MISSING : v;
    }
    if (cur === null || typeof cur !== 'object') return MISSING;
    const v = (cur as Record<string, unknown>)[token.name];
    return v === undefined ? MISSING : v;
}

/** Точка числового листа: объект-контейнер + имя листа в нём. */
interface LeafSpot {
    container: Record<string, unknown>;
    key: string;
}

/**
 * Обход до контейнера числового листа (единый резолвер для чтения и записи):
 * токенизация пути + проверка листа на имя из белого списка + спуск по
 * токенам до объекта-владельца. null — грамматика нарушена, путь не
 * существует, контейнер — массив/примитив.
 */
function resolveLeafSpot(root: unknown, path: string): LeafSpot | null {
    const tokens = tokenizePath(path);
    if (tokens === null) return null;
    const leaf = tokens[tokens.length - 1];
    if (leaf.kind !== 'name' || !LEAF_SEGMENT.test(leaf.name)) return null;
    let cur: unknown = root;
    for (let i = 0; i < tokens.length - 1; i++) {
        cur = stepInto(cur, tokens[i]);
        if (cur === MISSING) return null;
    }
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return null;
    return { container: cur as Record<string, unknown>, key: leaf.name };
}

/** Текущее числовое значение пути в стейте; null — путь не существует/не число. */
export function resolveNumericPath(state: BlockState, path: string): number | null {
    const spot = resolveLeafSpot(state, path);
    if (spot === null) return null;
    const value = spot.container[spot.key];
    return typeof value === 'number' ? value : null;
}

/**
 * Записать значение по пути в draft (мутация — вызывается на structuredClone
 * в store.update); false — путь не существует или на конце не число, draft
 * не тронут.
 */
export function applyNumericPath(draft: BlockState, path: string, value: number): boolean {
    const spot = resolveLeafSpot(draft, path);
    if (spot === null) return false;
    if (typeof spot.container[spot.key] !== 'number') return false;
    spot.container[spot.key] = value;
    return true;
}
