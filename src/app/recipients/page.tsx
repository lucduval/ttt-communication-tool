"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/../convex/_generated/api";
import { Header } from "@/components/layout";
import { Button, Card, Pagination, LoadingScreen } from "@/components/ui";
import {
    ContactFilters,
    buildODataFilter,
    type FilterState,
    LeadFilters,
    type LeadFilterState,
} from "@/components/filters";
import { ContactList, type Contact } from "@/components/recipients";
import { Plus, RefreshCw } from "lucide-react";

const ITEMS_PER_PAGE = 50;

type AudienceType = "clients" | "leads";

const INITIAL_LEAD_FILTERS: LeadFilterState = {
    search: "",
    status: "active",
    province: null,
    emailOptIn: null,
    whatsappOptIn: null,
    ownerId: null,
    industryId: null,
};

export default function RecipientsPage() {
    const currentUser = useQuery(api.users.getCurrentUser);

    // Determine if this user is locked to their own consultant scope
    const lockedConsultantId =
        currentUser && currentUser.role !== "admin" && currentUser.dynamicsUserId
            ? currentUser.dynamicsUserId
            : undefined;

    const INITIAL_FILTERS: FilterState = {
        search: "",
        clientType: null,
        entityType: null,
        marketingType: "all",
        whatsappOptIn: null,
        emailEnabled: null,
        bank: null,
        sourceCode: [],
        province: null,
        ageMin: null,
        ageMax: null,
        ownerId: lockedConsultantId ?? null,
        industryId: null,
        incomeMin: null,
        incomeMax: null,
        retirementFundMin: null,
        retirementFundMax: null,
        taxReturnMin: null,
        taxReturnYear: null,
        personalisedCampaignFilter: "all",
        badDebtFilter: "all",
    };

    const [audience, setAudience] = useState<AudienceType>("clients");
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
    const [leadFilters, setLeadFilters] = useState<LeadFilterState>({
        ...INITIAL_LEAD_FILTERS,
        ownerId: lockedConsultantId ?? null,
    });
    const [totalCount, setTotalCount] = useState<number | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [currentPage, setCurrentPage] = useState(1);

    // For bad debt mode: all results loaded at once (same as ITA34/TaxReturn pattern)
    const allBadDebtContactsRef = useRef<Contact[]>([]);

    // Derive contact IDs for the current page to look up personalised campaign history
    const visibleContactIds = useMemo(() => contacts.map((c) => c.id), [contacts]);
    const personalisedHistory = useQuery(
        api.personalisedHistory.getHistoryByContactIds,
        audience === "clients" && visibleContactIds.length > 0 ? { contactIds: visibleContactIds } : "skip"
    );

    // All distinct campaign names visible in the current page's history (for the filter UI)
    const personalisedCampaignNames = useMemo(() => {
        if (!personalisedHistory) return [];
        const names = new Set<string>();
        for (const entries of Object.values(personalisedHistory)) {
            for (const e of entries) names.add(e.campaignName);
        }
        return [...names].sort();
    }, [personalisedHistory]);

    // Apply remaining client-side filter (personalised history only — bad debt is now server-side)
    const displayedContacts = useMemo(() => {
        let result = contacts;

        if (audience === "clients" && personalisedHistory && filters.personalisedCampaignFilter !== "all") {
            result = result.filter((c) => {
                const hasSent = (personalisedHistory[c.id]?.length ?? 0) > 0;
                return filters.personalisedCampaignFilter === "sent" ? hasSent : !hasSent;
            });
        }

        return result;
    }, [contacts, personalisedHistory, filters.personalisedCampaignFilter, audience]);

    // When the locked consultant ID resolves (after currentUser loads), seed the filter
    useEffect(() => {
        if (lockedConsultantId && filters.ownerId !== lockedConsultantId) {
            setFilters((prev) => ({ ...prev, ownerId: lockedConsultantId }));
        }
        if (lockedConsultantId && leadFilters.ownerId !== lockedConsultantId) {
            setLeadFilters((prev) => ({ ...prev, ownerId: lockedConsultantId }));
        }
    }, [lockedConsultantId]);

    const fetchContacts = useAction(api.actions.dynamics.fetchContacts);
    const getContactCount = useAction(api.actions.dynamics.getContactCount);
    const fetchLeads = useAction(api.actions.dynamics.fetchLeads);
    const getLeadCount = useAction(api.actions.dynamics.getLeadCount);
    const fetchContactsByBadDebt = useAction(api.actions.dynamics.fetchContactsByBadDebt);

    // Stabilise action refs so useCallback doesn't churn on every render
    const fetchContactsRef = useRef(fetchContacts);
    const getContactCountRef = useRef(getContactCount);
    const fetchLeadsRef = useRef(fetchLeads);
    const getLeadCountRef = useRef(getLeadCount);
    const fetchContactsByBadDebtRef = useRef(fetchContactsByBadDebt);
    useEffect(() => { fetchContactsRef.current = fetchContacts; });
    useEffect(() => { getContactCountRef.current = getContactCount; });
    useEffect(() => { fetchLeadsRef.current = fetchLeads; });
    useEffect(() => { getLeadCountRef.current = getLeadCount; });
    useEffect(() => { fetchContactsByBadDebtRef.current = fetchContactsByBadDebt; });

    const hasBadDebtFilter = filters.badDebtFilter === "has_debt";

    const totalPages = totalCount ? Math.ceil(totalCount / ITEMS_PER_PAGE) : 1;

    const loadContacts = useCallback(async (page: number = 1) => {
        console.log("[loadContacts] called", {
            audience,
            hasBadDebtFilter,
            badDebtFilterValue: filters.badDebtFilter,
            page,
        });
        try {
            setIsLoading(true);
            setError(null);

            if (audience === "leads") {
                const skip = (page - 1) * ITEMS_PER_PAGE;

                const [leadsResult, countResult] = await Promise.all([
                    fetchLeadsRef.current({
                        search: leadFilters.search || undefined,
                        top: ITEMS_PER_PAGE,
                        skip: skip > 0 ? skip : undefined,
                        province: leadFilters.province || undefined,
                        emailOptIn: leadFilters.emailOptIn ?? undefined,
                        whatsappOptIn: leadFilters.whatsappOptIn ?? undefined,
                        ownerId: leadFilters.ownerId || undefined,
                        status: leadFilters.status,
                        industryId: leadFilters.industryId || undefined,
                    }),
                    getLeadCountRef.current({
                        search: leadFilters.search || undefined,
                        province: leadFilters.province || undefined,
                        emailOptIn: leadFilters.emailOptIn ?? undefined,
                        whatsappOptIn: leadFilters.whatsappOptIn ?? undefined,
                        ownerId: leadFilters.ownerId || undefined,
                        status: leadFilters.status,
                        industryId: leadFilters.industryId || undefined,
                    }),
                ]);

                setContacts(leadsResult.contacts as Contact[]);
                setTotalCount(countResult.count);
                setCurrentPage(page);
            } else if (hasBadDebtFilter) {
                console.log("[loadContacts] → BAD DEBT branch entered");
                const odataFilter = buildODataFilter(filters);
                console.log("[loadContacts] calling fetchContactsByBadDebt with odataFilter:", odataFilter);
                const result = await fetchContactsByBadDebtRef.current({
                    filter: odataFilter,
                    search: filters.search || undefined,
                    clientType: filters.clientType || undefined,
                    entityType: filters.entityType ?? undefined,
                    bank: filters.bank ?? undefined,
                    sourceCode: filters.sourceCode.length > 0 ? filters.sourceCode : undefined,
                    province: filters.province || undefined,
                    ageMin: filters.ageMin ?? undefined,
                    ageMax: filters.ageMax ?? undefined,
                    ownerId: filters.ownerId || undefined,
                    industryId: filters.industryId || undefined,
                });
                console.log("[loadContacts] fetchContactsByBadDebt returned:", {
                    totalCount: result.totalCount,
                    contactsSample: result.contacts.slice(0, 3),
                });
                const allContacts = result.contacts as Contact[];
                allBadDebtContactsRef.current = allContacts;
                setTotalCount(result.totalCount);

                // Client-side pagination slice
                const start = (page - 1) * ITEMS_PER_PAGE;
                setContacts(allContacts.slice(start, start + ITEMS_PER_PAGE));
                setCurrentPage(page);
            } else {
                const odataFilter = buildODataFilter(filters);
                const skip = (page - 1) * ITEMS_PER_PAGE;

                const [contactsResult, countResult] = await Promise.all([
                    fetchContactsRef.current({
                        filter: odataFilter,
                        search: filters.search || undefined,
                        top: ITEMS_PER_PAGE,
                        skip: skip > 0 ? skip : undefined,
                        clientType: filters.clientType || undefined,
                        entityType: filters.entityType ?? undefined,
                        bank: filters.bank ?? undefined,
                        sourceCode: filters.sourceCode.length > 0 ? filters.sourceCode : undefined,
                        province: filters.province || undefined,
                        ageMin: filters.ageMin ?? undefined,
                        ageMax: filters.ageMax ?? undefined,
                        ownerId: filters.ownerId || undefined,
                        industryId: filters.industryId || undefined,
                    }),
                    getContactCountRef.current({
                        filter: odataFilter,
                        search: filters.search || undefined,
                        clientType: filters.clientType || undefined,
                        entityType: filters.entityType ?? undefined,
                        bank: filters.bank ?? undefined,
                        sourceCode: filters.sourceCode.length > 0 ? filters.sourceCode : undefined,
                        province: filters.province || undefined,
                        ageMin: filters.ageMin ?? undefined,
                        ageMax: filters.ageMax ?? undefined,
                        ownerId: filters.ownerId || undefined,
                        industryId: filters.industryId || undefined,
                    }),
                ]);

                setContacts(contactsResult.contacts as Contact[]);
                setTotalCount(countResult.count);
                setCurrentPage(page);
            }
        } catch (err) {
            console.error("Failed to fetch contacts:", err);
            setError(
                err instanceof Error ? err.message : "Failed to load contacts"
            );
        } finally {
            setIsLoading(false);
        }
    // Actions are accessed via stable refs — only re-create when filter values change
    }, [filters, leadFilters, audience, hasBadDebtFilter]);

    const handlePageChange = (page: number) => {
        // For bad debt mode, paginate client-side from the cached full set
        if (hasBadDebtFilter && allBadDebtContactsRef.current.length > 0) {
            const start = (page - 1) * ITEMS_PER_PAGE;
            setContacts(allBadDebtContactsRef.current.slice(start, start + ITEMS_PER_PAGE));
            setCurrentPage(page);
            window.scrollTo({ top: 0, behavior: "smooth" });
            return;
        }
        loadContacts(page);
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    // When filters change, reset to page 1
    useEffect(() => {
        const timer = setTimeout(() => {
            loadContacts(1);
        }, 300);
        return () => clearTimeout(timer);
    }, [filters, leadFilters, audience, loadContacts]);

    const hasClientSideFilter = filters.personalisedCampaignFilter !== "all";

    return (
        <>
            <Header title="CRM Recipients" />
            <section className="flex-1 overflow-y-auto p-8">
                <div className="space-y-6">
                    {/* Header */}
                    <div className="flex justify-between items-center">
                        <div>
                            <h1 className="text-2xl font-bold text-gray-900">
                                {audience === "leads" ? "Dynamics 365 Leads" : "Dynamics 365 Contacts"}
                            </h1>
                            <p className="text-gray-500">
                                {audience === "leads"
                                    ? "Browse and filter leads for your communication campaigns."
                                    : "Browse and filter contacts for your communication campaigns."}
                            </p>
                        </div>
                        <div className="flex gap-2">
                            <Button
                                variant="secondary"
                                onClick={() => loadContacts(currentPage)}
                                disabled={isLoading}
                            >
                                <RefreshCw
                                    size={16}
                                    className={isLoading ? "animate-spin" : ""}
                                />
                                Refresh
                            </Button>
                            {selectedIds.size > 0 && (
                                <Button>
                                    <Plus size={16} />
                                    Create Campaign ({selectedIds.size})
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Audience Toggle */}
                    <div className="bg-gray-50 p-1 rounded-lg inline-flex">
                        <button
                            onClick={() => {
                                setAudience("clients");
                                setFilters((prev) => ({ ...prev }));
                                setSelectedIds(new Set());
                                setContacts([]);
                            }}
                            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                                audience === "clients"
                                    ? "bg-white text-[#1E3A5F] shadow-sm"
                                    : "text-gray-500 hover:text-gray-700"
                            }`}
                        >
                            Clients
                        </button>
                        <button
                            onClick={() => {
                                setAudience("leads");
                                setLeadFilters({
                                    ...INITIAL_LEAD_FILTERS,
                                    ownerId: lockedConsultantId ?? null,
                                });
                                setSelectedIds(new Set());
                                setContacts([]);
                            }}
                            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                                audience === "leads"
                                    ? "bg-white text-[#1E3A5F] shadow-sm"
                                    : "text-gray-500 hover:text-gray-700"
                            }`}
                        >
                            Leads
                        </button>
                    </div>

                    {/* Error State */}
                    {error && (
                        <Card className="border-red-200 bg-red-50">
                            <div className="text-red-700">
                                <p className="font-semibold">Error loading {audience === "leads" ? "leads" : "contacts"}</p>
                                <p className="text-sm mt-1">{error}</p>
                                <Button
                                    variant="secondary"
                                    className="mt-3"
                                    onClick={() => loadContacts(currentPage)}
                                >
                                    Try Again
                                </Button>
                            </div>
                        </Card>
                    )}

                    {/* Filters */}
                    <Card>
                        {audience === "clients" && (
                            <ContactFilters
                                filters={filters}
                                onFiltersChange={setFilters}
                                totalCount={
                                    hasClientSideFilter
                                        ? displayedContacts.length
                                        : totalCount
                                }
                                lockedConsultantId={lockedConsultantId}
                                personalisedCampaignNames={personalisedCampaignNames}
                            />
                        )}
                        {audience === "leads" && (
                            <LeadFilters
                                filters={leadFilters}
                                onFiltersChange={setLeadFilters}
                                totalCount={totalCount}
                                lockedConsultantId={lockedConsultantId}
                            />
                        )}
                    </Card>

                    {/* Loading State */}
                    {isLoading && <LoadingScreen />}

                    {/* Contact List */}
                    {!isLoading && (
                        <ContactList
                            contacts={displayedContacts}
                            isLoading={false}
                            selectedIds={selectedIds}
                            onSelectionChange={setSelectedIds}
                            showSelection={true}
                            personalisedHistory={audience === "clients" ? (personalisedHistory ?? {}) : undefined}
                        />
                    )}

                    {/* Pagination */}
                    {totalCount !== null && totalCount > 0 && (
                        <Card>
                            <Pagination
                                currentPage={currentPage}
                                totalPages={totalPages}
                                totalItems={totalCount}
                                itemsPerPage={ITEMS_PER_PAGE}
                                onPageChange={handlePageChange}
                                isLoading={isLoading}
                            />
                        </Card>
                    )}

                    {/* Selected count indicator */}
                    {selectedIds.size > 0 && (
                        <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 bg-[#1E3A5F] text-white px-6 py-3 rounded-full shadow-lg flex items-center gap-3">
                            <span className="font-medium">{selectedIds.size} {audience === "leads" ? "leads" : "contacts"} selected</span>
                            <Button
                                variant="secondary"
                                className="!bg-white !text-[#1E3A5F] !py-1 !px-3"
                                onClick={() => setSelectedIds(new Set())}
                            >
                                Clear
                            </Button>
                        </div>
                    )}
                </div>
            </section>
        </>
    );
}

