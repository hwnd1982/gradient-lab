import { useState } from 'react';
import { useLabStore } from '../store';
import { GradientEditor } from './GradientEditor';
import { PlayIcon, StopIcon } from './icons';
import { NumberField } from './ui/NumberField';
import { SegmentedControl } from './ui/SegmentedControl';
import { Toggle } from './ui/Toggle';

type AnimTargetKind = 'animFrom' | 'animTo';

/** Секция «Анимация маски»: toggle, длительность, редакторы Из/В, Play/Stop. */
export function AnimSection() {
    const anim = useLabStore((s) => s.state.anim);
    const update = useLabStore((s) => s.update);
    const setActiveTarget = useLabStore((s) => s.setActiveTarget);
    const playing = useLabStore((s) => s.animPlaying);
    const setPlaying = useLabStore((s) => s.setAnimPlaying);
    const [edit, setEdit] = useState<AnimTargetKind>('animFrom');

    const onToggle = (v: boolean) => {
        update((d) => {
            d.anim.enabled = v;
        });
        if (v) {
            setEdit('animFrom');
            setActiveTarget({ kind: 'animFrom' });
        } else {
            setPlaying(false);
        }
    };

    const pick = (kind: AnimTargetKind) => {
        setEdit(kind);
        // канвас-хэндлы следуют за выбранным таргетом
        setActiveTarget({ kind });
    };

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <Toggle label="Анимировать маску" checked={anim.enabled} onChange={onToggle} />
            {anim.enabled && (
                <>
                    <div className="flex items-end gap-2">
                        <div className="w-[120px]">
                            <NumberField
                                label="Длительность, ms"
                                value={anim.duration}
                                min={50}
                                step={50}
                                onChange={(v) =>
                                    update((d) => {
                                        d.anim.duration = v;
                                    })
                                }
                            />
                        </div>
                        <button
                            type="button"
                            title={
                                playing
                                    ? 'Остановить проигрывание'
                                    : 'Проигрывать цикл: из → (пауза) → в'
                            }
                            className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                                playing
                                    ? 'border-transparent bg-lab-accent text-white'
                                    : 'border-lab-border bg-lab-panel2 hover:border-lab-accent'
                            }`}
                            onClick={() => setPlaying(!playing)}
                        >
                            {playing ? <StopIcon /> : <PlayIcon />}
                            {playing ? 'Стоп' : 'Играть'}
                        </button>
                    </div>
                    <SegmentedControl
                        value={edit}
                        options={[
                            { value: 'animFrom' as const, label: 'Из' },
                            { value: 'animTo' as const, label: 'В' },
                        ]}
                        onChange={pick}
                    />
                    <GradientEditor target={{ kind: edit }} />
                    <p className="text-[10px] leading-relaxed text-lab-muted">
                        На экспорт уходят transition маски и классы .is-anim-from / .is-anim-to —
                        переключение класса запускает анимацию
                    </p>
                </>
            )}
        </div>
    );
}
