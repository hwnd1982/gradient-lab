import { create } from 'zustand';
import { defaultBlockState } from './schema';
import { readGradient } from './targets';
import type { Analysis, BlockState, Gradient, GradientTarget, Warning } from './types';

const MAX_HISTORY = 50;

/** Границы канвасного зума стейджа, %. */
export const MIN_VIEW_ZOOM = 10;
export const MAX_VIEW_ZOOM = 800;

/** Минимальная видимая часть блока при пане, px вьюпорта. */
const MIN_VISIBLE_PX = 48;

/**
 * Кламп пана: хотя бы MIN_VISIBLE_PX блока остаётся во вьюпорте — контент
 * нельзя увести совсем за экран (и паном, и зумом-от-курсора).
 */
function clampViewPan(
    pan: { x: number; y: number },
    k: number,
    b: { x: number; y: number; w: number; h: number },
    vs: { w: number; h: number } | null
): { x: number; y: number } {
    if (vs === null) return pan;
    const axis = (p: number, pos: number, size: number, view: number): number => {
        const lo = MIN_VISIBLE_PX - (pos + size) * k;
        const hi = view - MIN_VISIBLE_PX - pos * k;
        if (lo > hi) return (lo + hi) / 2; // вьюпорт меньше минимальной видимой зоны
        return Math.min(hi, Math.max(lo, p));
    };
    return {
        x: axis(pan.x, b.x, b.w, vs.w),
        y: axis(pan.y, b.y, b.h, vs.h),
    };
}

/** Fit-зум, %: блок + отступ 24px вписан во вьюпорт; выше 100% не зумим. */
function fitZoomPercent(vs: { w: number; h: number }, b: { w: number; h: number }): number {
    return Math.min(
        100,
        Math.max(MIN_VIEW_ZOOM, Math.min(((vs.w - 48) / b.w) * 100, ((vs.h - 48) / b.h) * 100))
    );
}

/** Fit-значения вида: зум + отцентрованный (с клампом) пан. */
function fitValues(
    vs: { w: number; h: number },
    b: { x: number; y: number; w: number; h: number }
): { viewZoom: number; viewPan: { x: number; y: number } } {
    const z = fitZoomPercent(vs, b);
    const k = z / 100;
    return {
        viewZoom: z,
        viewPan: clampViewPan(
            { x: vs.w / 2 - (b.x + b.w / 2) * k, y: vs.h / 2 - (b.y + b.h / 2) * k },
            k,
            b,
            vs
        ),
    };
}

/** Ключ последнего применённого fit-а: пересчёт только при смене w/h/вьюпорта. */
let fitKey = '';

/** Один и тот же таргет (kind + index слоя)? */
function sameTarget(a: GradientTarget, b: GradientTarget): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'layer' && b.kind === 'layer') return a.index === b.index;
    return true;
}

/** UI-режимы сравнения (не часть BlockState — не сериализуются и не undo-ятся). */
export interface CompareUI {
    /** глаз: постоянная видимость overlay (клавиша `\` — временное скрытие) */
    visible: boolean;
    /** режим-модификатор: drag по overlay двигает offset референса */
    dragRef: boolean;
    /** режим пипетки по референсу */
    eyedropper: boolean;
    /** результат последнего клика пипетки (попап на стейдже), null — закрыт */
    pick: PickedColor | null;
}

/** Цвет, снятый пипеткой с референса. */
export interface PickedColor {
    /** канвасные координаты попапа (живёт внутри зумящегося wrapper-а) */
    popupLeft: number;
    y: number;
    r: number;
    g: number;
    b: number;
    /** 0..255 */
    a: number;
}

