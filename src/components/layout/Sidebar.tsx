"use client";

import { cn } from "@/lib/utils";
import {
    LayoutDashboard,
    Plus,
    Users,
    BarChart3,
    FileText,
    Settings,
    Send,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, href: "/" },
    { id: "wizard", label: "Create Campaign", icon: Plus, href: "/campaigns/new" },
    { id: "recipients", label: "CRM Recipients", icon: Users, href: "/recipients" },
    { id: "monitoring", label: "Campaigns", icon: BarChart3, href: "/campaigns" },
    { id: "templates", label: "Templates", icon: FileText, href: "/templates/whatsapp" },
];

import { useQuery } from "convex/react";
import { api } from "@/../convex/_generated/api";

interface SidebarProps {
    onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
    const pathname = usePathname();
    const access = useQuery(api.users.checkAccess);
    const isAdmin = access?.user?.role === "admin";

    const isActive = (href: string) => {
        if (href === "/") return pathname === "/";
        return pathname.startsWith(href);
    };

    return (
        <aside className="bg-[#1E3A5F] text-white w-64 flex flex-col min-h-screen h-full">
            <div className="p-6 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-blue-400 rounded flex items-center justify-center font-bold text-[#1E3A5F]">
                        <Send size={20} />
                    </div>
                    <span className="font-bold text-xl tracking-tight">TTT Connect</span>
                </div>
                {/* Mobile close button */}
                <button
                    onClick={onClose}
                    className="md:hidden text-white/70 hover:text-white"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 18 18" /></svg>
                </button>
            </div>

            <nav className="flex-1 px-4 py-4 space-y-2">
                {navItems.map((item) => (
                    <Link
                        key={item.id}
                        href={item.href}
                        className={cn(
                            "w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200",
                            isActive(item.href)
                                ? "bg-white/10 text-white shadow-inner"
                                : "text-gray-400 hover:text-white hover:bg-white/5"
                        )}
                    >
                        <item.icon size={20} />
                        <span className="font-medium">{item.label}</span>
                    </Link>
                ))}
            </nav>

            <div className="p-4 border-t border-white/10 space-y-2">
                {isAdmin && (
                    <Link
                        href="/admin/users"
                        className={cn(
                            "flex items-center gap-3 px-4 py-2 rounded-lg transition-colors",
                            isActive("/admin/users")
                                ? "bg-white/10 text-white"
                                : "text-gray-400 hover:text-white hover:bg-white/5"
                        )}
                    >
                        <Users size={20} />
                        <span>Users</span>
                    </Link>
                )}
                <Link
                    href="/settings"
                    className={cn(
                        "flex items-center gap-3 px-4 py-2 rounded-lg transition-colors",
                        isActive("/settings")
                            ? "bg-white/10 text-white"
                            : "text-gray-400 hover:text-white hover:bg-white/5"
                    )}
                >
                    <Settings size={20} />
                    <span>Settings</span>
                </Link>
            </div>
        </aside>
    );
}
