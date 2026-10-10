/**
 * Единая прод-функция (catch-all): Hobby-план Vercel ограничивает деплой
 * 12 serverless-функциями, поэтому ВСЕ /api/* роутятся здесь по пути и методу.
 * Логика живёт в соседних модулях — этот файл только диспетчер.
 * Именованные GET/POST/PUT/DELETE — конвенция рантайма Vercel (Web-стиль).
 */
import * as analysis from './analysis.ts';
import * as journal from './journal.ts';
import * as methodology from './methodology.ts';
import * as ping from './ping.ts';
import * as presets from './presets.ts';
import * as presetsName from './presets-name.ts';
import * as schema from './schema.ts';
import * as sessions from './sessions.ts';
import * as sessionsId from './sessions-id.ts';
import * as stateFns from './state.ts';
import * as sweep from './sweep.ts';
import * as sweepId from './sweep-id.ts';
import * as sync from './sync.ts';
import * as warnings from './warnings.ts';
import { json } from '../rest.ts';

const MISMATCH = (method: string): Response =>
    json(405, { error: `метод ${method} не поддерживается` });

export async function fetch(req: Request): Promise<Response> {
    const segments = new URL(req.url, 'http://localhost').pathname.replace(/^\/+|\/+$/g, '').split('/');
    const resource = segments[1] ?? '';
    const hasParam = segments.length > 2;
    const m = req.method;

    switch (`${m} ${resource}`) {
        case 'GET ping':
            return ping.GET();
        case 'GET methodology':
            return methodology.GET();
        case 'GET schema':
            return schema.GET();
        case 'GET state':
            return stateFns.GET(req);
        case 'PUT state':
            return stateFns.PUT(req);
        case 'POST sync':
            return sync.POST(req);
        case 'GET warnings':
            return warnings.GET(req);
        case 'POST warnings':
            return warnings.POST(req);
        case 'GET analysis':
            return analysis.GET(req);
        case 'POST analysis':
            return analysis.POST(req);
        case 'GET journal':
            return journal.GET(req);
        case 'POST journal':
            return journal.POST(req);
        case 'DELETE journal':
            return journal.DELETE(req);
        case 'GET presets':
            return hasParam ? presetsName.GET(req) : presets.GET();
        case 'PUT presets':
            return presetsName.PUT(req);
        case 'DELETE presets':
            return presetsName.DELETE(req);
        case 'GET sweep':
            return hasParam ? sweepId.GET(req) : sweep.GET(req);
        case 'POST sweep':
            return sweep.POST(req);
        case 'GET sessions':
            return sessions.GET();
        case 'PUT sessions':
            return sessionsId.PUT(req);
        case 'DELETE sessions':
            return sessionsId.DELETE(req);
        default:
            return MISMATCH(m);
    }
}