interface LabStore {
    state: BlockState;
    /** какой градиент сейчас редактируется (канвас-хэндлы + инспектор) */
    activeTarget: GradientTarget;
    selectedStopId: string | null;
    compareUI: CompareUI;
    /** идёт ли проигрывание анимации маски (UI-флаг, не сериализуется) */
    animPlaying: boolean;
    /** доступен ли dev Agent API (только в dev, после успешного probe) */
    devApiAvailable: boolean;
    /** последний diff-анализ против референса (не сериализуется; null — референса нет) */
    analysis: Analysis | null;
    /** heat-карта последнего анализа для оверлея режима «Анализ» */
    analysisDiff: HTMLCanvasElement | null;
    /** маркер «у таргета анализа нет градиента» (панель показывает сообщение) */
    analysisMarker: 'gradientMissing' | null;
    /** override таргета анализа от агента (SSE analysis-request); null — активный UI-таргет */
    analysisTarget: GradientTarget | null;
    /** предупреждения борт-контроля (не сериализуются) */
    warnings: Warning[];
    /** режим профиля анализа: axis — вдоль оси, columns — P60 колонок, rays — 16 лучей radial */
    analysisProfile: 'axis' | 'columns' | 'rays';
    /** эффективный канвасный зум стейджа, % (100 = натуральный размер); view-only */
    viewZoom: number;
    /** режим Fit: блок всегда вписан — пересчёт на ресайз окна и смену w/h блока */
    viewFit: boolean;
    /** канвасный пан стейджа, px в системе вьюпорта; view-only — не сериализуется */
    viewPan: { x: number; y: number };
    /** размер вьюпорта стейджа (ResizeObserver; null до монтирования) — для Fit/зума */
    viewSize: { w: number; h: number } | null;
    /** зажат Space: канвасные драги глохнут, drag по стейджу = пан (Figma-паттерн) */
    viewSpace: boolean;
    /** undo-стек, максимум 50 состояний */
    past: BlockState[];
    /** Основной путь правок: structuredClone -> mutator -> set. */
    update(mutator: (draft: BlockState) => void, opts?: { transient?: boolean }): void;
    /** Для пресетов/API: полная замена стейта. */
    replace(next: BlockState, opts?: { undoable?: boolean }): void;
    undo(): void;
    /** Один push в past в начале жеста (паре к transient-обновлениям). */
    pushHistory(): void;
    setActiveTarget(t: GradientTarget): void;
    setSelectedStop(id: string | null): void;
    setCompareUI(patch: Partial<CompareUI>): void;
    setAnalysis(a: Analysis | null, diff?: HTMLCanvasElement | null): void;
    setAnalysisMarker(m: 'gradientMissing' | null): void;
    setAnalysisTarget(t: GradientTarget | null): void;
    setWarnings(w: Warning[]): void;
    setAnalysisProfile(v: 'axis' | 'columns' | 'rays'): void;
    /**
     * Зум стейджа, %; anchor — точка ВЬЮПОРТА, остающаяся на месте (зум к
     * курсору/центру); без anchor пан сохраняется.
     */
    setViewZoom(z: number, anchor?: { x: number; y: number }): void;
    setViewPan(p: { x: number; y: number }): void;
    setViewSize(v: { w: number; h: number } | null): void;
    setViewSpace(v: boolean): void;
    /**
     * Вписать блок (+отступ 24px) во вьюпорт и отцентровать; выше 100% не
     * зумит. Включает режим Fit (авто-пересчёт) и сбрасывает пан.
     */
    zoomFit(): void;
    setAnimPlaying(v: boolean): void;
    setDevApiAvailable(v: boolean): void;
    getGradient(target: GradientTarget): Gradient | null;
}

