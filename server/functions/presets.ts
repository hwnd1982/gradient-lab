import { BlockStateSchema } from '../../src/schema.ts';
import { K, configured, kvReadJson, notConfigured } from '../kv.ts';
import { json, route } from '../rest.ts';

type PresetEntry = { name: string; state: unknown } | { name: string; error: string };

/**
 * GET /api/presets — список пресетов прода (Upstash, ключи lab:preset:<name>;
 * индекс имён — lab:presets). Это НЕ локальная папка presets/ — у инстанса
 * своё множество. Битые записи возвращаются с полем error вместо state.
 */
export async function GET(): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const index = (await kvReadJson<string[]>(K.presetIndex)) ?? [];
        const files = await Promise.all(
            index.map(async (name): Promise<PresetEntry> => {
                const raw = await kvReadJson<unknown>(K.preset(name));
                if (raw === null) {
                    return { name, error: 'не удалось прочитать: пресет удалён мимо индекса' };
                }
                const parsed = BlockStateSchema.safeParse(raw);
                return parsed.success
                    ? { name, state: parsed.data }
                    : { name, error: 'пресет не проходит валидацию BlockState' };
            })
        );
        return json(200, { files });
    });
}
