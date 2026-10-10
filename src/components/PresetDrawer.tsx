import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { clipTextFontSize, gradientToCss, stateToPreview } from '../cssgen';
import { defaultBlockState } from '../schema';
import { applyPresetFields, mergePresetInto } from '../presets/apply';
import { BUILTIN_PRESETS } from '../presets/builtin';
import {
    deleteUserPreset,
    exportPreset,
    importPresetFile,
    loadUserPresets,
    saveUserPreset,
} from '../presets/storage';
import type { UserPreset } from '../presets/storage';
import { useLabStore } from '../store';
import type { BlockState } from '../types';
import { TrashIcon } from './icons';

interface PresetDrawerProps {
    onClose: () => void;
}

type DrawerTab = 'builtin' | 'mine' | 'files';

/** Элемент GET /api/presets: валидный стейт или причина ошибки. */
interface FilePreset {
    name: string;
    state?: BlockState;
    error?: string;
}

/** Мини-превью пресета: яркая «псевдо-фото» подложка + блок с полем,
 *  иначе тёмные пресеты (fade в #101010) выглядят чёрным прямоугольником. */
const PREVIEW_PHOTO_BG =
    'linear-gradient(135deg, #4f7cff 0%, #7cd0ff 30%, #ffd27c 62%, #ff7c7c 100%)';

function PresetPreview({ apply }: { apply: Partial<BlockState> }) {
    const state = useMemo(() => {
        const merged = applyPresetFields(defaultBlockState(), apply);
        // блок не во всю миниатюру: видно края и эффекты на подложке
        merged.w = 80;
        merged.h = 52;
        merged.x = 8;
        merged.y = 6;
        merged.radius = Math.min(merged.radius, 6);
        // анимацию маски в превью показываем статичной маской «из»
        if (merged.anim.enabled) {
            merged.mask = { enabled: true, gradient: merged.anim.from };
        }
        return merged;
    }, [apply]);
    const preview = useMemo(() => stateToPreview(state), [state]);

    return (
        <div
            className="relative h-16 w-24 shrink-0 overflow-hidden rounded-md border border-lab-border"
            style={{ background: PREVIEW_PHOTO_BG }}
        >
            <div style={preview.block}>
                {state.clipText.enabled && (
                    <div
                        style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundImage: gradientToCss(state.clipText.gradient),
                            WebkitBackgroundClip: 'text',
                            backgroundClip: 'text',
                            color: 'transparent',
                            fontSize: clipTextFontSize(state),
                            lineHeight: 1,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                        }}
                    >
                        {state.clipText.text}
                    </div>
                )}
                {!state.clipText.enabled && preview.baseImage && (
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
                {state.layers.map(
                    (l, i) => l.visible && <div key={l.id} style={preview.layers[i]} />
                )}
                {preview.blur && <div style={preview.blur} />}
            </div>
        </div>
    );
}

