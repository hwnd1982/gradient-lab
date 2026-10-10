import type { BlendMode, RadialSize } from './types';

export const BLEND_MODES: { value: BlendMode; label: string }[] = [
    { value: 'normal', label: 'normal' },
    { value: 'multiply', label: 'multiply' },
    { value: 'screen', label: 'screen' },
    { value: 'overlay', label: 'overlay' },
    { value: 'darken', label: 'darken' },
    { value: 'lighten', label: 'lighten' },
    { value: 'color-dodge', label: 'color-dodge' },
    { value: 'color-burn', label: 'color-burn' },
    { value: 'hard-light', label: 'hard-light' },
    { value: 'soft-light', label: 'soft-light' },
    { value: 'difference', label: 'difference' },
    { value: 'exclusion', label: 'exclusion' },
    { value: 'hue', label: 'hue' },
    { value: 'saturation', label: 'saturation' },
    { value: 'color', label: 'color' },
    { value: 'luminosity', label: 'luminosity' },
];

export const RADIAL_SIZES: { value: RadialSize; label: string }[] = [
    { value: 'closest-side', label: 'Ближайшая сторона' },
    { value: 'closest-corner', label: 'Ближайший угол' },
    { value: 'farthest-side', label: 'Дальняя сторона' },
    { value: 'farthest-corner', label: 'Дальний угол' },
    { value: 'explicit', label: 'Явные размеры' },
];

export const BASE_FITS: { value: 'cover' | 'contain' | 'fill'; label: string }[] = [
    { value: 'cover', label: 'cover' },
    { value: 'contain', label: 'contain' },
    { value: 'fill', label: 'fill' },
];
