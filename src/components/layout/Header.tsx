"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
// @ts-ignore
import { api } from "../../../convex/_generated/api";

import { Bell, Search } from "lucide-react";
import { UserButton } from "@clerk/nextjs";

import { NotificationBell } from "./NotificationBell";

interface HeaderProps {
    title: string;
}

export function Header({ title }: HeaderProps) {
    const router = useRouter();
    const [searchQuery, setSearchQuery] = useState("");
    const [isFocused, setIsFocused] = useState(false);
    const searchRef = useRef<HTMLDivElement>(null);

    const searchResults = useQuery(api.campaigns.search, { query: searchQuery });

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
                setIsFocused(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    const handleSelectCampaign = (campaignId: string) => {
        router.push(`/campaigns/${campaignId}`);
        setSearchQuery("");
        setIsFocused(false);
    };

    return (
        <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-8 z-10">
            <h2 className="text-xl font-bold text-[#1E3A5F]">{title}</h2>

            <div className="flex items-center gap-4">
                <div className="relative" ref={searchRef}>
                    <Search
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                        size={18}
                    />
                    <input
                        type="text"
                        placeholder="Search campaigns..."
                        className="pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#1E3A5F]/20 w-64"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onFocus={() => setIsFocused(true)}
                    />

                    {/* Search Results Dropdown */}
                    {isFocused && searchQuery && (
                        <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-200 rounded-md shadow-lg z-50 max-h-60 overflow-y-auto">
                            {searchResults === undefined ? (
                                <div className="p-3 text-sm text-gray-500">Loading...</div>
                            ) : searchResults.length > 0 ? (
                                <ul>
                                    {searchResults.map((campaign: any) => (
                                        <li
                                            key={campaign._id}
                                            className="px-4 py-2 hover:bg-gray-50 cursor-pointer text-sm text-gray-700 flex justify-between items-center"
                                            onClick={() => handleSelectCampaign(campaign._id)}
                                        >
                                            <span className="font-medium truncate mr-2">{campaign.name}</span>
                                            <span className={`text-xs px-2 py-0.5 rounded-full ${campaign.status === 'completed' ? 'bg-green-100 text-green-700' :
                                                campaign.status === 'failed' ? 'bg-red-100 text-red-700' :
                                                    'bg-blue-100 text-blue-700'
                                                }`}>
                                                {campaign.status}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <div className="p-3 text-sm text-gray-500">No campaigns found</div>
                            )}
                        </div>
                    )}
                </div>

                <NotificationBell />

                <div className="h-8 w-px bg-gray-200 mx-2"></div>

                <UserButton
                    afterSignOutUrl="/"
                    appearance={{
                        elements: {
                            avatarBox: "w-10 h-10",
                        },
                    }}
                />
            </div>
        </header>
    );
}
