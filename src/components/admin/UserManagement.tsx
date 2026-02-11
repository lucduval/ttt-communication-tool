"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/../convex/_generated/api";
import { Button, Card, Badge, Input } from "@/components/ui"; // Standard UI components
import {
    Users,
    UserPlus,
    Mail,
    Trash2,
    CheckCircle,
    XCircle,
    Shield,
    MoreVertical,
    Calendar,
    Search
} from "lucide-react";
import type { Doc, Id } from "@/../convex/_generated/dataModel";

export function UserManagement() {
    const [activeTab, setActiveTab] = useState<"users" | "invitations">("users");
    const [inviteEmail, setInviteEmail] = useState("");
    const [inviteRole, setInviteRole] = useState<"user" | "admin">("user");
    const [isInviting, setIsInviting] = useState(false);

    const users = useQuery(api.users.list);
    const invitations = useQuery(api.users.listInvitations);

    const createInvitation = useMutation(api.users.createInvitation);
    const revokeInvitation = useMutation(api.users.revokeInvitation);
    const updateUser = useMutation(api.users.updateUser);

    const handleInvite = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!inviteEmail) return;

        setIsInviting(true);
        try {
            await createInvitation({
                email: inviteEmail,
                role: inviteRole,
            });
            setInviteEmail("");
            alert("Invitation sent! (Token generated)");
        } catch (err) {
            alert("Failed to invite: " + (err as Error).message);
        } finally {
            setIsInviting(false);
        }
    };

    const handleRevoke = async (id: Id<"invitations">) => {
        if (!confirm("Revoke this invitation?")) return;
        await revokeInvitation({ id });
    };

    const handleToggleStatus = async (user: Doc<"users">) => {
        const newStatus = user.status === "active" ? "inactive" : "active";
        await updateUser({ id: user._id, status: newStatus });
    };

    const handleToggleRole = async (user: Doc<"users">) => {
        const newRole = user.role === "admin" ? "user" : "admin";
        await updateUser({ id: user._id, role: newRole });
    };

    return (
        <div className="space-y-6">
            {/* Header / Tabs */}
            <div className="flex items-center gap-4 border-b border-gray-200">
                <button
                    onClick={() => setActiveTab("users")}
                    className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "users"
                        ? "border-blue-600 text-blue-600"
                        : "border-transparent text-gray-500 hover:text-gray-700"
                        }`}
                >
                    Active Users
                </button>
                <button
                    onClick={() => setActiveTab("invitations")}
                    className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "invitations"
                        ? "border-blue-600 text-blue-600"
                        : "border-transparent text-gray-500 hover:text-gray-700"
                        }`}
                >
                    Invitations
                </button>
            </div>

            {/* Invite Form */}
            <Card className="bg-blue-50 border-blue-100">
                <form onSubmit={handleInvite} className="flex flex-col md:flex-row gap-4 md:items-end">
                    <div className="w-full md:flex-1">
                        <label className="block text-sm font-medium text-blue-900 mb-1">Invite New User</label>
                        <div className="relative">
                            <Mail className="absolute left-3 top-2.5 text-blue-400" size={18} />
                            <input
                                type="email"
                                placeholder="email@company.com"
                                className="w-full pl-10 pr-4 py-2 rounded-lg border border-blue-200 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                                value={inviteEmail}
                                onChange={(e) => setInviteEmail(e.target.value)}
                                required
                            />
                        </div>
                    </div>
                    <div className="w-full md:w-auto">
                        <label className="block text-sm font-medium text-blue-900 mb-1">Role</label>
                        <select
                            className="w-full md:w-32 px-3 py-2 rounded-lg border border-blue-200 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                            value={inviteRole}
                            onChange={(e) => setInviteRole(e.target.value as any)}
                        >
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                        </select>
                    </div>
                    <Button type="submit" disabled={isInviting} className="w-full md:w-auto">
                        {isInviting ? "Sending..." : "Send Invite"}
                    </Button>
                </form>
            </Card>

            {/* Content Actions */}
            {activeTab === "users" && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-gray-50 border-b border-gray-100 text-gray-500">
                            <tr>
                                <th className="px-6 py-3 font-medium">User</th>
                                <th className="px-6 py-3 font-medium">Role</th>
                                <th className="px-6 py-3 font-medium">Status</th>
                                <th className="px-6 py-3 font-medium">Joined</th>
                                <th className="px-6 py-3 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {users?.map((user) => (
                                <tr key={user._id} className="hover:bg-gray-50">
                                    <td className="px-6 py-4">
                                        <div className="font-medium text-gray-900">{user.name || "Unknown"}</div>
                                        <div className="text-gray-500 text-xs">{user.email}</div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <Badge status={user.role === "admin" ? "warning" : "default"}>
                                            {user.role}
                                        </Badge>
                                    </td>
                                    <td className="px-6 py-4">
                                        <Badge status={user.status === "active" ? "success" : "error"}>
                                            {user.status}
                                        </Badge>
                                    </td>
                                    <td className="px-6 py-4 text-gray-500">
                                        {user.joinedAt ? new Date(user.joinedAt).toLocaleDateString() : "-"}
                                    </td>
                                    <td className="px-6 py-4 text-right flex justify-end gap-2">
                                        <button
                                            onClick={() => handleToggleRole(user)}
                                            className="p-1.5 hover:bg-gray-100 rounded text-gray-500"
                                            title="Toggle Role"
                                        >
                                            <Shield size={16} />
                                        </button>
                                        <button
                                            onClick={() => handleToggleStatus(user)}
                                            className="p-1.5 hover:bg-gray-100 rounded text-gray-500"
                                            title={user.status === "active" ? "Deactivate" : "Activate"}
                                        >
                                            {user.status === "active" ? <XCircle size={16} className="text-red-500" /> : <CheckCircle size={16} className="text-green-500" />}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                            {users?.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="px-6 py-8 text-center text-gray-500">
                                        No users found.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {activeTab === "invitations" && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-gray-50 border-b border-gray-100 text-gray-500">
                            <tr>
                                <th className="px-6 py-3 font-medium">Email</th>
                                <th className="px-6 py-3 font-medium">Role</th>
                                <th className="px-6 py-3 font-medium">Status</th>
                                <th className="px-6 py-3 font-medium">Details</th>
                                <th className="px-6 py-3 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {invitations?.map((invite) => (
                                <tr key={invite._id} className="hover:bg-gray-50">
                                    <td className="px-6 py-4 font-medium text-gray-900">
                                        {invite.email}
                                    </td>
                                    <td className="px-6 py-4">
                                        <Badge status={invite.role === "admin" ? "warning" : "default"}>
                                            {invite.role}
                                        </Badge>
                                    </td>
                                    <td className="px-6 py-4">
                                        <Badge status={
                                            invite.status === "pending" ? "info" :
                                                invite.status === "accepted" ? "success" : "error"
                                        }>
                                            {invite.status}
                                        </Badge>
                                    </td>
                                    <td className="px-6 py-4 text-xs text-gray-500">
                                        <div>Token: <span className="font-mono bg-gray-100 px-1 rounded">{invite.token.substring(0, 8)}...</span></div>
                                        <div>Expires: {new Date(invite.expiresAt).toLocaleDateString()}</div>
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        {invite.status === "pending" && (
                                            <button
                                                onClick={() => handleRevoke(invite._id)}
                                                className="p-1.5 hover:bg-red-50 rounded text-red-500"
                                                title="Revoke Invitation"
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                            {invitations?.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="px-6 py-8 text-center text-gray-500">
                                        No invitations found.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
