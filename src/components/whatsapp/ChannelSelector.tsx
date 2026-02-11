"use client";

import { Mail, MessageSquare } from "lucide-react";

interface ChannelSelectorProps {
    selectedChannel: "email" | "whatsapp";
    onChannelChange: (channel: "email" | "whatsapp") => void;
    campaignTitle: string;
    onTitleChange: (title: string) => void;
    showTitleError?: boolean;
}

export function ChannelSelector({
    selectedChannel,
    onChannelChange,
    campaignTitle,
    onTitleChange,
    showTitleError = false,
}: ChannelSelectorProps) {
    return (
        <div className="space-y-6">
            {/* Campaign Title - First */}
            <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Campaign Internal Title <span className="text-red-500">*</span>
                </label>
                <input
                    type="text"
                    value={campaignTitle}
                    onChange={(e) => onTitleChange(e.target.value)}
                    placeholder="e.g. Annual Bonus Notification 2024"
                    className={`w-full px-4 py-3 border rounded-md focus:outline-none focus:ring-2 focus:ring-[#1E3A5F]/20 ${showTitleError && !campaignTitle.trim()
                        ? "border-red-400 bg-red-50"
                        : "border-gray-200"
                        }`}
                />
                {showTitleError && !campaignTitle.trim() && (
                    <p className="mt-2 text-sm text-red-500">
                        Please enter a campaign title to continue.
                    </p>
                )}
            </div>

            {/* Channel Selection - Second */}
            <div className="pt-4 border-t border-gray-100">
                <h3 className="text-xl font-bold text-gray-900">
                    Choose your communication channel
                </h3>
                <p className="text-gray-500 mt-1">
                    Select the best way to reach your clients for this campaign
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4">
                    {/* Email Option */}
                    <div
                        onClick={() => onChannelChange("email")}
                        className={`p-6 border-2 rounded-xl cursor-pointer transition-all ${selectedChannel === "email"
                            ? "border-[#1E3A5F] bg-[#1E3A5F]/5 shadow-md"
                            : "border-gray-100 hover:border-gray-200"
                            }`}
                    >
                        <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-lg flex items-center justify-center mb-4">
                            <Mail size={24} />
                        </div>
                        <h4 className="font-bold text-lg mb-1">Email Campaign</h4>
                        <p className="text-sm text-gray-500">
                            Rich HTML layouts, no character limits, best for newsletters and
                            official statements.
                        </p>
                    </div>

                    {/* WhatsApp Option */}
                    <div
                        onClick={() => onChannelChange("whatsapp")}
                        className={`p-6 border-2 rounded-xl cursor-pointer transition-all ${selectedChannel === "whatsapp"
                            ? "border-[#1E3A5F] bg-[#1E3A5F]/5 shadow-md"
                            : "border-gray-100 hover:border-gray-200"
                            }`}
                    >
                        <div className="w-12 h-12 bg-green-100 text-green-600 rounded-lg flex items-center justify-center mb-4">
                            <MessageSquare size={24} />
                        </div>
                        <h4 className="font-bold text-lg mb-1">WhatsApp Message</h4>
                        <p className="text-sm text-gray-500">
                            Instant delivery, higher open rates, best for urgent alerts and
                            quick updates.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
