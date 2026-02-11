import { cn } from "@/lib/utils";
import { ReactNode } from "react";

type BadgeStatus = "success" | "error" | "warning" | "info" | "default";

interface BadgeProps {
    children: ReactNode;
    status?: BadgeStatus;
    className?: string;
}

export function Badge({ children, status = "default", className }: BadgeProps) {
    const colors: Record<BadgeStatus, string> = {
        success: "bg-green-50 text-green-700 border-green-200",
        error: "bg-red-50 text-red-700 border-red-200",
        warning: "bg-yellow-50 text-yellow-700 border-yellow-200",
        info: "bg-blue-50 text-blue-700 border-blue-200",
        default: "bg-gray-50 text-gray-600 border-gray-200",
    };

    return (
        <span
            className={cn(
                "px-2.5 py-0.5 rounded-full text-xs font-medium border",
                colors[status],
                className
            )}
        >
            {children}
        </span>
    );
}
