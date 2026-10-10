/** Пробная функция-бисект: без импортов. Рантайм Vercel ждёт именованный
 *  HTTP-метод или fetch-экспорт (default с Response игнорируется — см. WARN). */
export function GET(): Response {
    return new Response('pong');
}
