"use client";

import { useState, useRef, useEffect } from "react";
import { Bell, Check, ExternalLink, X } from "lucide-react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/../convex/_generated/api";
import { useRouter } from "next/navigation";
import type { Id } from "@/../convex/_generated/dataModel";

export function NotificationBell() {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const router = useRouter();

    const notifications = useQuery(api.notifications.list) || [];
    const unreadCount = useQuery(api.notifications.getUnreadCount) || 0;
    const markAsRead = useMutation(api.notifications.markAsRead);
    const markAllAsRead = useMutation(api.notifications.markAllAsRead);

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    const handleNotificationClick = async (notification: any) => {
        if (!notification.isRead) {
            await markAsRead({ notificationId: notification._id });
        }

        if (notification.link) {
            setIsOpen(false);
            router.push(notification.link);
        }
    };

    const handleMarkAllRead = async (e: React.MouseEvent) => {
        e.stopPropagation();
        await markAllAsRead();
    };

    const getIconColor = (type: string) => {
        switch (type) {
            case "success": return "text-green-500 bg-green-50";
            case "error": return "text-red-500 bg-red-50";
            case "warning": return "text-amber-500 bg-amber-50";
            default: return "text-blue-500 bg-blue-50";
        }
    };

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="p-2 relative text-gray-500 hover:bg-gray-100 rounded-full transition-colors focus:outline-none"
            >
                <Bell size={20} />
                {unreadCount > 0 && (
                    <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white border-2 border-white">
                        {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                )}
            </button>

            {isOpen && (
                <div className="absolute right-0 mt-2 w-80 md:w-96 bg-white rounded-lg shadow-xl border border-gray-200 z-50 overflow-hidden animate-in fade-in zoom-in duration-100 origin-top-right">
                    <div className="p-3 border-b border-gray-100 flex items-center justify-between bg-gray-50">
                        <h3 className="font-semibold text-gray-900">Notifications</h3>
                        {unreadCount > 0 && (
                            <button
                                onClick={handleMarkAllRead}
                                className="text-xs text-blue-600 hover:text-blue-800 font-medium hover:underline"
                            >
                                Mark all as read
                            </button>
                        )}
                    </div>

                    <div className="max-h-[400px] overflow-y-auto">
                        {notifications.length === 0 ? (
                            <div className="p-8 text-center text-gray-500">
                                <Bell size={32} className="mx-auto mb-2 opacity-20" />
                                <p className="text-sm">No notifications yet</p>
                            </div>
                        ) : (
                            <div className="divide-y divide-gray-100">
                                {notifications.map((notification) => (
                                    <div
                                        key={notification._id}
                                        onClick={() => handleNotificationClick(notification)}
                                        className={`p-4 hover:bg-gray-50 cursor-pointer transition-colors relative ${!notification.isRead ? "bg-blue-50/30" : ""
                                            }`}
                                    >
                                        <div className="flex gap-3">
                                            <div className={`mt-1 flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${getIconColor(notification.type)}`}>
                                                <Bell size={14} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex justify-between items-start">
                                                    <p className={`text-sm font-medium ${!notification.isRead ? "text-gray-900" : "text-gray-700"}`}>
                                                        {notification.title}
                                                    </p>
                                                    <div className="flex items-center gap-2 ml-2">
                                                        <span className="text-xs text-gray-400 whitespace-nowrap">
                                                            {new Date(notification.createdAt).toLocaleDateString(undefined, {
                                                                month: 'short',
                                                                day: 'numeric',
                                                                hour: '2-digit',
                                                                minute: '2-digit'
                                                            })}
                                                        </span>
                                                        {!notification.isRead && (
                                                            <span className="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0"></span>
                                                        )}
                                                    </div>
                                                </div>
                                                <p className="text-sm text-gray-500 mt-1 line-clamp-2">
                                                    {notification.message}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