export const useLabStore = create<LabStore>()((set, get) => {
    /**
     * Пересчёт fit-режима: только когда w/h блока или вьюпорт изменились —
     * перенос блока (x/y) вид не дёргает, ресайз/пресет/окно — переподгоняет.
     * Режим fit не переключает (числовой зум агентские PUT-ы не прыгают).
     */
    const syncFit = (): void => {
        const s = get();
        if (!s.viewFit || s.viewSize === null) return;
        const key = `${s.state.w}x${s.state.h}@${s.viewSize.w}x${s.viewSize.h}`;
        if (key === fitKey) return;
        fitKey = key;
        set(fitValues(s.viewSize, s.state));
    };

    return {
        state: defaultBlockState(),
        activeTarget: { kind: 'layer', index: 0 },
        selectedStopId: null,
        compareUI: { visible: true, dragRef: false, eyedropper: false, pick: null },
        animPlaying: false,
        devApiAvailable: false,
        analysis: null,
        analysisDiff: null,
        analysisMarker: null,
        analysisTarget: null,
        warnings: [],
        analysisProfile: 'axis',
        viewZoom: 100,
        viewFit: true, // старт и пресеты — всегда Fit
        viewPan: { x: 0, y: 0 },
        viewSize: null,
        viewSpace: false,
        past: [],

        update: (mutator, opts) => {
            const prev = get().state;
            const draft = structuredClone(prev);
            mutator(draft);
            // push в past ДО мутации; transient-жесты не пишут историю (её пишет pushHistory)
            const past = opts?.transient ? get().past : [...get().past, prev].slice(-MAX_HISTORY);
            set({ state: draft, past });
            syncFit();
        },

        replace: (next, opts) => {
            if (opts?.undoable === false) {
                set({ state: next });
                syncFit();
                return;
            }
            set({ state: next, past: [...get().past, get().state].slice(-MAX_HISTORY) });
            syncFit();
        },

        pushHistory: () => {
            set({ past: [...get().past, get().state].slice(-MAX_HISTORY) });
        },

        undo: () => {
            const { past } = get();
            if (past.length === 0) return;
            set({ state: past[past.length - 1], past: past.slice(0, -1) });
            syncFit();
        },

        // ручной выбор таргета в UI снимает агентский override анализа —
        // следующий GET /api/analysis?target= его вернёт; профиль сбрасываем
        // в ось: лучи/колонки — выбор под конкретный таргет, а не глобальный
        setActiveTarget: (t) =>
            set({ activeTarget: t, analysisTarget: null, analysisProfile: 'axis' }),
        setSelectedStop: (id) => set({ selectedStopId: id }),
        setAnalysis: (a, diff = null) =>
            set({
                analysis: a,
                analysisDiff: a === null ? null : diff,
                // живой анализ вытесняет маркер «нет градиента»
                analysisMarker: a === null ? get().analysisMarker : null,
            }),
        setAnalysisMarker: (m) => set({ analysisMarker: m }),
        // повторный SSE analysis-request того же таргета — no-op: не сбрасываем
        // debounce пересчёта анализа при поллинге агента; смена таргета
        // сбрасывает профиль в ось (лучи валидны только на radial-таргете)
        setAnalysisTarget: (t) => {
            if (t === null) {
                set({ analysisTarget: null });
                return;
            }
            const cur = get().analysisTarget;
            if (cur !== null && sameTarget(cur, t)) return;
            set({ analysisTarget: t, analysisProfile: 'axis' });
        },
        setWarnings: (w) => set({ warnings: w }),
        // зум-к-точке: контент-точка c = (anchor - pan)/z остаётся под anchor при
        // новом зуме z' => pan' = anchor - (anchor - pan)·(z'/z); итоговый пан
        // клампится, чтобы блок не уехал из вьюпорта совсем
        setViewZoom: (z, anchor) =>
            set((s) => {
                const clamped = Math.min(MAX_VIEW_ZOOM, Math.max(MIN_VIEW_ZOOM, z));
                const k = s.viewZoom === 0 ? 1 : clamped / s.viewZoom;
                const pan = anchor
                    ? {
                          x: anchor.x - (anchor.x - s.viewPan.x) * k,
                          y: anchor.y - (anchor.y - s.viewPan.y) * k,
                      }
                    : s.viewPan;
                return {
                    viewZoom: clamped,
                    viewFit: false, // числовой зум выключает авто-Fit
                    viewPan: clampViewPan(pan, clamped / 100, s.state, s.viewSize),
                };
            }),
        setViewPan: (p) =>
            set((s) => ({
                viewPan: clampViewPan(p, s.viewZoom / 100, s.state, s.viewSize),
            })),
        setViewSize: (v) => {
            set({ viewSize: v });
            syncFit();
        },
        setViewSpace: (v) => set({ viewSpace: v }),
        // Fit: блок (+отступ 24px) вписан во вьюпорт и отцентрован; выше натурального
        // размера не зумим — 100% здесь = физпиксели референса (2x-экспорт).
        // Включает режим Fit и сбрасывает пан (пресеты/шара/старт)
        zoomFit: () => {
            const s = get();
            set({ viewFit: true });
            if (s.viewSize === null) return;
            fitKey = `${s.state.w}x${s.state.h}@${s.viewSize.w}x${s.viewSize.h}`;
            set(fitValues(s.viewSize, s.state));
        },
        setAnalysisProfile: (v) => set({ analysisProfile: v }),
        setAnimPlaying: (v) => set({ animPlaying: v }),
        setDevApiAvailable: (v) => set({ devApiAvailable: v }),
        setCompareUI: (patch) =>
            set((s) => {
                const next = { ...s.compareUI, ...patch };
                // drag-референса и пипетка взаимоисключающие режимы захвата pointer-событий
                if (next.dragRef && next.eyedropper) {
                    if (patch.dragRef) next.eyedropper = false;
                    else next.dragRef = false;
                }
                // выключили пипетку — её попап больше не показываем
                if (!next.eyedropper) next.pick = null;
                return { compareUI: next };
            }),
        getGradient: (target) => readGradient(get().state, target),
    };
});
