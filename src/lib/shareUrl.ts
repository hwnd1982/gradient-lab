import { BlockStateSchema } from '../schema';
import type { BlockState } from '../types';

/** Стейт -> JSON -> UTF-8 -> base64url без паддинга (для location.hash). */
export function encodeState(state: BlockState): string {
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url из hash -> BlockState; null, если данные не проходят zod-схему. */
export function decodeState(hash: string): BlockState | null {
    try {
        const b64 = hash.replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
        const json = new TextDecoder().decode(bytes);
        const parsed = BlockStateSchema.safeParse(JSON.parse(json));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}
