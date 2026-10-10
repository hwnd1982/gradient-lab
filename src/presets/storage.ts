import { z } from 'zod';
import { BlockStateSchema, uid } from '../schema';
import type { BlockState } from '../types';

const STORAGE_KEY = 'gradient-lab.presets';

/** Строки длиннее не храним в localStorage — раздувает квоту; пресет применяется «без картинки». */
const MAX_DATAURL_LENGTH = 300_000;

export interface UserPreset {
    id: string;
    name: string;
    createdAt: number;
    state: BlockState;
}

const UserPresetSchema = z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.number(),
    state: BlockStateSchema,
});

/** Копия стейта без гигантских dataURL (compare.refImage / base.image / stage.image). */
function sanitizeState(state: BlockState): BlockState {
    const clone = structuredClone(state);
    if (
        typeof clone.compare.refImage === 'string' &&
        clone.compare.refImage.length > MAX_DATAURL_LENGTH
    ) {
        clone.compare.refImage = null;
    }
    if (typeof clone.base.image === 'string' && clone.base.image.length > MAX_DATAURL_LENGTH) {
        clone.base.image = null;
    }
    if (typeof clone.stage.image === 'string' && clone.stage.image.length > MAX_DATAURL_LENGTH) {
        clone.stage.image = null;
    }
    return clone;
}

/** Все пользовательские пресеты из localStorage (битые записи отбрасываются). */
export function loadUserPresets(): UserPreset[] {
    let raw: string | null = null;
    try {
        raw = localStorage.getItem(STORAGE_KEY);
    } catch {
        return [];
    }
    if (raw === null) return [];
    let list: unknown;
    try {
        list = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) => {
        const parsed = UserPresetSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
    });
}

/** Сохраняет текущий стейт как пресет, возвращает обновлённый список. */
export function saveUserPreset(name: string, state: BlockState): UserPreset[] {
    const presets = loadUserPresets();
    presets.push({ id: uid(), name, createdAt: Date.now(), state: sanitizeState(state) });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    return presets;
}

/** Удаляет пресет по id, возвращает обновлённый список. */
export function deleteUserPreset(id: string): UserPreset[] {
    const presets = loadUserPresets().filter((p) => p.id !== id);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    } catch {
        // localStorage недоступен (квота/приватный режим) — вернём список как есть
    }
    return presets;
}

/** Скачивает стейт как <name>.gradient.json. */
export function exportPreset(state: BlockState, name: string): void {
    const safeName = name.replace(/[^\p{L}\p{N}_-]/gu, '-').replace(/^-+|-+$/g, '') || 'preset';
    const blob = new Blob([JSON.stringify(state, null, 4)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.gradient.json`;
    a.click();
    URL.revokeObjectURL(url);
}

/** Читает .gradient.json и валидирует его как BlockState; при ошибке — внятный throw. */
export async function importPresetFile(file: File): Promise<BlockState> {
    let data: unknown;
    try {
        data = JSON.parse(await file.text());
    } catch {
        throw new Error('Файл не является корректным JSON');
    }
    const parsed = BlockStateSchema.safeParse(data);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
            `Файл не похож на пресет Gradient Lab (${issue?.path.join('.') || '?'}: ${issue?.message || 'невалидное значение'})`
        );
    }
    return parsed.data;
}
