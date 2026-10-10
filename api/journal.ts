import type { JournalEntry } from '../src/schema';
import { JournalPostSchema } from '../src/schema';
import { K, configured, kvDelete, kvReadJson, kvWriteJson, notConfigured } from '../server/kv';
import { json, readJsonBody, requireMutationAuth, route } from '../server/rest';

/** Вместимость журнала (как кольцевой буфер dev-сервера). */
const JOURNAL_LIMIT = 200;

/** GET /api/journal — журнал итераций (читать, чтобы откатиться к удачной). */
export async function GET(): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        const entries = await kvReadJson<JournalEntry[]>(K.journal);
        return json(200, { entries: entries ?? [] });
    });
}

/**
 * POST /api/journal (прод-аналог dev POST /api/__journal): start {ts, fields,
 * before?} → {ok, id}; finish {id, after} дозаполняет метрики. Массив живёт в
 * lab:journal целиком (read-modify-write, cap 200) — id = max+1, уникальны и
 * после DELETE.
 */
export async function POST(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const parsed = JournalPostSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
            return json(400, { error: 'invalid journal payload', issues: parsed.error.issues });
        }
        const data = parsed.data;
        const entries = (await kvReadJson<JournalEntry[]>(K.journal)) ?? [];

        if ('id' in data) {
            const entry = entries.find((e) => e.id === data.id);
            if (entry === undefined) {
                return json(404, { error: `запись журнала ${data.id} не найдена` });
            }
            entry.after = data.after;
            await kvWriteJson(K.journal, entries);
            return json(200, { ok: true, id: entry.id });
        }

        const id = entries.reduce((m, e) => Math.max(m, e.id), 0) + 1;
        const entry: JournalEntry = {
            id,
            ts: data.ts,
            fields: data.fields,
            before: data.before ?? null,
            after: null,
        };
        entries.push(entry);
        const capped =
            entries.length > JOURNAL_LIMIT
                ? entries.slice(entries.length - JOURNAL_LIMIT)
                : entries;
        await kvWriteJson(K.journal, capped);
        return json(200, { ok: true, id: entry.id });
    });
}

/** DELETE /api/journal — очистить журнал. */
export async function DELETE(req: Request): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        requireMutationAuth(req);
        const entries = (await kvReadJson<JournalEntry[]>(K.journal)) ?? [];
        await kvDelete(K.journal);
        return json(200, { ok: true, cleared: entries.length });
    });
}

export default async function handler(req: Request): Promise<Response> {
    if (req.method === 'GET') return GET();
    if (req.method === 'POST') return POST(req);
    if (req.method === 'DELETE') return DELETE(req);
    return json(405, { error: `метод ${req.method} не поддерживается` });
}
