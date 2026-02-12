"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAuth, useUser } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Card } from "@/components/ui";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";

export default function AcceptInvitePage() {
    const searchParams = useSearchParams();
    const token = searchParams.get("token");
    const router = useRouter();
    const { isSignedIn, isLoaded: isAuthLoaded, signOut } = useAuth();
    const { user, isLoaded: isUserLoaded } = useUser();

    const [isAccepting, setIsAccepting] = useState(false);
    const [acceptError, setAcceptError] = useState<string | null>(null);

    // 1. Validate the invitation token
    const invitation = useQuery(api.users.validateInvitation,
        token ? { token } : "skip"
    );

    const acceptInvitation = useMutation(api.users.acceptInvitation);

    // 2. Auto-accept if conditions are met
    useEffect(() => {
        const autoAccept = async () => {
            if (
                !token ||                                   // No token
                !invitation ||                              // Validation not done
                !invitation.valid ||                        // Invalid token
                !isSignedIn ||                              // Not logged in
                !user?.primaryEmailAddress?.emailAddress    // User email not loaded
            ) {
                return;
            }

            const userEmail = user.primaryEmailAddress.emailAddress;

            // Check email match (case-insensitive)
            if (userEmail.toLowerCase() !== invitation.email.toLowerCase()) {
                return; // Mismatch handled in UI
            }

            if (isAccepting) return; // Already in progress

            setIsAccepting(true);
            try {
                await acceptInvitation({ token });
                router.push("/");
            } catch (err) {
                console.error("Failed to accept invitation:", err);
                setAcceptError(err instanceof Error ? err.message : "Failed to accept invitation");
                setIsAccepting(false);
            }
        };

        autoAccept();
    }, [token, invitation, isSignedIn, user, router, acceptInvitation, isAccepting]);

    // --- Loading States ---
    if (!isAuthLoaded || !isUserLoaded || (token && invitation === undefined)) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50">
                <Loader2 className="animate-spin text-blue-600 mb-4" size={32} />
                <p className="text-gray-500">Validating invitation...</p>
            </div>
        );
    }

    // --- Error: Missing Token ---
    if (!token) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 px-4">
                <Card className="max-w-md w-full p-8 text-center text-red-600">
                    <AlertCircle className="mx-auto mb-4" size={48} />
                    <h1 className="text-2xl font-bold mb-2">Invalid Link</h1>
                    <p className="text-gray-600">This invitation link is missing a token. Please check the link in your email.</p>
                </Card>
            </div>
        );
    }

    // --- Error: Invalid/Expired Token ---
    if (invitation && !invitation.valid) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 px-4">
                <Card className="max-w-md w-full p-8 text-center">
                    <AlertCircle className="mx-auto mb-4 text-red-500" size={48} />
                    <h1 className="text-2xl font-bold mb-2 text-gray-900">Invitation Invalid</h1>
                    <p className="text-gray-600 mb-6">{invitation.error || "This invitation is no longer valid."}</p>
                    <Button onClick={() => router.push("/")} variant="outline">
                        Return to Home
                    </Button>
                </Card>
            </div>
        );
    }

    // --- Success State (Waiting for User Action) ---
    // If we are here, the token matches a valid pending invitation

    // Scenario: Not Logged In -> Prompt to Sign In
    if (!isSignedIn) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 px-4">
                <Card className="max-w-md w-full p-8 text-center">
                    <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
                        <CheckCircle className="text-blue-600" size={32} />
                    </div>
                    <h1 className="text-2xl font-bold mb-2 text-gray-900">You've been invited!</h1>
                    <p className="text-gray-600 mb-6">
                        You have been invited to join <strong>TTT Communication Tool</strong> as
                        <span className="font-medium text-gray-900 mx-1">{invitation?.email}</span>.
                    </p>
                    <div className="bg-blue-50 text-blue-800 text-sm p-4 rounded-lg mb-6">
                        Please sign in or create an account with this email address to accept the invitation.
                    </div>

                    <div className="flex flex-col gap-3">
                        <Button
                            onClick={() => router.push("/sign-in?redirect_url=" + encodeURIComponent(window.location.href))}
                            className="w-full"
                        >
                            Sign In / Sign Up
                        </Button>
                    </div>
                </Card>
            </div>
        );
    }

    // Scenario: Logged In but Email Mismatch -> Prompt to Switch Account
    const userEmail = user?.primaryEmailAddress?.emailAddress;
    if (userEmail && invitation?.email && userEmail.toLowerCase() !== invitation.email.toLowerCase()) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 px-4">
                <Card className="max-w-md w-full p-8 text-center">
                    <AlertCircle className="mx-auto mb-4 text-amber-500" size={48} />
                    <h1 className="text-2xl font-bold mb-2 text-gray-900">Wrong Account</h1>
                    <p className="text-gray-600 mb-4">
                        This invitation is for <strong>{invitation.email}</strong>, but you are signed in as <strong>{userEmail}</strong>.
                    </p>
                    <div className="flex flex-col gap-3 mt-4">
                        <Button onClick={() => signOut()} variant="outline" className="w-full text-red-600 border-red-200 hover:bg-red-50">
                            Sign Out & Switch Account
                        </Button>
                    </div>
                </Card>
            </div>
        );
    }

    // Scenario: Logged In & Email Match -> Processing Acceptance
    // The useEffect hook should handle the actual mutation and redirect.
    // This UI is just a fallback while that happens or if there was an error.
    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 px-4">
            <Card className="max-w-md w-full p-8 text-center">
                {acceptError ? (
                    <>
                        <AlertCircle className="mx-auto mb-4 text-red-500" size={48} />
                        <h1 className="text-xl font-bold mb-2 text-gray-900">Something went wrong</h1>
                        <p className="text-gray-600 mb-6">{acceptError}</p>
                        <Button onClick={() => window.location.reload()} variant="outline">
                            Try Again
                        </Button>
                    </>
                ) : (
                    <>
                        <Loader2 className="animate-spin text-blue-600 mx-auto mb-4" size={48} />
                        <h1 className="text-xl font-bold mb-2 text-gray-900">Accepting Invitation...</h1>
                        <p className="text-gray-600">Setting up your account access.</p>
                    </>
                )}
            </Card>
        </div>
    );
}
