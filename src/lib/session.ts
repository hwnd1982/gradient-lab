/**
 * Сессия прод-инстанса (X-Lab-Session, см. API.md «Сессии»): слот доски в
 * Upstash lab:s/<id> — «мой агент — моё окно». sessionStorage (не localStorage):
 * два окна = две сессии. dev всегда 'default' (однопользовательский, селектор
 * в хедере скрыт, транспорт заголовок не шлёт).
 *
 * ?join=<id> — join-ссылка от агента: обрабатывается при импорте модуля
 * (транспорт импортирует его раньше первого синка), значение уходит в
 * sessionStorage ДО любого запроса, из URL вычищается replaceState; hash-стейт
 * #s= из той же ссылки приложение применяет уже В эту сессию.
 */
const STORAGE_KEY = 'lab.session';

/** Допустимый id сессии: [a-zA-Z0-9_-], 1..64 — тот же формат, что на сервере. */
export const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Текущая сессия (читается на каждом вызове транспорта — селектор меняет на лету). */
export function currentSession(): string {
    try {
        const v = sessionStorage.getItem(STORAGE_KEY);
        if (v !== null && SESSION_ID_RE.test(v)) return v;
    } catch {
        // sessionStorage недоступен (privacy-режим) — живём в default
    }
    return 'default';
}

/** Сменить сессию (селектор хедера): перезапуск синк/поллинга делает App. */
export function setSession(id: string): void {
    try {
        sessionStorage.setItem(STORAGE_KEY, id);
    } catch (err) {
        // недоступен — UI селектора уже переключился, а трафик останется в
        // default: молчать нельзя, предупреждаем (приватный режим/квота)
        console.warn(
            'gradient-lab: не удалось записать сессию в sessionStorage — останемся в текущей:',
            err
        );
    }
}

// join-ссылка: применяем до любого запроса (модуль импортируется транспортом)
try {
    const url = new URL(window.location.href);
    const join = url.searchParams.get('join');
    if (join !== null) {
        if (SESSION_ID_RE.test(join)) sessionStorage.setItem(STORAGE_KEY, join);
        url.searchParams.delete('join');
        // hash (#s=...) сохраняем — стейт из ссылки применяется в эту сессию
        history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
} catch {
    // URL/sessionStorage недоступны — остаёмся в текущей сессии
}
