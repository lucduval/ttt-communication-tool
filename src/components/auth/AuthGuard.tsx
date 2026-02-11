"use client";

import { useConvexAuth, useQuery, useMutation } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { api } from "@/../convex/_generated/api";
import { useRouter, usePathname } from "next/navigation";
import { Loader2, ShieldAlert } from "lucide-react";

export function AuthGuard({ children }: { children: React.ReactNode }) {
    const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
    const { user: clerkUser, isLoaded: isClerkLoaded } = useUser();
    const router = useRouter();
    const pathname = usePathname();

    // Sync user to Convex
    const storeUser = useMutation(api.users.store);

    useEffect(() => {
        if (isAuthenticated && clerkUser && isClerkLoaded) {
            storeUser({
                clerkId: clerkUser.id,
                email: clerkUser.primaryEmailAddress?.emailAddress || "",
                name: clerkUser.fullName || clerkUser.firstName || "User",
            });
        }
    }, [isAuthenticated, clerkUser, isClerkLoaded, storeUser]);

    // Check access
    const access = useQuery(api.users.checkAccess);

    // Determine if we should show loading state
    // We wait for auth to load, and if authenticated, for access check to load
    const isLoading = isAuthLoading || !isClerkLoaded || (isAuthenticated && access === undefined);

    // Redirect logic
    useEffect(() => {
        if (isLoading) return;

        // Allow public access to sign-in pages (handled by middleware mostly, but good to be safe)
        // Note: middleware already protects most routes.

        if (isAuthenticated && access) {
            if (access.hasAccess === false) {
                // Redirect to access denied if not already there
                if (pathname !== "/access-denied") {
                    router.push("/access-denied");
                }
            } else if (pathname === "/access-denied") {
                // If they have access but are on access denied page, send them home
                router.push("/");
            }
        }
    }, [isLoading, isAuthenticated, access, router, pathname]);

    if (isLoading) {
        return (
            <div className="h-screen w-full flex items-center justify-center bg-[#F5F7FA]">
                <Loader2 className="animate-spin text-blue-600" size={48} />
            </div>
        );
    }

    if (isAuthenticated && access?.hasAccess === false) {
        // We render null here (or a fallback) because the useEffect will redirect
        // But to prevent flash of content (or if redirect is slow), we can show a minimal access denied state 
        // OR we just return null and let the redirect happen.
        // However, if we are already on /access-denied, we need to render children (UserButton needs to work there?)
        // Let's create a dedicated /access-denied page, so if pathname is /access-denied, we render children.

        if (pathname !== "/access-denied") {
            return null;
        }
    }

    return <>{children}</>;
}