/** Фикс. панель слева поверх стейджа: приёмы onsport | мои | файлы. */
export function PresetDrawer({ onClose }: PresetDrawerProps) {
    const [tab, setTab] = useState<DrawerTab>('builtin');
    const update = useLabStore((s) => s.update);
    const setActiveTarget = useLabStore((s) => s.setActiveTarget);
    const devApiAvailable = useLabStore((s) => s.devApiAvailable);
    const [userPresets, setUserPresets] = useState<UserPreset[]>(() => loadUserPresets());
    const [filePresets, setFilePresets] = useState<FilePreset[]>([]);
    const [name, setName] = useState('');
    const [fileName, setFileName] = useState('');
    const [error, setError] = useState('');
    const importRef = useRef<HTMLInputElement>(null);

    const refreshFiles = () => {
        fetch('/api/presets')
            .then((r) => {
                if (!r.ok) throw new Error('bad status');
                return r.json() as Promise<{ files?: FilePreset[] }>;
            })
            .then((d) => {
                // новая загрузка прошла — прошлая ошибка неактуальна
                // (сброс здесь, а не на старте: refreshFiles зовётся из эффекта)
                setError('');
                setFilePresets(d.files ?? []);
            })
            .catch(() => setFilePresets([]));
    };

    useEffect(() => {
        if (devApiAvailable) refreshFiles();
    }, [devApiAvailable]);

    // применение пресета — merge visual-полей, undoable; вид — всегда в Fit
    const applyPreset = (apply: Partial<BlockState>) => {
        update((d) => {
            mergePresetInto(d, apply);
        });
        if (apply.layers !== undefined) {
            setActiveTarget({ kind: 'layer', index: 0 });
        }
        useLabStore.getState().zoomFit();
    };

    const onSaveCurrent = () => {
        const trimmed = name.trim();
        if (trimmed === '') return;
        try {
            setUserPresets(saveUserPreset(trimmed, useLabStore.getState().state));
            setName('');
            setError('');
        } catch {
            setError('Не удалось сохранить: localStorage переполнен?');
        }
    };

    const onDeleteUser = (id: string) => {
        setUserPresets(deleteUserPreset(id));
    };

    const onDeleteFile = (presetName: string) => {
        fetch(`/api/presets/${encodeURIComponent(presetName)}`, { method: 'DELETE' })
            .then(() => refreshFiles())
            .catch(() => {
                // dev-сервер мог перезапуститься — просто обновим список
                refreshFiles();
            });
    };

    const onExportFile = () => {
        const trimmed = fileName.trim();
        if (trimmed === '') return;
        exportPreset(useLabStore.getState().state, trimmed);
        setFileName('');
    };

    const onImportFile = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setError('');
        importPresetFile(file)
            .then((state) => {
                setError('');
                applyPreset(state);
            })
            .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : String(err));
            });
    };

    const cardClass =
        'flex w-full cursor-pointer items-start gap-2.5 rounded-lg border border-lab-border bg-lab-panel2/50 p-2 text-left transition-colors hover:border-lab-accent';
    const inputClass =
        'min-w-0 flex-1 rounded-md border border-lab-border bg-lab-panel2 px-2 py-1.5 text-xs outline-none focus:border-lab-accent';
    const btnClass =
        'shrink-0 cursor-pointer rounded-md border border-lab-border bg-lab-panel2 px-2 py-1.5 text-xs hover:border-lab-accent disabled:cursor-default disabled:opacity-40';

    return (
        <aside className="absolute top-0 left-0 z-40 flex h-full w-[300px] flex-col border-r border-lab-border bg-lab-panel">
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-lab-border px-3">
                <span className="text-xs font-medium tracking-wide text-lab-muted uppercase">
                    Пресеты
                </span>
                <button
                    type="button"
                    title="Закрыть"
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-xs text-lab-muted hover:text-lab-text"
                    onClick={onClose}
                >
                    ×
                </button>
            </div>
            <div className="flex shrink-0 gap-1 border-b border-lab-border p-2">
                {(
                    [
                        ['builtin', 'Приёмы onsport'],
                        ['mine', 'Мои'],
                        ['files', 'Файлы'],
                    ] as [DrawerTab, string][]
                ).map(([value, label]) => (
                    <button
                        key={value}
                        type="button"
                        className={`cursor-pointer rounded-md px-2.5 py-1.5 text-xs whitespace-nowrap transition-colors ${
                            tab === value
                                ? 'bg-lab-accent text-white'
                                : 'text-lab-muted hover:bg-lab-panel2 hover:text-lab-text'
                        }`}
                        onClick={() => {
                            setTab(value);
                            setError('');
                        }}
                    >
                        {label}
                    </button>
                ))}
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
                {error !== '' && (
                    <p className="rounded-md border border-red-400/40 bg-red-400/10 px-2 py-1.5 text-[10px] leading-snug text-red-300">
                        {error}
                    </p>
                )}

                {tab === 'builtin' &&
                    BUILTIN_PRESETS.map((preset) => (
                        <div
                            key={preset.id}
                            className={cardClass}
                            onClick={() => applyPreset(preset.apply)}
                        >
                            <PresetPreview apply={preset.apply} />
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="truncate text-xs text-lab-text">
                                    {preset.name}
                                </span>
                                <span className="font-mono text-[9px] leading-snug break-words text-lab-muted">
                                    {preset.desc}
                                </span>
                            </span>
                        </div>
                    ))}

                {tab === 'mine' && (
                    <>
                        <div className="flex gap-1.5">
                            <input
                                className={inputClass}
                                placeholder="Имя пресета"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                            <button
                                type="button"
                                className={btnClass}
                                disabled={name.trim() === ''}
                                onClick={onSaveCurrent}
                            >
                                Сохранить текущий
                            </button>
                        </div>
                        {userPresets.length === 0 && (
                            <p className="px-1 text-[10px] leading-snug text-lab-muted">
                                Пока пусто — назовите пресет и сохраните текущий стейт.
                            </p>
                        )}
                        {userPresets.map((preset) => (
                            <div
                                key={preset.id}
                                className={cardClass}
                                onClick={() => applyPreset(preset.state)}
                            >
                                <PresetPreview apply={preset.state} />
                                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <span className="truncate text-xs text-lab-text">
                                        {preset.name}
                                    </span>
                                    <span className="text-[9px] text-lab-muted">
                                        {new Date(preset.createdAt).toLocaleDateString('ru-RU')}
                                    </span>
                                </span>
                                <button
                                    type="button"
                                    title="Удалить пресет"
                                    className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-lab-muted hover:text-lab-text"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDeleteUser(preset.id);
                                    }}
                                >
                                    <TrashIcon />
                                </button>
                            </div>
                        ))}

                        {devApiAvailable && (
                            <div className="mt-1 flex flex-col gap-2 border-t border-lab-border pt-2.5">
                                <span className="px-1 text-[10px] tracking-wide text-lab-muted uppercase">
                                    Файловые (presets/)
                                </span>
                                {filePresets.length === 0 && (
                                    <p className="px-1 text-[10px] leading-snug text-lab-muted">
                                        Пусто: положите *.json в presets/ или сделайте PUT
                                        /api/presets/&lt;name&gt;.
                                    </p>
                                )}
                                {filePresets.map((preset) => {
                                    const st = preset.state;
                                    return st ? (
                                        <div
                                            key={preset.name}
                                            className={cardClass}
                                            onClick={() => applyPreset(st)}
                                        >
                                            <PresetPreview apply={st} />
                                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                                <span className="truncate text-xs text-lab-text">
                                                    {preset.name}
                                                </span>
                                            </span>
                                            <button
                                                type="button"
                                                title="Удалить файл"
                                                className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-lab-muted hover:text-lab-text"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onDeleteFile(preset.name);
                                                }}
                                            >
                                                <TrashIcon />
                                            </button>
                                        </div>
                                    ) : (
                                        <div
                                            key={preset.name}
                                            className="flex flex-col gap-0.5 rounded-lg border border-dashed border-lab-border px-2 py-1.5"
                                        >
                                            <span className="truncate text-xs text-lab-muted">
                                                {preset.name}
                                            </span>
                                            <span className="text-[9px] text-red-300">
                                                {preset.error}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}

                {tab === 'files' && (
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1.5">
                            <span className="text-[11px] leading-none text-lab-muted">
                                Сохранить текущий как файл
                            </span>
                            <div className="flex gap-1.5">
                                <input
                                    className={inputClass}
                                    placeholder="Имя файла"
                                    value={fileName}
                                    onChange={(e) => setFileName(e.target.value)}
                                />
                                <button
                                    type="button"
                                    className={btnClass}
                                    disabled={fileName.trim() === ''}
                                    onClick={onExportFile}
                                >
                                    Скачать
                                </button>
                            </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <span className="text-[11px] leading-none text-lab-muted">
                                Импорт из файла
                            </span>
                            <input
                                ref={importRef}
                                type="file"
                                accept=".json,application/json"
                                className="hidden"
                                onChange={onImportFile}
                            />
                            <button
                                type="button"
                                className="cursor-pointer rounded-md border border-dashed border-lab-border px-2 py-1.5 text-xs text-lab-muted hover:border-lab-accent hover:text-lab-text"
                                onClick={() => importRef.current?.click()}
                            >
                                Выбрать .gradient.json
                            </button>
                        </div>
                        <p className="text-[10px] leading-relaxed text-lab-muted">
                            Файл пресета — это JSON полного состояния блока (BlockState). Файлы из
                            папки presets/ проекта доступны в табе «Мои» при запущенном dev-сервере.
                        </p>
                    </div>
                )}
            </div>
        </aside>
    );
}
