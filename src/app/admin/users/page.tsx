"use client";

import { Header } from "@/components/layout";
import { UserManagement } from "@/components/admin/UserManagement";

export default function AdminUsersPage() {
    return (
        <>
            <Header title="User Management" />
            <section className="flex-1 overflow-y-auto p-8">
                <div className="max-w-6xl mx-auto">
                    <div className="mb-6">
                        <h2 className="text-xl font-bold text-gray-900">Organization Settings</h2>
                        <p className="text-gray-500">Manage access and roles for your team.</p>
                    </div>

                    <UserManagement />
                </div>
            </section>
        </>
    );
}
