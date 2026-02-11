import { cn } from "@/lib/utils";
import { ReactNode } from "react";

interface CardProps {
    children: ReactNode;
    title?: string;
    subtitle?: string;
    footer?: ReactNode;
    className?: string;
}

export function Card({
    children,
    title,
    subtitle,
    footer,
    className,
}: CardProps) {
    return (
        <div
            className={cn(
                "bg-white border border-[#F5F7FA] shadow-sm rounded-lg overflow-hidden",
                className
            )}
        >
            {(title || subtitle) && (
                <div className="px-6 py-4 border-b border-gray-100">
                    {title && (
                        <h3 className="text-lg font-semibold text-[#1E3A5F]">{title}</h3>
                    )}
                    {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
                </div>
            )}
            <div className="p-6">{children}</div>
            {footer && (
                <div className="px-6 py-4 bg-gray-50 border-t border-gray-100">
                    {footer}
                </div>
            )}
        </div>
    );
}
