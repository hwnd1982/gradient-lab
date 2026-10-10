import { useState } from 'react';
import type { ReactNode } from 'react';

interface CollapsibleSectionProps {
    title: string;
    defaultOpen?: boolean;
    children: ReactNode;
}

export function CollapsibleSection({
    title,
    defaultOpen = true,
    children,
}: CollapsibleSectionProps) {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <section className="border-b border-lab-border">
            <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left"
                onClick={() => setOpen(!open)}
            >
                <svg
                    className={`h-3 w-3 shrink-0 text-lab-muted transition-transform ${
                        open ? 'rotate-90' : ''
                    }`}
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="M6 3.5 10.5 8 6 12.5" />
                </svg>
                <span className="text-xs font-medium tracking-wide text-lab-muted uppercase">
                    {title}
                </span>
            </button>
            {open && <div className="flex flex-col gap-3 px-4 pb-4">{children}</div>}
        </section>
    );
}
