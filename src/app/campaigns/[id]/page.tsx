"use client";

import { useState } from "react";

import { useQuery, usePaginatedQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useParams } from "next/navigation";
import { format } from "date-fns";
import { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import Link from "next/link";
import { ArrowLeft, Loader2, Pause } from "lucide-react";
import { BouncedEmailsCard } from "@/components/campaigns/BouncedEmailsCard";

export default function CampaignDetailsPage() {
    const params = useParams();
    const campaignId = params.id as Id<"campaigns">;
    const [statusFilter, setStatusFilter] = useState<string>("all");

    const campaign = useQuery(api.campaigns.get, { id: campaignId });
    const pauseCampaign = useMutation(api.campaigns.pauseCampaign);
    const isEngagementFilter = statusFilter === "opened" || statusFilter === "clicked";
    const { results: paginatedMessages, status: messagesStatus, loadMore } = usePaginatedQuery(
        api.messages.listByCampaign,
        { campaignId, status: isEngagementFilter || statusFilter === "all" ? undefined : statusFilter },
        { initialNumItems: 100 }
    );
    const engagementMessages = useQuery(
        api.messages.listByEngagement,
        isEngagementFilter
            ? { campaignId, engagement: statusFilter as "opened" | "clicked" }
            : "skip"
    );
    const batches = useQuery(api.campaignBatches.getBatches, { campaignId });
    const stats = useQuery(api.messages.getCampaignStats, { campaignId });
    const engagement = useQuery(api.messages.getEngagementRecipients, { campaignId });
    const opportunityMessages = useQuery(api.messages.listOpportunityMessages, { campaignId });

    if (!campaign || messagesStatus === "LoadingFirstPage") {
        return <div className="p-8 text-center">Loading...</div>;
    }

    const messages = isEngagementFilter ? (engagementMessages ?? []) : paginatedMessages;

    const isProcessing = campaign.status === "processing" || campaign.status === "queued";
    const canPause = campaign.status === "processing" || campaign.status === "queued";
    const completedBatches = batches?.filter((b) => b.status === "completed").length || 0;
    const totalBatches = campaign.totalBatches || batches?.length || 1;
    const progressPercent = totalBatches > 0 ? Math.round((completedBatches / totalBatches) * 100) : 0;

    // Estimate time remaining based on average batch time
    const completedBatchData = batches?.filter((b) => b.status === "completed" && b.startedAt && b.completedAt) || [];
    let estimatedTimeRemaining = "";
    if (completedBatchData.length > 0 && isProcessing) {
        const avgBatchTime = completedBatchData.reduce((acc, b) => acc + ((b.completedAt || 0) - (b.startedAt || 0)), 0) / completedBatchData.length;
        const remainingBatches = totalBatches - completedBatches;
        const remainingMs = avgBatchTime * remainingBatches;
        const remainingMins = Math.ceil(remainingMs / 60000);
        estimatedTimeRemaining = remainingMins > 1 ? `~${remainingMins} min remaining` : "Almost done...";
    }

    const opportunityMap = new Map(
        (opportunityMessages ?? []).map((m) => [m.recipientId, m.opportunityId])
    );

    const openedIdSet = new Set(engagement?.openedIds ?? []);
    const clickedIdSet = new Set(engagement?.clickedIds ?? []);

    // "opened"/"clicked" are served directly by listByEngagement (server-side join).
    // All other filters are applied server-side via the paginated query.
    const filteredMessages = messages;

    const hasEngagementData = campaign.channel === "email" &&
        (campaign.opensCount !== undefined || campaign.clicksCount !== undefined);
    const hasOpportunities = (opportunityMessages ?? []).length > 0;

    const getTemperatureLabel = (recipientId: string): { label: string; classes: string } | null => {
        if (!opportunityMap.has(recipientId)) return null;
        if (clickedIdSet.has(recipientId)) return { label: "Hot", classes: "bg-red-100 text-red-700" };
        if (openedIdSet.has(recipientId)) return { label: "Warm", classes: "bg-orange-100 text-orange-700" };
        return { label: "Pending", classes: "bg-gray-100 text-gray-600" };
    };

    return (
        <div className="container mx-auto py-8 px-8">
            <div className="mb-6">
                <Link
                    href="/campaigns"
                    className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 mb-4"
                >
                    <ArrowLeft className="w-4 h-4 mr-1" />
                    Back to Campaigns
                </Link>
                <div className="flex justify-between items-start">
                    <div>
                        <h1 className="text-3xl font-bold mb-2">{campaign.name}</h1>
                        <div className="flex items-center space-x-4 text-sm text-gray-500">
                            <span className="capitalize bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full font-medium">
                                {campaign.channel}
                            </span>
                            <span
                                className={`capitalize px-2 py-0.5 rounded-full font-medium flex items-center gap-1 ${campaign.status === "completed"
                                    ? "bg-green-100 text-green-800"
                                    : campaign.status === "failed"
                                        ? "bg-red-100 text-red-800"
                                        : campaign.status === "paused"
                                            ? "bg-amber-100 text-amber-800"
                                            : campaign.status === "processing" || campaign.status === "queued"
                                                ? "bg-yellow-100 text-yellow-800"
                                                : "bg-gray-100 text-gray-800"
                                    }`}
                            >
                                {isProcessing && <Loader2 className="w-3 h-3 animate-spin" />}
                                {campaign.status}
                            </span>
                            <span>
                                Created:{" "}
                                {format(new Date(campaign._creationTime), "MMM d, yyyy HH:mm")}
                            </span>
                            {campaign.scheduledAt && (
                                <span>
                                    Scheduled:{" "}
                                    {format(new Date(campaign.scheduledAt), "MMM d, yyyy HH:mm")}
                                </span>
                            )}
                        </div>
                    </div>
                    {canPause && (
                        <Button
                            variant="secondary"
                            className="bg-amber-100 text-amber-800 hover:bg-amber-200 border-amber-300"
                            onClick={async () => {
                                if (confirm("Pause this campaign? Pending batches will not be sent. The current batch will finish.")) {
                                    await pauseCampaign({ campaignId });
                                }
                            }}
                        >
                            <Pause className="w-4 h-4 mr-2" />
                            Pause Campaign
                        </Button>
                    )}
                </div>
            </div>

            {/* Batch Progress (shown when processing) */}
            {isProcessing && totalBatches > 1 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                            <span className="font-medium text-blue-800">
                                Processing batch {Math.min(completedBatches + 1, totalBatches)} of {totalBatches}
                            </span>
                        </div>
                        {estimatedTimeRemaining && (
                            <span className="text-sm text-blue-600">{estimatedTimeRemaining}</span>
                        )}
                    </div>
                    <div className="w-full bg-blue-200 rounded-full h-2">
                        <div
                            className="bg-blue-600 h-2 rounded-full transition-all duration-500"
                            style={{ width: `${progressPercent}%` }}
                        />
                    </div>
                    <div className="mt-2 text-sm text-blue-600">
                        {stats?.sent || 0} sent, {stats?.failed || 0} failed of {campaign.totalRecipients} total
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                <StatCard
                    label="Total Recipients"
                    value={campaign.totalRecipients}
                    color="bg-gray-50 border-gray-200"
                />
                <StatCard
                    label="Sent"
                    value={stats?.sent || campaign.sentCount}
                    color="bg-blue-50 border-blue-200"
                />
                <StatCard
                    label="Delivered"
                    value={stats?.delivered || campaign.deliveredCount}
                    color="bg-green-50 border-green-200"
                />
                <BouncedEmailsCard campaignId={campaign._id} />
                {(campaign.opensCount !== undefined || campaign.clicksCount !== undefined) && (
                    <>
                        <StatCard
                            label="Opens"
                            value={campaign.opensCount || 0}
                            color="bg-purple-50 border-purple-200"
                        />
                        <StatCard
                            label="Clicks"
                            value={campaign.clicksCount || 0}
                            color="bg-indigo-50 border-indigo-200"
                        />
                    </>
                )}
            </div>

            <div className="bg-white shadow-md rounded-lg overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
                    <h2 className="text-lg font-semibold">Messages</h2>
                    <div className="flex space-x-2">
                        <FilterButton
                            active={statusFilter === "all"}
                            onClick={() => setStatusFilter("all")}
                            label="All"
                        />
                        <FilterButton
                            active={statusFilter === "sent"}
                            onClick={() => setStatusFilter("sent")}
                            label="Sent"
                            count={stats?.sent}
                        />
                        <FilterButton
                            active={statusFilter === "delivered"}
                            onClick={() => setStatusFilter("delivered")}
                            label="Delivered"
                            count={stats?.delivered}
                        />
                        <FilterButton
                            active={statusFilter === "failed"}
                            onClick={() => setStatusFilter("failed")}
                            label="Failed"
                            count={stats?.failed}
                            variant="danger"
                        />
                        {hasEngagementData && (
                            <>
                                <div className="w-px bg-gray-200 mx-1" />
                                <FilterButton
                                    active={statusFilter === "opened"}
                                    onClick={() => setStatusFilter("opened")}
                                    label="Opened"
                                    count={engagement?.openedIds.length}
                                    variant="purple"
                                />
                                <FilterButton
                                    active={statusFilter === "clicked"}
                                    onClick={() => setStatusFilter("clicked")}
                                    label="Clicked"
                                    count={engagement?.clickedIds.length}
                                    variant="indigo"
                                />
                            </>
                        )}
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Recipient
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Contact
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Status
                                </th>
                                {hasOpportunities && (
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Opportunity Temp.
                                    </th>
                                )}
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Details
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Sent At
                                </th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {filteredMessages.length === 0 ? (
                                <tr>
                                    <td colSpan={hasOpportunities ? 6 : 5} className="px-6 py-4 text-center text-gray-500">
                                        No messages found matching filter.
                                    </td>
                                </tr>
                            ) : (
                                filteredMessages.map((message) => {
                                    const temp = getTemperatureLabel(message.recipientId);
                                    return (
                                        <tr key={message._id} className="hover:bg-gray-50">
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="text-sm font-medium text-gray-900">
                                                    {message.recipientName}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                                {message.channel === "email"
                                                    ? message.recipientEmail
                                                    : message.recipientPhone}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <span
                                                    className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full capitalize ${message.status === "delivered"
                                                        ? "bg-green-100 text-green-800"
                                                        : message.status === "failed"
                                                            ? "bg-red-100 text-red-800"
                                                            : message.status === "sent"
                                                                ? "bg-blue-100 text-blue-800"
                                                                : "bg-gray-100 text-gray-800"
                                                        }`}
                                                >
                                                    {message.status}
                                                </span>
                                            </td>
                                            {hasOpportunities && (
                                                <td className="px-6 py-4 whitespace-nowrap">
                                                    {temp ? (
                                                        <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${temp.classes}`}>
                                                            {temp.label}
                                                        </span>
                                                    ) : (
                                                        <span className="text-gray-300 text-xs">—</span>
                                                    )}
                                                </td>
                                            )}
                                            <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">
                                                {message.errorMessage ? (
                                                    <span className="text-red-600" title={message.errorMessage}>
                                                        Error: {message.errorMessage}
                                                    </span>
                                                ) : (
                                                    <span className="text-gray-400">-</span>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                                {message.sentAt
                                                    ? format(new Date(message.sentAt), "MMM d, HH:mm:ss")
                                                    : "-"}
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
                {!isEngagementFilter && messagesStatus === "CanLoadMore" && (
                    <div className="px-6 py-4 border-t border-gray-200 text-center">
                        <Button
                            onClick={() => loadMore(100)}
                            variant="secondary"
                            className="text-sm"
                        >
                            Load more ({paginatedMessages.length} loaded so far)
                        </Button>
                    </div>
                )}
                {!isEngagementFilter && messagesStatus === "LoadingMore" && (
                    <div className="px-6 py-4 border-t border-gray-200 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading more...
                    </div>
                )}
                {isEngagementFilter && engagementMessages === undefined && (
                    <div className="px-6 py-4 border-t border-gray-200 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading...
                    </div>
                )}
            </div>
        </div>
    );
}

function StatCard({
    label,
    value,
    color,
}: {
    label: string;
    value: number;
    color: string;
}) {
    return (
        <div className={`p-4 rounded-lg border ${color}`}>
            <div className="text-sm font-medium text-gray-500 uppercase tracking-wider mb-1">
                {label}
            </div>
            <div className="text-2xl font-bold">{value}</div>
        </div>
    );
}

function FilterButton({
    active,
    onClick,
    label,
    count,
    variant = "default"
}: {
    active: boolean;
    onClick: () => void;
    label: string;
    count?: number;
    variant?: "default" | "danger" | "purple" | "indigo";
}) {
    const baseClasses = "px-3 py-1.5 text-sm font-medium rounded-md transition-colors";
    const activeClasses =
        variant === "danger" ? "bg-red-100 text-red-800 border border-red-200" :
            variant === "purple" ? "bg-purple-100 text-purple-800 border border-purple-200" :
                variant === "indigo" ? "bg-indigo-100 text-indigo-800 border border-indigo-200" :
                    "bg-blue-100 text-blue-800 border border-blue-200";
    const inactiveClasses = "text-gray-600 hover:bg-gray-100 border border-transparent";

    return (
        <button
            onClick={onClick}
            className={`${baseClasses} ${active ? activeClasses : inactiveClasses}`}
        >
            {label}
            {count !== undefined && <span className="ml-1.5 opacity-70 text-xs">({count})</span>}
        </button>
    );
}

