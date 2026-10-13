const images = new Map<string, Promise<HTMLImageElement>>();
const canvases = new Map<string, Promise<HTMLCanvasElement>>();

/**
 * Резолв ассет-ссылок стейта (hash 'sha256-<hex>' → dataURL через
 * GET /api/asset/<hash>): кэш по hash с дедупликацией in-flight запросов —
 * один и тот же кадр не запрашивается дважды. 404 кэшируется как null
 * (ассета нет — поле остаётся пустым, рендер живёт как без картинки); прочие
 * HTTP-сбои (429/5xx) и сетевые ошибки НЕ кэшируются — следующий тик повторит.
 */
const assetDataUrls = new Map<string, Promise<string | null>>();

export function fetchAssetImage(hash: string): Promise<string | null> {
    let entry = assetDataUrls.get(hash);
    if (entry === undefined) {
        entry = fetch(`/api/asset/${hash}`)
            .then(async (r): Promise<string | null> => {
                if (r.status === 404) return null;
                if (!r.ok) {
                    // 429/5xx (штатные квотные ответы Upstash) — не кэшируем:
                    // следующий тик повторит запрос
                    assetDataUrls.delete(hash);
                    return null;
                }
                const j: unknown = await r.json();
                const d = (j as { dataURL?: unknown }).dataURL;
                return typeof d === 'string' && d.startsWith('data:') ? d : null;
            })
            .catch(() => {
                assetDataUrls.delete(hash);
                return null;
            });
        assetDataUrls.set(hash, entry);
    }
    return entry;
}

/** Загруженная картинка по dataURL/URL, с кэшем по строке-источнику. */
export function getImage(src: string): Promise<HTMLImageElement> {
    let entry = images.get(src);
    if (!entry) {
        entry = new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Не удалось загрузить изображение'));
            img.src = src;
        });
        images.set(src, entry);
    }
    return entry;
}

/**
 * Картинка, отрисованная один раз в offscreen canvas натурального размера
 * (willReadFrequently — под getImageData пипетки и автоподбора).
 */
export function getCanvas(src: string): Promise<HTMLCanvasElement> {
    let entry = canvases.get(src);
    if (!entry) {
        entry = getImage(src).then((img) => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new Error('2d-контекст недоступен');
            if (canvas.width > 0 && canvas.height > 0) {
                ctx.drawImage(img, 0, 0);
            }
            return canvas;
        });
        canvases.set(src, entry);
    }
    return entry;
}
