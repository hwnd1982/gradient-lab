import { K, configured, kvDelete, kvReadJson, kvWriteJson, notConfigured } from '../kv.ts';
import { json, parseStateBody, readJsonBody, requireMutationAuth, route } from '../rest.ts';
import { sanitizeName } from '../../shared/targetKeys.ts';

/** Имя пресета: прод-роутер принимает /api/presets/:name через rewrite
 *  в query (?name=...); путь целиком не матчится (лимит [[...path]]). */
function presetNameFromUrl(req: Request): string {
    return new URL(req.url, 'http://localhost').searchParams.get('name') ?? '';
}

/** GET /api/presets/:name — один пресет (санитизация имени как в dev). */
export async function GET(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const name = sanitizeName(presetNameFromUrl(req));
        if (name === null) {
            return json(400, { error: 'имя содержит некорректную %-последовательность' });
        }
        if (name === '') {
            return json(400, { error: 'имя после санитизации пусто' });
        }
        const stored = await kvReadJson<unknown>(K.preset(name));
        if (stored === null) {
            return json(404, { error: `пресет ${name} не найден` });
        }
        return json(200, stored);
    });
}

/** PUT /api/presets/:name — сохранить (валидация BlockState + индекс имён). */
export async function PUT(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const name = sanitizeName(presetNameFromUrl(req));
        if (name === null) {
            return json(400, { error: 'имя содержит некорректную %-последовательность' });
        }
        if (name === '') {
            return json(400, { error: 'имя после санитизации пусто' });
        }
        const state = parseStateBody(await readJsonBody(req));
        await kvWriteJson(K.preset(name), state);
        const index = (await kvReadJson<string[]>(K.presetIndex)) ?? [];
        if (!index.includes(name)) {
            index.push(name);
            index.sort();
            await kvWriteJson(K.presetIndex, index);
        }
        return json(200, { ok: true, name });
    });
}

/** DELETE /api/presets/:name — удалить (пресет + строка индекса). */
export async function DELETE(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const name = sanitizeName(presetNameFromUrl(req));
        if (name === null) {
            return json(400, { error: 'имя содержит некорректную %-последовательность' });
        }
        if (name === '') {
            return json(400, { error: 'имя после санитизации пусто' });
        }
        const stored = await kvReadJson<unknown>(K.preset(name));
        if (stored === null) {
            return json(404, { error: `пресет ${name} не найден` });
        }
        await kvDelete(K.preset(name));
        const index = (await kvReadJson<string[]>(K.presetIndex)) ?? [];
        const next = index.filter((n) => n !== name);
        if (next.length !== index.length) {
            await kvWriteJson(K.presetIndex, next);
        }
        return json(200, { ok: true, name });
    });
}
