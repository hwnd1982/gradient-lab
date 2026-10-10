import { blurRectBox, isFullRect, type AxisBox } from './lib/axis';
import type { BlurRect, BlockState, Gradient, GradientTarget } from './types';

/**
 * Таргеты, чей градиент CSS считает от border-box blur-элемента (blur.rect),
 * а не от блока: ось/центр/радиусы живут в системе координат rect.
 */
export function isBlurRectTarget(kind: GradientTarget['kind']): boolean {
    return kind === 'blurBg' || kind === 'blurMask';
}

/**
 * Таргеты альфа-фейда по природе (маска блока, маска и градиент blur,
 * подложка затемнения): сэмплы/предложенные стопы берутся как у масок —
 * цвет чёрный, работает альфа.
 */
export function isAlphaTarget(kind: GradientTarget['kind']): boolean {
    return kind === 'mask' || kind === 'blurMask' || kind === 'blurBg' || kind === 'underlay';
}

/**
 * rect-область (% блока), в системе координат которой считается градиент
 * таргета: blurBg/blurMask — blur.rect, underlay — underlay.rect,
 * layer:N — rect слоя, undefined — весь блок (оси/центры в % блока).
 * Полный rect слоя ({0,0,100,100}) нормализуем в undefined — поведение
 * бит-в-бит как до появления rect у слоёв.
 */
export function targetAxisRect(state: BlockState, target: GradientTarget): BlurRect | undefined {
    if (target.kind === 'underlay') {
        return state.blur.underlay.enabled ? state.blur.underlay.rect : undefined;
    }
    if (isBlurRectTarget(target.kind) && state.blur.enabled) {
        return state.blur.rect;
    }
    if (target.kind === 'layer') {
        const layer = state.layers[target.index];
        return layer !== undefined && !isFullRect(layer.rect) ? layer.rect : undefined;
    }
    return undefined;
}

/** Тот же rect, переведённый в px-систему box (блок, стейдж или канвас анализа). */
export function targetAxisBox(
    state: BlockState,
    target: GradientTarget,
    box: AxisBox
): AxisBox | undefined {
    const rect = targetAxisRect(state, target);
    return rect === undefined ? undefined : blurRectBox(rect, box);
}

/** Канонический ключ таргета для API (analysis.target, ?target=...). */
export function targetToKey(t: GradientTarget): string {
    switch (t.kind) {
        case 'layer':
            return `layer:${t.index}`;
        case 'mask':
            return 'blockMask';
        default:
            return t.kind;
    }
}

const KEY_TARGETS: Record<string, GradientTarget> = {
    base: { kind: 'base' },
    blurMask: { kind: 'blurMask' },
    blurBg: { kind: 'blurBg' },
    underlay: { kind: 'underlay' },
    clipText: { kind: 'clipText' },
    animFrom: { kind: 'animFrom' },
    animTo: { kind: 'animTo' },
};

/** Ключ API -> таргет; 'mask' — алиас канонического 'blockMask'. null — неизвестный ключ. */
export function targetFromString(s: string): GradientTarget | null {
    if (s === 'blockMask' || s === 'mask') return { kind: 'mask' };
    if (s in KEY_TARGETS) return KEY_TARGETS[s];
    const m = s.match(/^layer:(\d+)$/);
    if (m !== null) return { kind: 'layer', index: Number(m[1]) };
    return null;
}

/** Читает градиент таргета из стейта (null, если таргет невалиден). */
export function readGradient(state: BlockState, target: GradientTarget): Gradient | null {
    switch (target.kind) {
        case 'base':
            return state.base.gradient;
        case 'layer':
            return state.layers[target.index]?.gradient ?? null;
        case 'mask':
            return state.mask.gradient;
        case 'blurMask':
            return state.blur.mask;
        case 'blurBg':
            return state.blur.gradient;
        case 'underlay':
            return state.blur.underlay.gradient;
        case 'clipText':
            return state.clipText.gradient;
        case 'animFrom':
            return state.anim.from;
        case 'animTo':
            return state.anim.to;
    }
}

/** Пишет градиент таргета в draft-стейт (используется внутри store.update). */
export function assignGradient(state: BlockState, target: GradientTarget, next: Gradient): void {
    switch (target.kind) {
        case 'base':
            state.base.gradient = next;
            break;
        case 'layer': {
            const layer = state.layers[target.index];
            if (layer) layer.gradient = next;
            break;
        }
        case 'mask':
            state.mask.gradient = next;
            break;
        case 'blurMask':
            state.blur.mask = next;
            break;
        case 'blurBg':
            state.blur.gradient = next;
            break;
        case 'underlay':
            state.blur.underlay.gradient = next;
            break;
        case 'clipText':
            state.clipText.gradient = next;
            break;
        case 'animFrom':
            state.anim.from = next;
            break;
        case 'animTo':
            state.anim.to = next;
            break;
    }
}
