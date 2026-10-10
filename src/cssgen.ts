import type { CSSProperties } from 'react';
import { fmtNum, hexToRgb, rgbToHex, rgbaString } from './lib/color';
import { isFullRect } from './lib/axis';
import { uid } from './schema';
import type { BlockState, Gradient, Stop } from './types';

export interface BaseImageHint {
    src: string;
    fit: 'cover' | 'contain' | 'fill';
    posX: number;
    posY: number;
}

export interface PreviewResult {
    block: CSSProperties;
    blur: CSSProperties | null;
    /** подложка затемнения под blur (base → layers → underlay → blur) */
    underlay: CSSProperties | null;
    layers: CSSProperties[];
    baseImage: BaseImageHint | null;
    /**
     * Вуаль базового градиента поверх картинки (base.kind='image'): тот же
     * base.gradient, но слоем над <img>. Alpha-профиль решает видимость —
     * стопы со всеми α=0 дают невидимый, но корректный слой CSS.
     */
    baseVeil: CSSProperties | null;
}

/** 'rgba(r, g, b, a) pos%' — pos без clamp, может быть -13.94% / 116.91%. */
export function stopsToCss(stops: Stop[]): string {
    return stops.map((s) => `${rgbaString(s.color, s.alpha)} ${fmtNum(s.pos)}%`).join(', ');
}

