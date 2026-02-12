"use client";

import { Header } from "@/components/layout";
import { Card } from "@/components/ui";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useUser } from "@clerk/nextjs";
import {
    User,
    Mail,
    Shield,
    Clock,
    Info,
    ExternalLink,
} from "lucide-react";

export default function SettingsPage() {
    const { user: clerkUser } = useUser();
    const access = useQuery(api.users.checkAccess);
    const convexUser = access?.user;

    return (
        <>
            <Header title="Settings" />
            <section className="flex-1 overflow-y-auto p-8">
                <div className="max-w-4xl mx-auto space-y-8">
                    {/* Profile Section */}
                    <Card>
                        <div className="flex items-start gap-6">
                            <div className="w-16 h-16 bg-[#1E3A5F] rounded-full flex items-center justify-center text-white text-2xl font-bold flex-shrink-0">
                                {clerkUser?.firstName?.charAt(0) || clerkUser?.emailAddresses?.[0]?.emailAddress?.charAt(0)?.toUpperCase() || "?"}
                            </div>
                            <div className="flex-1 min-w-0">
                                <h2 className="text-xl font-bold text-gray-900">
                                    {convexUser?.name || clerkUser?.fullName || "User"}
                                </h2>
                                <p className="text-gray-500 text-sm mt-1">
                                    Manage your account details and preferences
                                </p>
                            </div>
                        </div>
                    </Card>

                    {/* Account Details */}
                    <Card title="Account Details" subtitle="Your account information on TTT Connect">
                        <div className="divide-y divide-gray-100">
                            <SettingRow
                                icon={<User size={18} />}
                                label="Full Name"
                                value={convexUser?.name || clerkUser?.fullName || "—"}
                            />
                            <SettingRow
                                icon={<Mail size={18} />}
                                label="Email Address"
                                value={convexUser?.email || clerkUser?.emailAddresses?.[0]?.emailAddress || "—"}
                            />
                            <SettingRow
                                icon={<Shield size={18} />}
                                label="Role"
                                value={
                                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${convexUser?.role === "admin"
                                            ? "bg-purple-100 text-purple-700"
                                            : "bg-blue-100 text-blue-700"
                                        }`}>
                                        {convexUser?.role === "admin" ? "Administrator" : "User"}
                                    </span>
                                }
                            />
                            <SettingRow
                                icon={<Clock size={18} />}
                                label="Last Login"
                                value={
                                    convexUser?.lastLoginAt
                                        ? new Date(convexUser.lastLoginAt).toLocaleString()
                                        : "—"
                                }
                            />
                            <SettingRow
                                icon={<Clock size={18} />}
                                label="Member Since"
                                value={
                                    convexUser?.joinedAt
                                        ? new Date(convexUser.joinedAt).toLocaleDateString()
                                        : "—"
                                }
                            />
                        </div>
                    </Card>

                    {/* About Section */}
                    <Card title="About TTT Connect" subtitle="Application information">
                        <div className="divide-y divide-gray-100">
                            <SettingRow
                                icon={<Info size={18} />}
                                label="Application"
                                value="TTT Connect — Communication Tool"
                            />
                            <SettingRow
                                icon={<Info size={18} />}
                                label="Description"
                                value="Send bulk emails and WhatsApp messages to your clients via Dynamics 365 CRM"
                            />
                        </div>
                    </Card>

                    {/* Quick Links */}
                    <Card title="Quick Links">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <QuickLink
                                href="/campaigns/new"
                                label="Create Campaign"
                                description="Start a new email or WhatsApp campaign"
                            />
                            <QuickLink
                                href="/recipients"
                                label="CRM Recipients"
                                description="Browse and filter contacts from Dynamics 365"
                            />
                            <QuickLink
                                href="/templates/whatsapp"
                                label="WhatsApp Templates"
                                description="Manage your approved message templates"
                            />
                            <QuickLink
                                href="/campaigns"
                                label="Campaigns"
                                description="View and monitor all your campaigns"
                            />
                        </div>
                    </Card>
                </div>
            </section>
        </>
    );
}

function SettingRow({
    icon,
    label,
    value,
}: {
    icon: React.ReactNode;
    label: string;
    value: React.ReactNode;
}) {
    return (
        <div className="flex items-center justify-between py-4 first:pt-0 last:pb-0">
            <div className="flex items-center gap-3 text-gray-500">
                {icon}
                <span className="text-sm font-medium">{label}</span>
            </div>
            <div className="text-sm text-gray-900 text-right">{value}</div>
        </div>
    );
}

function QuickLink({
    href,
    label,
    description,
}: {
    href: string;
    label: string;
    description: string;
}) {
    return (
        <a
            href={href}
            className="group flex items-start gap-3 p-4 rounded-lg border border-gray-100 hover:border-[#1E3A5F]/20 hover:bg-blue-50/30 transition-all"
        >
            <ExternalLink
                size={16}
                className="text-gray-400 group-hover:text-[#1E3A5F] mt-0.5 flex-shrink-0 transition-colors"
            />
            <div>
                <p className="text-sm font-semibold text-gray-900 group-hover:text-[#1E3A5F] transition-colors">
                    {label}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">{description}</p>
            </div>
        </a>
    );
}
