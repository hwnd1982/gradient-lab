interface IconProps {
    className?: string;
}

export function EyeIcon({ className }: IconProps) {
    return (
        <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8Z" />
            <circle cx="8" cy="8" r="2" />
        </svg>
    );
}

export function EyeOffIcon({ className }: IconProps) {
    return (
        <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M3 4.5C1.9 5.7 1.5 8 1.5 8s2.4 4.2 6.5 4.2c1.2 0 2.2-.3 3.1-.8M7 3.9c.3-.05.6-.1 1-.1 4.1 0 6.5 4.2 6.5 4.2s-.5 1-1.5 2" />
            <path d="M2 1.5l12 13" />
            <path d="M6.4 6.6a2 2 0 0 0 2.8 2.9" />
        </svg>
    );
}

export function TrashIcon({ className }: IconProps) {
    return (
        <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.6 9.5h6.8L12 4M6.5 7v4M9.5 7v4" />
        </svg>
    );
}

export function DuplicateIcon({ className }: IconProps) {
    return (
        <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 3.5v-1h-8v8h1" />
        </svg>
    );
}

export function PlusIcon({ className }: IconProps) {
    return (
        <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
        >
            <path d="M8 3v10M3 8h10" />
        </svg>
    );
}

export function UndoIcon({ className }: IconProps) {
    return (
        <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M3.5 6.5h6a3.5 3.5 0 1 1 0 7H6" />
            <path d="M6 3.5 3 6.5 6 9.5" />
        </svg>
    );
}

/** Развернуть стопы (reverse). */
export function ReverseIcon({ className }: IconProps) {
    return (
        <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M2 4.5h9.5M2 11.5h6" />
            <path d="M9.5 2 12 4.5 9.5 7M6 13.5 8.5 11.5 6 9.5" />
        </svg>
    );
}

/** Выровнять стопы равномерно. */
export function DistributeIcon({ className }: IconProps) {
    return (
        <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M2 3v10M14 3v10" />
            <path d="M8 5.5v5" />
            <path d="M6 8h4" />
        </svg>
    );
}

/** Проигрывание анимации маски. */
export function PlayIcon({ className }: IconProps) {
    return (
        <svg viewBox="0 0 16 16" width="14" height="14" className={className} fill="currentColor">
            <path d="M4.5 3v10l8.5-5z" />
        </svg>
    );
}

/** Остановка проигрывания анимации маски. */
export function StopIcon({ className }: IconProps) {
    return (
        <svg viewBox="0 0 16 16" width="14" height="14" className={className} fill="currentColor">
            <rect x="4" y="4" width="8" height="8" rx="1.2" />
        </svg>
    );
}

/** Пипетка по референсу. */
export function EyedropperIcon({ className }: IconProps) {
    return (
        <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M13.5 2.5a1.77 1.77 0 0 0-2.5-.4L9.6 3.4l1 1-6 6-.7 3.3 3.3-.7 6-6 1 1 1.3-1.4a1.77 1.77 0 0 0 0-2.7z" />
            <path d="M4.5 11.5l-2 2" />
        </svg>
    );
}

/** Перенос (drag) референса. */
export function MoveIcon({ className }: IconProps) {
    return (
        <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M8 1.5v13M1.5 8h13" />
            <path d="M6 3.5 8 1.5l2 2M6 12.5 8 14.5l2-2M3.5 6 1.5 8l2 2M12.5 6 14.5 8l-2 2" />
        </svg>
    );
}