/** Детерминированный 32-битный hash — джиттер стабилен между копированиями. */
function hash32(n: number): number {
    let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

/** Кусочно-линейное значение градиента в позиции pos (за краями — цвет крайнего стопа). */
function interpAt(stops: Stop[], pos: number): { color: string; alpha: number } {
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (pos <= first.pos) return { color: first.color, alpha: first.alpha };
    if (pos >= last.pos) return { color: last.color, alpha: last.alpha };
    for (let i = 1; i < stops.length; i++) {
        if (pos <= stops[i].pos) {
            const a = stops[i - 1];
            const b = stops[i];
            const f = (pos - a.pos) / (b.pos - a.pos);
            const ca = hexToRgb(a.color);
            const cb = hexToRgb(b.color);
            return {
                color: rgbToHex(
                    ca.r + (cb.r - ca.r) * f,
                    ca.g + (cb.g - ca.g) * f,
                    ca.b + (cb.b - ca.b) * f
                ),
                alpha: a.alpha + (b.alpha - a.alpha) * f,
            };
        }
    }
    return { color: last.color, alpha: last.alpha };
}

/** Верхняя планка стопов анти-бэндинга (12–16 по ТЗ: равномерных + ключевых). */
const ANTIBAND_MAX = 16;
const ANTIBAND_UNIFORM = 14;
/** Минимальный отступ равномерного стопа от ключевого, %. */
const ANTIBAND_KEY_GAP = 1.5;
/** Амплитуда джиттера канала (±, единиц 0..255). */
const ANTIBAND_JITTER = 2;

/**
 * Анти-бэндинг стопов (экспорт-пост-процесс, стейт не меняет): ресэмпл до
 * 12–16 стопов — равномерная сетка + ключевые (локальные экстремумы альфы)
 * точно как есть; не-ключевые стопы получают детерминированный дизеринг
 * ±1–2 по каналам от hash позиции (экспорт стабилен между копированиями).
 */
export function antiBandStops(stops: Stop[]): Stop[] {
    if (stops.length < 2) return stops;
    const sorted = [...stops].sort((a, b) => a.pos - b.pos);
    // ключевые: локальные экстремумы альфы (перегибы формы — их двигать нельзя)
    const keyIdx = new Set<number>();
    for (let i = 1; i < sorted.length - 1; i++) {
        const dPrev = sorted[i].alpha - sorted[i - 1].alpha;
        const dNext = sorted[i + 1].alpha - sorted[i].alpha;
        if (dPrev * dNext < 0) keyIdx.add(i);
    }
    const keys = sorted.filter((_, i) => keyIdx.has(i));
    // равномерная сетка, не прилипающая к ключевым позициям
    const uniform: number[] = [];
    for (let i = 0; i < ANTIBAND_UNIFORM; i++) {
        const pos = (i / (ANTIBAND_UNIFORM - 1)) * 100;
        if (keys.every((k) => Math.abs(k.pos - pos) >= ANTIBAND_KEY_GAP)) uniform.push(pos);
    }
    // если превысили лимит — прореживаем сетку равномерно до влезания под
    // ANTIBAND_MAX (ключи неприкосновенны); фильтр может дать room+1 (последний
    // индекс не лёг на шаг) — подрезаем до room, заменяя хвост на финальный
    // стоп, так что кап строгий и последний стоп гарантирован; room=0 —
    // сетка не влезает вовсе (i % Infinity === i оставлял бы её целиком).
    // Оговорка: при keys > ANTIBAND_MAX (недостижимо из штатных потоков:
    // автофит ≤8, suggestedStops ≤12) ключи выводятся как есть — кап неустраним
    // без нарушения «ключи точно как есть»
    const room = Math.max(0, ANTIBAND_MAX - keys.length);
    let grid = uniform;
    if (uniform.length > room) {
        if (room === 0) {
            grid = [];
        } else {
            const step = Math.ceil((uniform.length - 1) / room);
            const picked = uniform.filter((_, i) => i % step === 0 || i === uniform.length - 1);
            grid =
                picked.length > room
                    ? [...picked.slice(0, room - 1), picked[picked.length - 1]]
                    : picked;
        }
    }
    const out: Stop[] = [...keys];
    for (const pos of grid) {
        const v = interpAt(sorted, pos);
        // дизеринг: ±ANTIBAND_JITTER по r/g/b, детерминированно от позиции
        const c = hexToRgb(v.color);
        const h = hash32(Math.round(pos * 100));
        const jr = (h % (ANTIBAND_JITTER * 2 + 1)) - ANTIBAND_JITTER;
        const jg = (Math.floor(h / 7) % (ANTIBAND_JITTER * 2 + 1)) - ANTIBAND_JITTER;
        const jb = (Math.floor(h / 61) % (ANTIBAND_JITTER * 2 + 1)) - ANTIBAND_JITTER;
        out.push({
            id: uid(),
            pos: Math.round(pos * 10) / 10,
            color: rgbToHex(c.r + jr, c.g + jg, c.b + jb),
            alpha: v.alpha,
        });
    }
    return out.sort((a, b) => a.pos - b.pos);
}

/**
 * linear: 'linear-gradient(180deg, rgba(16,16,16,0) 0%, ...)'
 * radial: 'radial-gradient(ellipse farthest-side at 130% 50%, ...)';
 * explicit-размер рендерится как 'ellipse Rx% Ry% at ...' (%-радиус у circle в CSS невалиден).
 * opts.antiBand — пост-процесс стопов против бэндинга (только текст экспорта).
 */
export function gradientToCss(g: Gradient, opts: { antiBand?: boolean } = {}): string {
    const stops = opts.antiBand === true ? antiBandStops(g.stops) : g.stops;
    const prefix = g.repeating ? 'repeating-' : '';
    if (g.type === 'linear') {
        return `${prefix}linear-gradient(${fmtNum(g.angle)}deg, ${stopsToCss(stops)})`;
    }
    const shape =
        g.size === 'explicit'
            ? `ellipse ${fmtNum(g.rx)}% ${fmtNum(g.ry)}%`
            : `${g.shape} ${g.size}`;
    return `${prefix}radial-gradient(${shape} at ${fmtNum(g.cx)}% ${fmtNum(g.cy)}%, ${stopsToCss(stops)})`;
}

/** Та же строка для -webkit-mask-image и mask-image. */
export function maskToCss(
    g: Gradient | null,
    opts: { antiBand?: boolean } = {}
): { webkit: string; std: string } | null {
    if (!g) return null;
    const value = gradientToCss(g, opts);
    return { webkit: value, std: value };
}

function cssFit(fit: 'cover' | 'contain' | 'fill'): string {
    if (fit === 'fill') return '100% 100%';
    return fit;
}

/**
 * Стили превью: блок, градиентные слои, blur-слой и картинка базы.
 * Порядок отрисовки (BlockBox) как в экспорте: base → слои → blur.
 * Слои возвращаются для всех элементов массива state.layers —
 * невидимые (visible: false) вызывающий код пропускает сам.
 */
export function stateToPreview(state: BlockState): PreviewResult {
    const block: CSSProperties = {
        position: 'absolute',
        left: state.x,
        top: state.y,
        width: state.w,
        height: state.h,
        borderRadius: state.radius,
        overflow: 'hidden',
        mixBlendMode: state.blockBlend,
        touchAction: 'none',
        // backdrop root: blur-слой сэмплит только содержимое блока (B1)
        isolation: state.stage.isolated ? 'isolate' : 'auto',
    };
    if (state.base.kind === 'color') {
        block.backgroundColor = state.base.color;
    } else if (state.base.kind === 'gradient') {
        block.background = gradientToCss(state.base.gradient);
    }
    const mask = state.mask.enabled ? maskToCss(state.mask.gradient) : null;
    if (mask) {
        block.WebkitMaskImage = mask.webkit;
        block.maskImage = mask.std;
    }

    // blur — ОДИН элемент ограниченной rect-области: фон + backdrop-filter + маска вместе
    const blur: CSSProperties | null = state.blur.enabled
        ? {
              position: 'absolute',
              left: `${fmtNum(state.blur.rect.x)}%`,
              top: `${fmtNum(state.blur.rect.y)}%`,
              width: `${fmtNum(state.blur.rect.w)}%`,
              height: `${fmtNum(state.blur.rect.h)}%`,
              backdropFilter: `blur(${fmtNum(state.blur.radius)}px)`,
              WebkitBackdropFilter: `blur(${fmtNum(state.blur.radius)}px)`,
          }
        : null;
    if (blur) {
        blur.background =
            state.blur.gradient !== null
                ? gradientToCss(state.blur.gradient)
                : (state.blur.background ?? undefined);
        const blurMask = maskToCss(state.blur.mask);
        if (blurMask) {
            blur.WebkitMaskImage = blurMask.webkit;
            blur.maskImage = blurMask.std;
        }
    }

    // underlay — подложка затемнения ПОД blur-div: своя rect, без маски и блюра
    const underlay: CSSProperties | null = state.blur.underlay.enabled
        ? {
              position: 'absolute',
              left: `${fmtNum(state.blur.underlay.rect.x)}%`,
              top: `${fmtNum(state.blur.underlay.rect.y)}%`,
              width: `${fmtNum(state.blur.underlay.rect.w)}%`,
              height: `${fmtNum(state.blur.underlay.rect.h)}%`,
              background:
                  state.blur.underlay.gradient !== null
                      ? gradientToCss(state.blur.underlay.gradient)
                      : (state.blur.underlay.color ?? undefined),
          }
        : null;

    // слои позиционируются по своему rect: полный — как раньше inset: 0,
    // иначе left/top/width/height в % от блока (градиент — от border-box слоя)
    const layers: CSSProperties[] = state.layers.map((layer) => ({
        position: 'absolute',
        ...(isFullRect(layer.rect)
            ? { inset: 0 }
            : {
                  left: `${fmtNum(layer.rect.x)}%`,
                  top: `${fmtNum(layer.rect.y)}%`,
                  width: `${fmtNum(layer.rect.w)}%`,
                  height: `${fmtNum(layer.rect.h)}%`,
              }),
        backgroundImage: gradientToCss(layer.gradient),
        opacity: layer.opacity,
        mixBlendMode: layer.blend,
    }));

    const baseImage: BaseImageHint | null =
        state.base.kind === 'image' && state.base.image
            ? {
                  src: state.base.image,
                  fit: state.base.fit,
                  posX: state.base.posX,
                  posY: state.base.posY,
              }
            : null;

    // вуаль: base.gradient применяется и при kind='image' — градиентом поверх
    // картинки (в экспорте — первым слоем multiple backgrounds)
    const baseVeil: CSSProperties | null =
        state.base.kind === 'image'
            ? { position: 'absolute', inset: 0, background: gradientToCss(state.base.gradient) }
            : null;

    return { block, blur, underlay, layers, baseImage, baseVeil };
}

/** Размер шрифта текста с градиентной заливкой (простая пропорция от ширины). */
export function clipTextFontSize(state: BlockState): number {
    return Math.max(10, Math.round(state.w / 6));
}

/** Свойства текстового div для clip-text (единые для превью и экспорта значений). */
export function clipTextFontDeclarations(state: BlockState): string[] {
    return [
        `font-size: ${fmtNum(clipTextFontSize(state))}px;`,
        'line-height: 1;',
        'white-space: nowrap;',
        'overflow: hidden;',
    ];
}

/** Опции текстового экспорта (CodePanel): анти-бэндинг — только текст, стейт не трогает. */
export interface ExportTextOpts {
    antiBand?: boolean;
}

/** Отформатированный CSS для копирования в проект (класс .gradient-block). */
export function stateToCssText(state: BlockState, opts: ExportTextOpts = {}): string {
    const out: string[] = [];
    const g = (grad: Gradient): string => gradientToCss(grad, opts);

    const block: string[] = ['    position: relative;'];
    block.push(`    width: ${fmtNum(state.w)}px;`);
    block.push(`    height: ${fmtNum(state.h)}px;`);
    block.push(`    border-radius: ${fmtNum(state.radius)}px;`);
    block.push('    overflow: hidden;');
    if (state.stage.isolated) {
        block.push('    isolation: isolate;');
    }
    if (state.base.kind === 'color') {
        block.push(`    background-color: ${state.base.color};`);
    } else if (state.base.kind === 'gradient') {
        block.push(`    background: ${g(state.base.gradient)};`);
    } else if (state.base.image) {
        // вуаль градиентом поверх картинки: multiple backgrounds, градиент
        // ПЕРВЫМ слоем; size/position одним значением применяются к обоим
        // слоям (для градиента без интринсик-размера — no-op)
        block.push(`    background-image: ${g(state.base.gradient)}, url("${state.base.image}");`);
        block.push(`    background-size: ${cssFit(state.base.fit)};`);
        block.push(
            `    background-position: ${fmtNum(state.base.posX)}% ${fmtNum(state.base.posY)}%;`
        );
    }
    if (state.blockBlend !== 'normal') {
        block.push(`    mix-blend-mode: ${state.blockBlend};`);
    }
    // при anim.enabled покой блока = anim.from (как в лаборатории), state.mask не эмитим;
    // .is-anim-from ниже при этом дублирует базу — осознанно, для явного переключения классом
    const animMask = state.anim.enabled ? g(state.anim.from) : null;
    const mask =
        animMask === null && state.mask.enabled ? maskToCss(state.mask.gradient, opts) : null;
    if (animMask !== null) {
        block.push(`    -webkit-mask-image: ${animMask};`);
        block.push(`    mask-image: ${animMask};`);
    } else if (mask) {
        block.push(`    -webkit-mask-image: ${mask.webkit};`);
        block.push(`    mask-image: ${mask.std};`);
    }
    if (state.anim.enabled) {
        block.push(
            `    transition: mask ${fmtNum(state.anim.duration)}ms linear, -webkit-mask ${fmtNum(state.anim.duration)}ms linear;`
        );
    }
    out.push('.gradient-block {', ...block, '}');

    if (state.anim.enabled) {
        out.push(
            '',
            '/* переключение класса запускает анимацию маски */',
            '.gradient-block.is-anim-from {',
            `    -webkit-mask-image: ${g(state.anim.from)};`,
            `    mask-image: ${g(state.anim.from)};`,
            '}',
            '.gradient-block.is-anim-to {',
            `    -webkit-mask-image: ${g(state.anim.to)};`,
            `    mask-image: ${g(state.anim.to)};`,
            '}'
        );
    }

    state.layers.forEach((layer, i) => {
        out.push('', `/* слой ${i + 1} */`, `.gradient-block__layer--${i + 1} {`);
        out.push('    position: absolute;');
        // rect слоя: полный — короткое inset: 0, иначе 4 декларации отдельными
        // строками (как у __blur; в indented Sass запятые дали бы мусорный список)
        if (isFullRect(layer.rect)) {
            out.push('    inset: 0;');
        } else {
            out.push(`    left: ${fmtNum(layer.rect.x)}%;`);
            out.push(`    top: ${fmtNum(layer.rect.y)}%;`);
            out.push(`    width: ${fmtNum(layer.rect.w)}%;`);
            out.push(`    height: ${fmtNum(layer.rect.h)}%;`);
        }
        out.push(`    background-image: ${g(layer.gradient)};`);
        if (layer.opacity !== 1) {
            out.push(`    opacity: ${fmtNum(layer.opacity)};`);
        }
        if (layer.blend !== 'normal') {
            out.push(`    mix-blend-mode: ${layer.blend};`);
        }
        out.push('}');
    });

    if (state.blur.underlay.enabled) {
        out.push(
            '',
            '/* подложка затемнения под blur (::before): без блюра и маски, своя область */',
            '.gradient-block__blur-underlay {'
        );
        out.push('    position: absolute;');
        // rect — 4 декларации отдельными строками (как у __blur в Sass)
        out.push(`    left: ${fmtNum(state.blur.underlay.rect.x)}%;`);
        out.push(`    top: ${fmtNum(state.blur.underlay.rect.y)}%;`);
        out.push(`    width: ${fmtNum(state.blur.underlay.rect.w)}%;`);
        out.push(`    height: ${fmtNum(state.blur.underlay.rect.h)}%;`);
        if (state.blur.underlay.gradient !== null) {
            out.push(`    background: ${g(state.blur.underlay.gradient)};`);
        } else if (state.blur.underlay.color) {
            out.push(`    background: ${state.blur.underlay.color};`);
        }
        out.push('}');
    }

    if (state.blur.enabled) {
        out.push(
            '',
            '/* blur-слой: ограниченная область + фон + блюр + маска на одном элементе */'
        );
        out.push('.gradient-block__blur {');
        out.push('    position: absolute;');
        // rect — 4 декларации отдельными строками, как у __blur-underlay выше
        out.push(`    left: ${fmtNum(state.blur.rect.x)}%;`);
        out.push(`    top: ${fmtNum(state.blur.rect.y)}%;`);
        out.push(`    width: ${fmtNum(state.blur.rect.w)}%;`);
        out.push(`    height: ${fmtNum(state.blur.rect.h)}%;`);
        out.push(`    -webkit-backdrop-filter: blur(${fmtNum(state.blur.radius)}px);`);
        out.push(`    backdrop-filter: blur(${fmtNum(state.blur.radius)}px);`);
        if (state.blur.gradient !== null) {
            out.push(`    background: ${g(state.blur.gradient)};`);
        } else if (state.blur.background) {
            out.push(`    background: ${state.blur.background};`);
        }
        const blurMask = maskToCss(state.blur.mask, opts);
        if (blurMask) {
            out.push(`    -webkit-mask-image: ${blurMask.webkit};`);
            out.push(`    mask-image: ${blurMask.std};`);
        }
        out.push('}');
    }

    if (state.clipText.enabled) {
        out.push('', '/* текст с градиентом */', '.gradient-block__text {');
        out.push('    position: absolute;', '    inset: 0;');
        out.push('    display: flex;', '    align-items: center;', '    justify-content: center;');
        out.push(`    background-image: ${g(state.clipText.gradient)};`);
        out.push('    -webkit-background-clip: text;', '    background-clip: text;');
        out.push('    color: transparent;');
        out.push(...clipTextFontDeclarations(state).map((line) => `    ${line.trim()}`));
        out.push('}');
    }

    return `${out.join('\n')}\n`;
}

/** То же в indented Sass (4 пробела), градиенты вынесены в переменные $g-N. */
export function stateToSassText(state: BlockState, opts: ExportTextOpts = {}): string {
    const out: string[] = [];
    const g = (grad: Gradient): string => gradientToCss(grad, opts);

    const vars: string[] = [];
    if (state.base.kind === 'gradient') {
        vars.push(`$g-base: ${g(state.base.gradient)}`);
    } else if (state.base.kind === 'image' && state.base.image) {
        // вуаль поверх картинки (multiple backgrounds, градиент первым)
        vars.push(`$g-veil: ${g(state.base.gradient)}`);
    }
    state.layers.forEach((layer, i) => {
        vars.push(`$g-${i + 1}: ${g(layer.gradient)}`);
    });
    if (state.mask.enabled && !state.anim.enabled) {
        vars.push(`$mask: ${g(state.mask.gradient)}`);
    }
    if (state.blur.enabled && state.blur.gradient) {
        vars.push(`$blur-bg: ${g(state.blur.gradient)}`);
    }
    if (state.blur.underlay.enabled && state.blur.underlay.gradient) {
        vars.push(`$underlay-bg: ${g(state.blur.underlay.gradient)}`);
    }
    if (state.blur.enabled && state.blur.mask) {
        vars.push(`$blur-mask: ${g(state.blur.mask)}`);
    }
    if (state.clipText.enabled) {
        vars.push(`$text-gradient: ${g(state.clipText.gradient)}`);
    }
    if (state.anim.enabled) {
        vars.push(`$anim-from: ${g(state.anim.from)}`);
        vars.push(`$anim-to: ${g(state.anim.to)}`);
    }
    out.push(...vars, '');

    out.push('.gradient-block');
    out.push('    position: relative');
    out.push(`    width: ${fmtNum(state.w)}px`);
    out.push(`    height: ${fmtNum(state.h)}px`);
    out.push(`    border-radius: ${fmtNum(state.radius)}px`);
    out.push('    overflow: hidden');
    if (state.stage.isolated) {
        out.push('    isolation: isolate');
    }
    if (state.base.kind === 'color') {
        out.push(`    background-color: ${state.base.color}`);
    } else if (state.base.kind === 'gradient') {
        out.push('    background: $g-base');
    } else if (state.base.image) {
        out.push(`    background-image: $g-veil, url("${state.base.image}")`);
        out.push(`    background-size: ${cssFit(state.base.fit)}`);
        out.push(
            `    background-position: ${fmtNum(state.base.posX)}% ${fmtNum(state.base.posY)}%`
        );
    }
    if (state.blockBlend !== 'normal') {
        out.push(`    mix-blend-mode: ${state.blockBlend}`);
    }
    // при anim.enabled покой = anim.from ($mask тогда не эмитится);
    // &.is-anim-from ниже дублирует базу — осознанно, для явного переключения классом
    if (state.anim.enabled) {
        out.push('    -webkit-mask-image: $anim-from');
        out.push('    mask-image: $anim-from');
    } else if (state.mask.enabled) {
        out.push('    -webkit-mask-image: $mask');
        out.push('    mask-image: $mask');
    }
    if (state.anim.enabled) {
        out.push(
            `    transition: mask ${fmtNum(state.anim.duration)}ms linear, -webkit-mask ${fmtNum(state.anim.duration)}ms linear`
        );
        out.push('', '    // переключение класса запускает анимацию маски', '    &.is-anim-from');
        out.push('        -webkit-mask-image: $anim-from', '        mask-image: $anim-from');
        out.push('    &.is-anim-to');
        out.push('        -webkit-mask-image: $anim-to', '        mask-image: $anim-to');
    }

    state.layers.forEach((layer, i) => {
        out.push('', `    // слой ${i + 1}`, `    &__layer--${i + 1}`);
        out.push('        position: absolute');
        // rect слоя: полный — короткое inset: 0, иначе каждая декларация rect
        // отдельной строкой: в indented Sass запятые превратили бы это в одну
        // декларацию left с мусорным списком значений (как у __blur)
        if (isFullRect(layer.rect)) {
            out.push('        inset: 0');
        } else {
            out.push(`        left: ${fmtNum(layer.rect.x)}%`);
            out.push(`        top: ${fmtNum(layer.rect.y)}%`);
            out.push(`        width: ${fmtNum(layer.rect.w)}%`);
            out.push(`        height: ${fmtNum(layer.rect.h)}%`);
        }
        out.push(`        background-image: $g-${i + 1}`);
        if (layer.opacity !== 1) {
            out.push(`        opacity: ${fmtNum(layer.opacity)}`);
        }
        if (layer.blend !== 'normal') {
            out.push(`        mix-blend-mode: ${layer.blend}`);
        }
    });

    if (state.blur.underlay.enabled) {
        out.push(
            '',
            '    // подложка затемнения под blur (::before): без блюра и маски, своя область',
            '    &__blur-underlay'
        );
        out.push('        position: absolute');
        // каждая декларация rect отдельной строкой: в indented Sass запятые
        // превратили бы это в одну декларацию left с мусорным списком значений
        out.push(`        left: ${fmtNum(state.blur.underlay.rect.x)}%`);
        out.push(`        top: ${fmtNum(state.blur.underlay.rect.y)}%`);
        out.push(`        width: ${fmtNum(state.blur.underlay.rect.w)}%`);
        out.push(`        height: ${fmtNum(state.blur.underlay.rect.h)}%`);
        if (state.blur.underlay.gradient) {
            out.push('        background: $underlay-bg');
        } else if (state.blur.underlay.color) {
            out.push(`        background: ${state.blur.underlay.color}`);
        }
    }

    if (state.blur.enabled) {
        out.push(
            '',
            '    // blur-слой: ограниченная область + фон + блюр + маска на одном элементе',
            '    &__blur'
        );
        out.push('        position: absolute');
        // каждая декларация отдельной строкой: в indented Sass запятые
        // превратили бы это в одну декларацию left с мусорным списком значений
        out.push(`        left: ${fmtNum(state.blur.rect.x)}%`);
        out.push(`        top: ${fmtNum(state.blur.rect.y)}%`);
        out.push(`        width: ${fmtNum(state.blur.rect.w)}%`);
        out.push(`        height: ${fmtNum(state.blur.rect.h)}%`);
        out.push(`        -webkit-backdrop-filter: blur(${fmtNum(state.blur.radius)}px)`);
        out.push(`        backdrop-filter: blur(${fmtNum(state.blur.radius)}px)`);
        if (state.blur.gradient) {
            out.push('        background: $blur-bg');
        } else if (state.blur.background) {
            out.push(`        background: ${state.blur.background}`);
        }
        if (state.blur.mask) {
            out.push('        -webkit-mask-image: $blur-mask');
            out.push('        mask-image: $blur-mask');
        }
    }

    if (state.clipText.enabled) {
        out.push('', '    // текст с градиентом', '    &__text');
        out.push('        position: absolute', '        inset: 0');
        out.push(
            '        display: flex',
            '        align-items: center',
            '        justify-content: center'
        );
        out.push('        background-image: $text-gradient');
        out.push('        -webkit-background-clip: text');
        out.push('        background-clip: text');
        out.push('        color: transparent');
        out.push(...clipTextFontDeclarations(state).map((line) => `        ${line.trim()}`));
    }

    return `${out.join('\n')}\n`;
}
