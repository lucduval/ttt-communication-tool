"use client";

import { Header } from "@/components/layout";
import { Button, Card, Badge } from "@/components/ui";
import { ArrowUpRight, ArrowDownRight, Mail, MessageSquare, Plus, Users, Send } from "lucide-react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";



export default function DashboardPage() {
  const data = useQuery(api.dashboard.getDashboardStats);

  const stats = [
    {
      label: "Sent this Month",
      value: data ? data.sentThisMonth.toLocaleString() : "...",
      trend: "+0%",
      isUp: true
    },
    {
      label: "Avg Delivery Rate",
      value: data ? `${data.avgDeliveryRate}%` : "...",
      trend: "—",
      isUp: true
    },
    {
      label: "Failed Messages",
      value: data ? data.totalFailedMessages.toLocaleString() : "...",
      trend: data ? data.totalFailedMessages.toString() : "0",
      isUp: data ? data.totalFailedMessages === 0 : true
    },
    {
      label: "Total Campaigns",
      value: data ? data.totalCampaigns.toLocaleString() : "...",
      trend: data ? data.totalCampaigns.toString() : "0",
      isUp: true
    },
  ];

  const maxDailySent = data?.trends.reduce((max, t) => Math.max(max, t.count), 0) || 1;

  return (
    <>
      <Header title="Dashboard" />
      <section className="flex-1 overflow-y-auto p-8">
        <div className="space-y-8">
          {/* Quick Action Header */}
          <div className="flex flex-col md:flex-row justify-between md:items-end gap-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                Welcome to TTT Connect
              </h1>
              <p className="text-gray-500">
                Here&apos;s what&apos;s happening with your communication campaigns
              </p>
            </div>
            <Link href="/campaigns/new">
              <Button>
                <Plus size={18} />
                New Campaign
              </Button>
            </Link>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {stats.map((s, idx) => (
              <Card key={idx} className="hover:shadow-md transition-shadow">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-sm text-gray-500 font-medium mb-1">
                      {s.label}
                    </p>
                    <p className="text-2xl font-bold text-[#1E3A5F]">
                      {s.value}
                    </p>
                  </div>
                  <div
                    className={`flex items-center text-xs font-bold px-2 py-1 rounded ${s.isUp
                      ? "text-green-600 bg-green-50"
                      : "text-red-600 bg-red-50"
                      }`}
                  >
                    {s.isUp ? (
                      <ArrowUpRight size={14} />
                    ) : (
                      <ArrowDownRight size={14} />
                    )}
                    {s.trend}
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Activity Chart Placeholder */}
            <Card
              className="lg:col-span-2"
              title="Delivery Trends"
              subtitle="Performance over the last 14 days"
            >
              <div className="h-64 w-full bg-white rounded flex items-end justify-between px-4 pb-2 pt-8 gap-2">
                {(!data || data.trends.every(t => t.count === 0)) ? (
                  <div className="w-full h-full flex items-center justify-center bg-gray-50 rounded">
                    <p className="text-gray-400">
                      No campaign data yet. Create your first campaign to see trends.
                    </p>
                  </div>
                ) : (
                  data.trends.map((day, i) => (
                    <div key={i} className="flex flex-col items-center flex-1 h-full justify-end group">
                      <div
                        className="w-full bg-blue-100 rounded-t hover:bg-blue-200 transition-colors relative"
                        style={{ height: `${(day.count / maxDailySent) * 100}%`, minHeight: '4px' }}
                      >
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-gray-800 text-white text-xs px-2 py-1 rounded pointer-events-none whitespace-nowrap">
                          {day.count} sent
                          <div className="text-[10px] opacity-75">{day.date}</div>
                        </div>
                      </div>
                      <div className="h-px bg-gray-100 w-full mt-1"></div>
                    </div>
                  ))
                )}
              </div>
            </Card>

            {/* Campaign History */}
            <Card title="Campaigns">
              <div className="space-y-4">
                {!data || data.recentCampaigns.length === 0 ? (
                  <div className="h-48 flex flex-col items-center justify-center text-gray-400">
                    <MessageSquare size={32} className="mb-2 opacity-50" />
                    <p className="text-sm">No campaigns yet</p>
                    <Link href="/campaigns/new">
                      <Button variant="ghost" className="mt-4 text-sm">
                        Create Campaign
                      </Button>
                    </Link>
                  </div>
                ) : (
                  <div className="space-y-3 max-h-80 overflow-y-auto">
                    {data.recentCampaigns.map((campaign) => (
                      <Link key={campaign._id} href={`/campaigns/${campaign._id}`} className="block">
                        <div className="flex items-center justify-between border border-gray-100 rounded-lg p-3 hover:bg-gray-50 transition-colors">
                          <div className="min-w-0 flex-1 mr-3">
                            <p className="text-sm font-medium text-gray-900 truncate">
                              {campaign.name}
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              <BagdeForStatus status={campaign.status} />
                              <span className="text-xs text-gray-400">
                                {campaign.channel === "email" ? "📧" : "💬"} {campaign.sentCount} sent
                                {campaign.failedCount > 0 && (
                                  <span className="text-red-500 ml-1">· {campaign.failedCount} failed</span>
                                )}
                              </span>
                            </div>
                          </div>
                          <div className="text-xs text-gray-400 whitespace-nowrap">
                            {new Date(campaign._creationTime).toLocaleDateString()}
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </div>

          {/* Quick Start Guide */}
          <Card title="Quick Start Guide" subtitle="Get started with TTT Connect">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-100">
                <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-lg flex items-center justify-center mb-3">
                  <Users size={20} />
                </div>
                <h4 className="font-bold text-sm mb-1">1. Choose Channel & Recipients</h4>
                <p className="text-xs text-gray-500">
                  Select Email or WhatsApp and filter your audience from Dynamics 365
                </p>
              </div>
              <div className="p-4 bg-green-50 rounded-lg border border-green-100">
                <div className="w-10 h-10 bg-green-100 text-green-600 rounded-lg flex items-center justify-center mb-3">
                  <Mail size={20} />
                </div>
                <h4 className="font-bold text-sm mb-1">2. Compose Your Message</h4>
                <p className="text-xs text-gray-500">
                  Write your email content or select a WhatsApp template
                </p>
              </div>
              <div className="p-4 bg-purple-50 rounded-lg border border-purple-100">
                <div className="w-10 h-10 bg-purple-100 text-purple-600 rounded-lg flex items-center justify-center mb-3">
                  <Send size={20} />
                </div>
                <h4 className="font-bold text-sm mb-1">3. Preview & Send</h4>
                <p className="text-xs text-gray-500">
                  Review your campaign summary and launch it
                </p>
              </div>
            </div>
          </Card>
        </div>
      </section>
    </>
  );
}

function BagdeForStatus({ status }: { status: string }) {
  switch (status) {
    case 'processing': return <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">Processing</Badge>;
    case 'queued': return <Badge className="bg-yellow-100 text-yellow-700 hover:bg-yellow-100">Queued</Badge>;
    case 'completed': return <Badge className="bg-green-100 text-green-700 hover:bg-green-100">Completed</Badge>;
    case 'failed': return <Badge className="bg-red-100 text-red-700">Failed</Badge>;
    default: return <Badge className="bg-gray-100 text-gray-700">{status}</Badge>;
  }
}

