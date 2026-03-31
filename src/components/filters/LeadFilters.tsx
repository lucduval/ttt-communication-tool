"use client";

import { useState, useEffect, useRef } from "react";
import { Button, Badge } from "@/components/ui";
import { Filter, X, Check, ChevronsUpDown } from "lucide-react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface LeadFilterState {
    search: string;
    status: "all" | "active" | "inactive";
    province: string | null;
    emailOptIn: boolean | null;
    whatsappOptIn: boolean | null;
    ownerId: string | null;
    industryId: string | null;
}

interface Option {
    value: string;
    label: string;
}

interface LeadFiltersProps {
    filters: LeadFilterState;
    onFiltersChange: (filters: LeadFilterState) => void;
    totalCount?: number | null;
    lockedConsultantId?: string;
}

export function LeadFilters({
    filters,
    onFiltersChange,
    totalCount,
    lockedConsultantId,
}: LeadFiltersProps) {
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [ownerOptions, setOwnerOptions] = useState<Option[]>([]);
    const [industryOptions, setIndustryOptions] = useState<Option[]>([]);

    const getOwnerOptions = useAction(api.actions.dynamics.fetchUsers);
    const getIndustryOptions = useAction(api.actions.dynamics.fetchIndustries);
    const getOwnerOptionsRef = useRef(getOwnerOptions);
    const getIndustryOptionsRef = useRef(getIndustryOptions);
    useEffect(() => { getOwnerOptionsRef.current = getOwnerOptions; });
    useEffect(() => { getIndustryOptionsRef.current = getIndustryOptions; });

    useEffect(() => {
        let cancelled = false;
        const fetchMetadata = async () => {
            try {
                const [owners, industries] = await Promise.all([
                    getOwnerOptionsRef.current({ includeDisabled: false }),
                    getIndustryOptionsRef.current({}),
                ]);
                if (cancelled) return;
                setOwnerOptions(owners.map((o: any) => ({ value: o.id, label: o.name })));
                setIndustryOptions(industries.map((i: any) => ({ value: i.id, label: i.name })));
            } catch (err) {
                console.error("Failed to fetch lead filter metadata:", err);
            }
        };
        fetchMetadata();
        return () => { cancelled = true; };
    }, []);

    const updateFilter = <K extends keyof LeadFilterState>(
        key: K,
        value: LeadFilterState[K]
    ) => {
        onFiltersChange({ ...filters, [key]: value });
    };

    const clearFilters = () => {
        onFiltersChange({
            search: "",
            status: "active",
            province: null,
            emailOptIn: null,
            whatsappOptIn: null,
            ownerId: lockedConsultantId ?? null,
            industryId: null,
        });
    };

    const hasActiveFilters =
        filters.search !== "" ||
        filters.status !== "active" ||
        filters.province !== null ||
        filters.emailOptIn !== null ||
        filters.whatsappOptIn !== null ||
        (filters.ownerId !== null && filters.ownerId !== lockedConsultantId) ||
        filters.industryId !== null;

    return (
        <div className="space-y-4">
            {/* Top bar: search + filter toggle + count */}
            <div className="flex flex-col md:flex-row gap-4">
                <div className="relative flex-1">
                    <input
                        type="text"
                        placeholder="Search leads by name or email..."
                        value={filters.search}
                        onChange={(e) => updateFilter("search", e.target.value)}
                        className="w-full bg-white border border-gray-200 px-4 py-2.5 rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10 pl-10"
                    />
                    <svg className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                </div>

                <div className="flex items-center gap-3">
                    <Button
                        variant={showAdvanced ? "primary" : "secondary"}
                        onClick={() => setShowAdvanced(!showAdvanced)}
                        className="text-sm"
                    >
                        <Filter size={16} />
                        Filters
                        {hasActiveFilters && (
                            <span className="ml-1 w-2 h-2 bg-blue-500 rounded-full" />
                        )}
                    </Button>

                    {totalCount !== null && totalCount !== undefined && (
                        <div className="text-sm font-medium text-[#1E3A5F]">
                            <span className="text-gray-500">Showing:</span>{" "}
                            <span className="font-bold">
                                {totalCount.toLocaleString()} leads
                            </span>
                        </div>
                    )}
                </div>
            </div>

            {/* Advanced Filters Panel */}
            {showAdvanced && (
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-100 space-y-4">
                    <div className="flex justify-between items-center">
                        <h4 className="font-semibold text-sm text-gray-700">
                            Filter Leads
                        </h4>
                        {hasActiveFilters && (
                            <button
                                onClick={clearFilters}
                                className="text-xs text-red-600 hover:text-red-700 flex items-center gap-1"
                            >
                                <X size={12} />
                                Clear all
                            </button>
                        )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {/* Status */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Status
                            </label>
                            <select
                                value={filters.status}
                                onChange={(e) =>
                                    updateFilter("status", e.target.value as LeadFilterState["status"])
                                }
                                className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                            >
                                <option value="all">All</option>
                                <option value="active">Active Only</option>
                                <option value="inactive">Inactive Only</option>
                            </select>
                        </div>

                        {/* Industry */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Industry
                            </label>
                            <select
                                value={filters.industryId || ""}
                                onChange={(e) =>
                                    updateFilter("industryId", e.target.value || null)
                                }
                                className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                            >
                                <option value="">All Industries</option>
                                {industryOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Province */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Province
                            </label>
                            <input
                                type="text"
                                placeholder="e.g. Gauteng"
                                value={filters.province ?? ""}
                                onChange={(e) =>
                                    updateFilter("province", e.target.value || null)
                                }
                                className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                            />
                        </div>

                        {/* Consultant / Owner */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Consultant
                            </label>
                            {lockedConsultantId ? (
                                <div className="w-full bg-gray-100 border border-gray-200 p-2 rounded text-sm text-gray-600">
                                    {ownerOptions.find(o => o.value === lockedConsultantId)?.label ?? "Your clients"}
                                </div>
                            ) : (
                                <LookupCombobox
                                    options={ownerOptions}
                                    value={filters.ownerId}
                                    onChange={(val) => updateFilter("ownerId", val)}
                                    placeholder="All consultants"
                                    searchPlaceholder="Search consultants..."
                                    emptyText="No consultant found."
                                />
                            )}
                        </div>

                        {/* Email Opt-In */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Email Opt-In
                            </label>
                            <select
                                value={filters.emailOptIn === null ? "" : filters.emailOptIn ? "true" : "false"}
                                onChange={(e) =>
                                    updateFilter("emailOptIn", e.target.value === "" ? null : e.target.value === "true")
                                }
                                className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                            >
                                <option value="">All</option>
                                <option value="true">Opted In</option>
                                <option value="false">Not Opted In</option>
                            </select>
                        </div>

                        {/* WhatsApp Opt-In */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                WhatsApp Opt-In
                            </label>
                            <select
                                value={filters.whatsappOptIn === null ? "" : filters.whatsappOptIn ? "true" : "false"}
                                onChange={(e) =>
                                    updateFilter("whatsappOptIn", e.target.value === "" ? null : e.target.value === "true")
                                }
                                className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                            >
                                <option value="">All</option>
                                <option value="true">Opted In</option>
                                <option value="false">Not Opted In</option>
                            </select>
                        </div>
                    </div>

                    {/* Active filter badges */}
                    {hasActiveFilters && (
                        <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
                            {filters.status !== "active" && (
                                <Badge status="info">
                                    Status: {filters.status === "all" ? "All" : "Inactive"}
                                </Badge>
                            )}
                            {filters.industryId && (
                                <Badge status="info">
                                    Industry: {industryOptions.find(o => o.value === filters.industryId)?.label ?? "Unknown"}
                                </Badge>
                            )}
                            {filters.province && (
                                <Badge status="info">Province: {filters.province}</Badge>
                            )}
                            {filters.emailOptIn !== null && (
                                <Badge status="info">
                                    Email: {filters.emailOptIn ? "Opted In" : "Not Opted In"}
                                </Badge>
                            )}
                            {filters.whatsappOptIn !== null && (
                                <Badge status="info">
                                    WhatsApp: {filters.whatsappOptIn ? "Opted In" : "Not Opted In"}
                                </Badge>
                            )}
                            {filters.ownerId && filters.ownerId !== lockedConsultantId && (
                                <Badge status="info">
                                    Consultant: {ownerOptions.find(o => o.value === filters.ownerId)?.label ?? filters.ownerId}
                                </Badge>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function LookupCombobox({
    options,
    value,
    onChange,
    placeholder,
    searchPlaceholder,
    emptyText,
}: {
    options: Option[];
    value: string | null;
    onChange: (val: string | null) => void;
    placeholder: string;
    searchPlaceholder: string;
    emptyText: string;
}) {
    const [open, setOpen] = useState(false);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    role="combobox"
                    aria-expanded={open}
                    className="w-full justify-between bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10 flex items-center"
                >
                    <span className="truncate">
                        {value
                            ? options.find((o) => o.value === value)?.label ?? "Selected"
                            : placeholder}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </button>
            </PopoverTrigger>
            <PopoverContent className="w-[300px] p-0" align="start">
                <Command>
                    <CommandInput placeholder={searchPlaceholder} />
                    <CommandEmpty>{emptyText}</CommandEmpty>
                    <CommandGroup className="max-h-64 overflow-auto">
                        <CommandItem
                            value="__all__"
                            onSelect={() => {
                                onChange(null);
                                setOpen(false);
                            }}
                        >
                            <Check className={cn("mr-2 h-4 w-4", !value ? "opacity-100" : "opacity-0")} />
                            {placeholder}
                        </CommandItem>
                        {options.map((option) => (
                            <CommandItem
                                key={option.value}
                                value={option.label}
                                onSelect={() => {
                                    onChange(option.value);
                                    setOpen(false);
                                }}
                            >
                                <Check
                                    className={cn(
                                        "mr-2 h-4 w-4",
                                        value === option.value ? "opacity-100" : "opacity-0"
                                    )}
                                />
                                {option.label}
                            </CommandItem>
                        ))}
                    </CommandGroup>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
