//#region server/functions/ping.ts
/** Пинг рантайма: без импортов (родился пробной функцией бисекта). Рантайм
*  Vercel ждёт именованный HTTP-метод или fetch-экспорт (default с Response
*  игнорируется — см. WARN). */
function GET() {
	return new Response("pong");
}
//#endregion
export { GET };
