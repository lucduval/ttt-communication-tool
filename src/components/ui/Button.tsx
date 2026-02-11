import { cn } from "@/lib/utils";
import { ButtonHTMLAttributes, forwardRef } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "primary" | "secondary" | "ghost" | "danger";
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ children, variant = "primary", className, ...props }, ref) => {
        const variants = {
            primary: "bg-[#1E3A5F] text-white hover:bg-[#162d4a]",
            secondary:
                "bg-white text-[#1E3A5F] border border-[#1E3A5F] hover:bg-gray-50",
            ghost: "bg-transparent text-gray-500 hover:bg-gray-100",
            danger: "bg-red-50 text-red-600 hover:bg-red-100 border border-red-200",
        };

        return (
            <button
                ref={ref}
                className={cn(
                    "px-4 py-2 rounded-md font-medium transition-colors duration-200 flex items-center justify-center gap-2",
                    variants[variant],
                    className
                )}
                {...props}
            >
                {children}
            </button>
        );
    }
);

Button.displayName = "Button";

export { Button };
