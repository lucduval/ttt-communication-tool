"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import Link from "next/link";
import { format } from "date-fns";
import { Button } from "@/components/ui/Button";

export default function CampaignsPage() {
    const campaigns = useQuery(api.campaigns.list);

    return (
        <div className="container mx-auto py-8 px-8">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-2xl font-bold">Campaigns</h1>
                <Link href="/campaigns/new">
                    <Button>New Campaign</Button>
                </Link>
            </div>

            <div className="bg-white shadow-md rounded-lg overflow-hidden overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Name
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Channel
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Status
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Progress
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Created At
                            </th>
                            <th className="px-6 py-3 relative">
                                <span className="sr-only">View</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {!campaigns ? (
                            <tr>
                                <td colSpan={6} className="px-6 py-4 text-center">
                                    Loading...
                                </td>
                            </tr>
                        ) : campaigns.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="px-6 py-4 text-center">
                                    No campaigns found.
                                </td>
                            </tr>
                        ) : (
                            campaigns.map((campaign) => (
                                <tr key={campaign._id} className="hover:bg-gray-50">
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <div className="text-sm font-medium text-gray-900">
                                            {campaign.name}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 text-blue-800 capitalize">
                                            {campaign.channel}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <span
                                            className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full capitalize ${campaign.status === "completed"
                                                ? "bg-green-100 text-green-800"
                                                : campaign.status === "failed"
                                                    ? "bg-red-100 text-red-800"
                                                    : campaign.status === "processing"
                                                        ? "bg-yellow-100 text-yellow-800"
                                                        : "bg-gray-100 text-gray-800"
                                                }`}
                                        >
                                            {campaign.status}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                        <div className="flex flex-col space-y-1">
                                            <div className="flex justify-between text-xs">
                                                <span className="text-green-600">
                                                    {campaign.deliveredCount} Del
                                                </span>
                                                <span className="text-red-600">
                                                    {campaign.failedCount} Fail
                                                </span>
                                            </div>
                                            <div className="w-full bg-gray-200 rounded-full h-1.5">
                                                <div
                                                    className="bg-green-600 h-1.5 rounded-full"
                                                    style={{
                                                        width: `${campaign.totalRecipients > 0
                                                            ? (campaign.deliveredCount /
                                                                campaign.totalRecipients) *
                                                            100
                                                            : 0
                                                            }%`,
                                                    }}
                                                ></div>
                                            </div>
                                            <div className="text-xs text-gray-400">
                                                {campaign.totalRecipients} Total
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                        {format(new Date(campaign._creationTime), "MMM d, yyyy HH:mm")}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                        <Link
                                            href={`/campaigns/${campaign._id}`}
                                            className="text-indigo-600 hover:text-indigo-900"
                                        >
                                            View
                                        </Link>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
