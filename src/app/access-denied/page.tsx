"use client";

import { UserButton } from "@clerk/nextjs";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui";

export default function AccessDeniedPage() {
    return (
        <div className="flex flex-col items-center justify-center h-screen bg-[#F5F7FA] p-4 text-center">
            <div className="bg-white p-8 rounded-2xl shadow-lg max-w-md w-full flex flex-col items-center">
                <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-6">
                    <ShieldAlert size={32} className="text-red-600" />
                </div>

                <h1 className="text-2xl font-bold text-gray-900 mb-2">Access Restricted</h1>

                <p className="text-gray-600 mb-8">
                    You do not have permission to access the TTT Communication Tool.
                    Please contact an administrator to request access.
                </p>

                <div className="flex flex-col gap-4 w-full">
                    <div className="flex justify-center p-2 border rounded-lg bg-gray-50">
                        <UserButton afterSignOutUrl="/sign-in" showName />
                    </div>
                </div>
            </div>
        </div>
    );
}
