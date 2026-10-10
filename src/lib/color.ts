export interface Rgb {
    r: number;
    g: number;
    b: number;
}

/** '#rrggbb' -> { r, g, b } */
export function hexToRgb(hex: string): Rgb {
    const h = hex.replace('#', '');
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    };
}

export function rgbToHex(r: number, g: number, b: number): string {
    const part = (v: number) =>
        Math.max(0, Math.min(255, Math.round(v)))
            .toString(16)
            .padStart(2, '0');
    return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * Округляет до `digits` знаков, отрезает хвостовые нули, нормализует -0.
 * fmtNum(116.90712) -> '116.91', fmtNum(-13.9) -> '-13.9', fmtNum(90) -> '90'
 */
export function fmtNum(n: number, digits = 2): string {
    const factor = 10 ** digits;
    const v = Math.round(n * factor) / factor;
    if (Object.is(v, -0)) return '0';
    let s = v.toFixed(digits);
    if (s.includes('.')) {
        s = s.replace(/0+$/, '').replace(/\.$/, '');
    }
    return s;
}

/** '#101010' + 0.5 -> 'rgba(16, 16, 16, 0.5)' */
export function rgbaString(hex: string, alpha: number): string {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${fmtNum(Math.max(0, Math.min(1, alpha)))})`;
}

/** 'rgba(16, 16, 16, 0.5)' -> { hex: '#101010', alpha: 0.5 }; null — если строка не парсится. */
export function parseRgba(s: string): { hex: string; alpha: number } | null {
    const m = s
        .trim()
        .match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.%]+))?\s*\)$/);
    if (!m) return null;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    let a = 1;
    if (m[4] !== undefined) {
        const raw = m[4];
        a = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
    }
    if (![r, g, b, a].every(Number.isFinite)) return null;
    return { hex: rgbToHex(r, g, b), alpha: Math.max(0, Math.min(1, a)) };
}

export function isValidHex(value: string): boolean {
    return /^#[0-9a-fA-F]{6}$/.test(value);
}
