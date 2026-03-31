"use client";

import { useState, useEffect } from "react";

const LOADING_MESSAGES = [
    "Convincing Dynamics 365 to share its secrets...",
    "Herding digital cats across the CRM...",
    "Bribing the database with coffee...",
    "Asking nicely for your data...",
    "Untangling the spaghetti of contacts...",
    "Warming up the hamster wheel...",
    "Negotiating with Microsoft's servers...",
    "Doing the paperwork nobody else wants to...",
    "Counting beans in the cloud...",
    "Fetching data at the speed of bureaucracy...",
    "Teaching the API some manners...",
    "Politely waiting in the server queue...",
];

export function LoadingScreen() {
    const [messageIndex, setMessageIndex] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setMessageIndex((prev) => (prev + 1) % LOADING_MESSAGES.length);
        }, 3000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="flex flex-col items-center justify-center py-24 gap-5">
            <div className="relative">
                <div className="w-16 h-16 rounded-full border-4 border-gray-200" />
                <div className="absolute inset-0 w-16 h-16 rounded-full border-4 border-t-[#1E3A5F] animate-spin" />
            </div>
            <div className="text-center space-y-2">
                <p className="text-lg font-semibold text-[#1E3A5F]">Loading...</p>
                <p className="text-sm text-gray-500 italic transition-opacity duration-500">
                    {LOADING_MESSAGES[messageIndex]}
                </p>
            </div>
        </div>
    );
}
