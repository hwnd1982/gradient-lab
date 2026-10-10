import type { BlockState } from '../types';

/**
 * Мерж visual-полей пресета в draft (применение через store.update — undoable).
 * Пресет не двигает блок и не трогает сравнение: x/y/stage/compare не перезаписываются.
 * Значения клонируются — объекты пресета не шарятся со стейтом.
 */
export function mergePresetInto(draft: BlockState, apply: Partial<BlockState>): void {
    if (apply.w !== undefined) draft.w = apply.w;
    if (apply.h !== undefined) draft.h = apply.h;
    if (apply.radius !== undefined) draft.radius = apply.radius;
    if (apply.base !== undefined) draft.base = structuredClone(apply.base);
    if (apply.layers !== undefined) draft.layers = structuredClone(apply.layers);
    if (apply.mask !== undefined) draft.mask = structuredClone(apply.mask);
    if (apply.blur !== undefined) draft.blur = structuredClone(apply.blur);
    if (apply.blockBlend !== undefined) draft.blockBlend = apply.blockBlend;
    if (apply.clipText !== undefined) draft.clipText = structuredClone(apply.clipText);
    if (apply.anim !== undefined) draft.anim = structuredClone(apply.anim);
}

/** Полный стейт из базового + visual-поля пресета (для мини-превью). */
export function applyPresetFields(base: BlockState, apply: Partial<BlockState>): BlockState {
    const next = structuredClone(base);
    mergePresetInto(next, apply);
    return next;
}
