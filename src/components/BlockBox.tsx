import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { clipTextFontSize, gradientToCss, stateToPreview } from '../cssgen';
import { fmtNum } from '../lib/color';
import { useLabStore } from '../store';

interface BlockBoxProps {
    onPointerDown?: (e: ReactPointerEvent) => void;
}

/** Фаза цикла проигрывания анимации маски. */
type AnimPhase = 'from' | 'to';

/** Визуал блока: base (цвет/img + вуаль градиента) -> градиентные слои -> underlay -> blur-слой (как в экспорте); clip-text вместо base. */
export function BlockBox({ onPointerDown }: BlockBoxProps) {
    const state = useLabStore((s) => s.state);
    const animPlaying = useLabStore((s) => s.animPlaying);
    const preview = useMemo(() => stateToPreview(state), [state]);
    const clip = state.clipText;
    const anim = state.anim;
    const [phase, setPhase] = useState<AnimPhase>('from');
    // после Stop показываем статичную маску из state.mask (до Stop — из anim.from);
    // переключения отслеживаем в подписке на стор — это внешнее событие
    const [staticAfterStop, setStaticAfterStop] = useState(false);
    useEffect(() => {
        let prevPlaying = useLabStore.getState().animPlaying;
        let prevEnabled = useLabStore.getState().state.anim.enabled;
        return useLabStore.subscribe((s) => {
            if (s.state.anim.enabled !== prevEnabled) {
                prevEnabled = s.state.anim.enabled;
                if (prevEnabled) setStaticAfterStop(false);
                return;
            }
            if (s.animPlaying !== prevPlaying) {
                const wasPlaying = prevPlaying;
                prevPlaying = s.animPlaying;
                setStaticAfterStop(wasPlaying && !s.animPlaying);
            }
        });
    }, []);

    // цикл: from —(переход dur + пауза 0.6·dur)→ to —(переход + пауза)→ from… до Stop
    useEffect(() => {
        if (!animPlaying || !anim.enabled) return;
        let stopped = false;
        let t1 = 0;
        let t2 = 0;
        const dur = Math.max(1, anim.duration);
        const hold = dur + dur * 0.6;
        const run = () => {
            if (stopped) return;
            setPhase('from');
            t1 = window.setTimeout(() => {
                if (stopped) return;
                setPhase('to');
                t2 = window.setTimeout(run, hold);
            }, hold);
        };
        run();
        return () => {
            stopped = true;
            window.clearTimeout(t1);
            window.clearTimeout(t2);
        };
    }, [animPlaying, anim.enabled, anim.duration]);

    // при anim.enabled маска блока берётся из anim: from статично, from/to в проигрывании
    const blockStyle = useMemo<CSSProperties>(() => {
        if (!anim.enabled || (staticAfterStop && !animPlaying)) return preview.block;
        const g = animPlaying && phase === 'to' ? anim.to : anim.from;
        const value = gradientToCss(g);
        const dur = fmtNum(anim.duration);
        return {
            ...preview.block,
            WebkitMaskImage: value,
            maskImage: value,
            ...(animPlaying
                ? {
                      transition: `mask ${dur}ms linear, -webkit-mask ${dur}ms linear`,
                  }
                : {}),
        };
    }, [preview.block, anim, animPlaying, phase, staticAfterStop]);

    return (
        <div style={blockStyle} onPointerDown={onPointerDown}>
            {clip.enabled ? (
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundImage: gradientToCss(clip.gradient),
                        WebkitBackgroundClip: 'text',
                        backgroundClip: 'text',
                        color: 'transparent',
                        fontSize: clipTextFontSize(state),
                        lineHeight: 1,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                    }}
                >
                    {clip.text}
                </div>
            ) : (
                <>
                    {preview.baseImage && (
                        <img
                            src={preview.baseImage.src}
                            alt=""
                            draggable={false}
                            style={{
                                position: 'absolute',
                                inset: 0,
                                width: '100%',
                                height: '100%',
                                objectFit: preview.baseImage.fit,
                                objectPosition: `${preview.baseImage.posX}% ${preview.baseImage.posY}%`,
                            }}
                        />
                    )}
                    {/* вуаль базового градиента поверх картинки (экспорт — multiple backgrounds) */}
                    {preview.baseVeil && <div style={preview.baseVeil} />}
                </>
            )}
            {state.layers.map(
                (layer, i) => layer.visible && <div key={layer.id} style={preview.layers[i]} />
            )}
            {preview.underlay && <div style={preview.underlay} />}
            {preview.blur && <div style={preview.blur} />}
        </div>
    );
}
