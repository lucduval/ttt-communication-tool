"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card_shadcn";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/Button";
import { AlertCircle, Eye } from "lucide-react";
import { format } from "date-fns";

export function BouncedEmailsCard({ campaignId }: { campaignId: Id<"campaigns"> }) {
    const failedMessages = useQuery(api.messages.getFailedMessages, { campaignId });
    const stats = useQuery(api.messages.getCampaignStats, { campaignId });

    // We can use stats for the instant count, and failedMessages for the details
    const failedCount = stats?.failed || 0;

    if (failedMessages === undefined) {
        return (
            <Card className="bg-red-50 border-red-200">
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-red-800 uppercase tracking-wider">
                        Bounced / Failed
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold text-red-900">...</div>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="bg-red-50 border-red-200">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-red-800 uppercase tracking-wider flex justify-between items-center">
                    <span>Bounced / Failed</span>
                    <AlertCircle className="w-4 h-4 text-red-600" />
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div className="flex justify-between items-end">
                    <div className="text-2xl font-bold text-red-900">{failedCount}</div>

                    {failedCount > 0 && (
                        <Dialog>
                            <DialogTrigger asChild>
                                <Button variant="ghost" className="text-red-700 hover:text-red-900 hover:bg-red-100 h-8 px-2 text-xs">
                                    <Eye className="w-3 h-3 mr-1" />
                                    View List
                                </Button>
                            </DialogTrigger>
                            <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
                                <DialogHeader>
                                    <DialogTitle>Bounced / Failed Emails</DialogTitle>
                                    <DialogDescription>
                                        List of emails that could not be delivered for this campaign.
                                    </DialogDescription>
                                </DialogHeader>

                                <div className="mt-4 flex-1 overflow-auto border rounded-md">
                                    <table className="w-full text-sm text-left">
                                        <thead className="bg-gray-50 text-gray-500 font-medium border-b sticky top-0">
                                            <tr>
                                                <th className="px-4 py-2">Recipient</th>
                                                <th className="px-4 py-2">Email</th>
                                                <th className="px-4 py-2">Reason</th>
                                                <th className="px-4 py-2">Time</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {failedMessages.length === 0 ? (
                                                <tr>
                                                    <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                                                        No details available.
                                                    </td>
                                                </tr>
                                            ) : (
                                                failedMessages.map((msg) => (
                                                    <tr key={msg._id} className="hover:bg-gray-50">
                                                        <td className="px-4 py-2 font-medium">{msg.recipientName}</td>
                                                        <td className="px-4 py-2">{msg.recipientEmail}</td>
                                                        <td className="px-4 py-2 text-red-600 break-words max-w-xs block">
                                                            {msg.errorMessage || "Unknown error"}
                                                        </td>
                                                        <td className="px-4 py-2 text-gray-500 whitespace-nowrap">
                                                            {msg.sentAt
                                                                ? format(new Date(msg.sentAt), "MMM d, HH:mm")
                                                                : "-"}
                                                        </td>
                                                    </tr>
                                                ))
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </DialogContent>
                        </Dialog>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
