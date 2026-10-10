const images = new Map<string, Promise<HTMLImageElement>>();
const canvases = new Map<string, Promise<HTMLCanvasElement>>();

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
