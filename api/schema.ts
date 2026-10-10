import { z } from 'zod';
import { BlockStateSchema } from '../src/schema';
import { configured, notConfigured } from '../server/kv';
import { json, route } from '../server/rest';

/** GET /api/schema — JSON Schema (draft 2020-12) типа BlockState, как в dev. */
export async function GET(): Promise<Response> {
    return route(async () => {
        if (!configured()) return notConfigured();
        return json(200, {
            $schema: 'http://json-schema.org/draft-2020-12/schema#',
            title: 'BlockState',
            ...z.toJSONSchema(BlockStateSchema),
        });
    });
}

export default async function handler(): Promise<Response> {
    return GET();
}
