"use client";

import { useState, useEffect, useCallback } from "react";
import { useAction } from "convex/react";
import { api } from "@/../convex/_generated/api";
import { Header } from "@/components/layout";
import { Button, Card, Pagination } from "@/components/ui";
import {
    ContactFilters,
    buildODataFilter,
    type FilterState,
} from "@/components/filters";
import { ContactList, type Contact } from "@/components/recipients";
import { Plus, RefreshCw } from "lucide-react";

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
    ownerId: null,
    industryId: null,
};

const ITEMS_PER_PAGE = 50;

export default function RecipientsPage() {
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
    const [totalCount, setTotalCount] = useState<number | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [currentPage, setCurrentPage] = useState(1);

    const fetchContacts = useAction(api.actions.dynamics.fetchContacts);
    const getContactCount = useAction(api.actions.dynamics.getContactCount);

    const totalPages = totalCount ? Math.ceil(totalCount / ITEMS_PER_PAGE) : 1;

    const loadContacts = useCallback(async (page: number = 1) => {
        try {
            setIsLoading(true);
            setError(null);

            const odataFilter = buildODataFilter(filters);
            const skip = (page - 1) * ITEMS_PER_PAGE;

            const [contactsResult, countResult] = await Promise.all([
                fetchContacts({
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
                getContactCount({
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
        } catch (err) {
            console.error("Failed to fetch contacts:", err);
            setError(
                err instanceof Error ? err.message : "Failed to load contacts"
            );
        } finally {
            setIsLoading(false);
        }
    }, [fetchContacts, getContactCount, filters]);

    const handlePageChange = (page: number) => {
        loadContacts(page);
        // Scroll to top of list
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    // When filters change, reset to page 1
    useEffect(() => {
        const timer = setTimeout(() => {
            loadContacts(1);
        }, 300);
        return () => clearTimeout(timer);
    }, [filters, loadContacts]);

    return (
        <>
            <Header title="CRM Recipients" />
            <section className="flex-1 overflow-y-auto p-8">
                <div className="space-y-6">
                    {/* Header */}
                    <div className="flex justify-between items-center">
                        <div>
                            <h1 className="text-2xl font-bold text-gray-900">
                                Dynamics 365 Contacts
                            </h1>
                            <p className="text-gray-500">
                                Browse and filter contacts for your communication campaigns.
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

                    {/* Error State */}
                    {error && (
                        <Card className="border-red-200 bg-red-50">
                            <div className="text-red-700">
                                <p className="font-semibold">Error loading contacts</p>
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
                        <ContactFilters
                            filters={filters}
                            onFiltersChange={setFilters}
                            totalCount={totalCount}
                        />
                    </Card>

                    {/* Contact List */}
                    <ContactList
                        contacts={contacts}
                        isLoading={isLoading && contacts.length === 0}
                        selectedIds={selectedIds}
                        onSelectionChange={setSelectedIds}
                        showSelection={true}
                    />

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
                            <span className="font-medium">{selectedIds.size} contacts selected</span>
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
