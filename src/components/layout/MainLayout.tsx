"use client";

import { useState, useEffect, createContext, useContext } from "react";
import { Sidebar } from "./Sidebar";
import { usePathname } from "next/navigation";

interface SidebarContextType {
    isOpen: boolean;
    toggle: () => void;
    close: () => void;
}

const SidebarContext = createContext<SidebarContextType | undefined>(undefined);

export function useSidebar() {
    const context = useContext(SidebarContext);
    if (!context) {
        return { isOpen: false, toggle: () => { }, close: () => { } };
    }
    return context;
}

interface MainLayoutProps {
    children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
    const [isOpen, setIsOpen] = useState(false);
    const pathname = usePathname();

    // Close sidebar on route change (mobile)
    useEffect(() => {
        setIsOpen(false);
    }, [pathname]);

    return (
        <SidebarContext.Provider value={{ isOpen, toggle: () => setIsOpen(!isOpen), close: () => setIsOpen(false) }}>
            <div className="flex h-screen bg-[#F5F7FA] text-gray-800 font-sans">
                {/* Mobile Sidebar Overlay */}
                {isOpen && (
                    <div
                        className="fixed inset-0 bg-black/50 z-40 md:hidden"
                        onClick={() => setIsOpen(false)}
                    />
                )}

                {/* Sidebar - Desktop: always visible, Mobile: controlled by state */}
                <div
                    className={`
            fixed inset-y-0 left-0 z-50 transform transition-transform duration-300 ease-in-out
            md:relative md:translate-x-0
            ${isOpen ? "translate-x-0" : "-translate-x-full"}
          `}
                >
                    <Sidebar onClose={() => setIsOpen(false)} />
                </div>

                <main className="flex-1 flex flex-col overflow-hidden w-full relative">
                    {children}
                </main>
            </div>
        </SidebarContext.Provider>
    );
}
