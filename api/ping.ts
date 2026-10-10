/** Пробная функция-бисект: без импортов. Если /api/ping отвечает 'pong' —
 *  рантайм ок, а падают импорты реальных функций (zod/src-цепочка). */
export default async function handler(): Promise<Response> {
    return new Response('pong');
}
