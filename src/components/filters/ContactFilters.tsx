"use client";

import { useState, useEffect } from "react";
import { Button, Badge } from "@/components/ui";
import { Search, Filter, X, Check, ChevronsUpDown } from "lucide-react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface FilterState {
    search: string;
    clientType: string | null; // Now "Service Line" (Tax, Accounting, etc.)
    entityType: number | null; // Individual vs Business
    marketingType: "tax" | "accounting" | "insurance" | "all";
    whatsappOptIn: boolean | null;
    emailEnabled: boolean | null;
    bank: number | null;
    sourceCode: number[]; // MultiSelect
    province: string | null;
    ageMin: number | null;
    ageMax: number | null;
    ownerId: string | null;
    industryId: string | null;
}

interface Option {
    value: number | string;
    label: string;
}

interface ContactFiltersProps {
    filters: FilterState;
    onFiltersChange: (filters: FilterState) => void;
    totalCount?: number | null;
}

export function ContactFilters({
    filters,
    onFiltersChange,
    totalCount,
}: ContactFiltersProps) {
    const [showAdvanced, setShowAdvanced] = useState(false);

    // -- Dynamic Options State --
    const [clientTypeOptions, setClientTypeOptions] = useState<Option[]>([]);
    const [entityTypeOptions, setEntityTypeOptions] = useState<Option[]>([]);
    const [bankOptions, setBankOptions] = useState<Option[]>([]);
    const [sourceCodeOptions, setSourceCodeOptions] = useState<Option[]>([]);
    const [ownerOptions, setOwnerOptions] = useState<Option[]>([]);
    const [industryOptions, setIndustryOptions] = useState<Option[]>([]);

    // -- API Actions --
    const getAttributeOptions = useAction(api.actions.dynamics.getAttributeOptionSet);
    const getGlobalOptions = useAction(api.actions.dynamics.getGlobalOptionSet);

    const getOwnerOptions = useAction(api.actions.dynamics.fetchUsers);
    const getIndustryOptions = useAction(api.actions.dynamics.fetchIndustries);

    // -- Fetch Metadata on Mount --
    useEffect(() => {
        const fetchMetadata = async () => {
            try {
                // Client Type (riivo_clienttypenew)
                const clientTypes = await getAttributeOptions({ entityName: "contact", attributeName: "riivo_clienttypenew" });
                setClientTypeOptions(clientTypes.options);

                // Entity Type (riivo_clienttypeindbus)
                // Note: user said this is "riivo_clienttypeindbus" with values 0,1,2,3,4,5
                const entityTypes = await getAttributeOptions({ entityName: "contact", attributeName: "riivo_clienttypeindbus" });
                setEntityTypeOptions(entityTypes.options);

                // Bank (ttt_bank)
                const banks = await getAttributeOptions({ entityName: "contact", attributeName: "ttt_bank" });
                setBankOptions(banks.options);

                // Source Code (riivo_sourcecode) -> MultiSelect
                const sources = await getAttributeOptions({ entityName: "contact", attributeName: "riivo_sourcecode" });
                setSourceCodeOptions(sources.options);

                // Owners (Consultants)
                const owners = await getOwnerOptions();
                setOwnerOptions(owners.map(o => ({ value: o.id, label: o.name })));

                // Industries
                const industries = await getIndustryOptions();
                setIndustryOptions(industries.map((i: any) => ({ value: i.id, label: i.name })));

            } catch (err) {
                console.error("Failed to load filter metadata:", err);
            }
        };

        fetchMetadata();
    }, [getAttributeOptions]);


    const updateFilter = <K extends keyof FilterState>(
        key: K,
        value: FilterState[K]
    ) => {
        onFiltersChange({ ...filters, [key]: value });
    };

    const clearFilters = () => {
        onFiltersChange({
            search: "",
            clientType: null,
            marketingType: "all",
            whatsappOptIn: null,
            emailEnabled: null,
            entityType: null,
            bank: null,
            sourceCode: [],
            province: null,
            ageMin: null,
            ageMax: null,
            ownerId: null,
            industryId: null,
        });
    };

    const hasActiveFilters =
        filters.clientType !== null ||
        filters.marketingType !== "all" ||
        filters.whatsappOptIn !== null ||
        filters.emailEnabled !== null ||
        filters.entityType !== null ||
        filters.bank !== null ||
        filters.sourceCode.length > 0 ||
        filters.province !== null ||
        filters.ageMin !== null ||
        filters.ageMax !== null ||
        filters.ownerId !== null ||
        filters.industryId !== null;

    return (
        <div className="space-y-4">
            {/* Search and Toggle */}
            <div className="flex flex-col md:flex-row gap-4">
                <div className="flex-1 relative">
                    <Search
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                        size={16}
                    />
                    <input
                        type="text"
                        placeholder="Search by name or email..."
                        value={filters.search}
                        onChange={(e) => updateFilter("search", e.target.value)}
                        className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-md text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                    />
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
                                {totalCount.toLocaleString()} contacts
                            </span>
                        </div>
                    )}
                </div>
            </div>

            {/* Advanced Filters */}
            {showAdvanced && (
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-100 space-y-4">
                    <div className="flex justify-between items-center">
                        <h4 className="font-semibold text-sm text-gray-700">
                            Filter Contacts
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

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        {/* Entity Type (Individual vs Business) */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Entity Type
                            </label>
                            <select
                                value={filters.entityType === null ? "" : filters.entityType}
                                onChange={(e) =>
                                    updateFilter("entityType", e.target.value === "" ? null : Number(e.target.value))
                                }
                                className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                            >
                                <option value="">All Entities</option>
                                {entityTypeOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Consultant (Owner) */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Consultant
                            </label>
                            <select
                                value={filters.ownerId || ""}
                                onChange={(e) =>
                                    updateFilter("ownerId", e.target.value || null)
                                }
                                className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                            >
                                <option value="">All Consultants</option>
                                {ownerOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
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

                        {/* Client Type (Service Line) */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Client Type (Service)
                            </label>
                            <select
                                value={filters.clientType || ""}
                                onChange={(e) =>
                                    updateFilter("clientType", e.target.value || null)
                                }
                                className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                            >
                                <option value="">All Types</option>
                                {clientTypeOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value.toString()}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Bank */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Bank
                            </label>
                            <select
                                value={filters.bank === null ? "" : filters.bank}
                                onChange={(e) =>
                                    updateFilter("bank", e.target.value === "" ? null : Number(e.target.value))
                                }
                                className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                            >
                                <option value="">All Banks</option>
                                {bankOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Province (Free Text) */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Province
                            </label>
                            <input
                                type="text"
                                placeholder="e.g. Gauteng"
                                value={filters.province || ""}
                                onChange={(e) => updateFilter("province", e.target.value || null)}
                                className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                            />
                        </div>

                        {/* Source Code (MultiSelect) */}
                        <div className="md:col-span-2">
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Source Code
                            </label>
                            <MultiSelect
                                options={sourceCodeOptions}
                                selected={filters.sourceCode}
                                onChange={(selected) => updateFilter("sourceCode", selected)}
                                placeholder="Select sources..."
                            />
                        </div>

                        {/* Age Range */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Age Range
                            </label>
                            <div className="flex gap-2 items-center">
                                <input
                                    type="number"
                                    placeholder="Min"
                                    value={filters.ageMin || ""}
                                    onChange={(e) => updateFilter("ageMin", e.target.value ? Number(e.target.value) : null)}
                                    className="w-1/2 bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                                />
                                <span className="text-gray-400">-</span>
                                <input
                                    type="number"
                                    placeholder="Max"
                                    value={filters.ageMax || ""}
                                    onChange={(e) => updateFilter("ageMax", e.target.value ? Number(e.target.value) : null)}
                                    className="w-1/2 bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                                />
                            </div>
                        </div>


                        {/* Marketing Type */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Marketing Consent
                            </label>
                            <select
                                value={filters.marketingType}
                                onChange={(e) =>
                                    updateFilter(
                                        "marketingType",
                                        e.target.value as FilterState["marketingType"]
                                    )
                                }
                                className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                            >
                                <option value="all">All</option>
                                <option value="tax">Tax Marketing</option>
                                <option value="accounting">Accounting Marketing</option>
                                <option value="insurance">Insurance Marketing</option>
                            </select>
                        </div>

                        {/* WhatsApp Opt-in */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                WhatsApp Opt-in
                            </label>
                            <select
                                value={
                                    filters.whatsappOptIn === null
                                        ? ""
                                        : filters.whatsappOptIn
                                            ? "true"
                                            : "false"
                                }
                                onChange={(e) =>
                                    updateFilter(
                                        "whatsappOptIn",
                                        e.target.value === ""
                                            ? null
                                            : e.target.value === "true"
                                    )
                                }
                                className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                            >
                                <option value="">All</option>
                                <option value="true">Opted In</option>
                                <option value="false">Not Opted In</option>
                            </select>
                        </div>
                    </div>

                    {/* Active Filters Display */}
                    {hasActiveFilters && (
                        <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
                            {filters.entityType !== null && (
                                <Badge status="info">
                                    Entity: {entityTypeOptions.find(o => o.value === filters.entityType)?.label || filters.entityType}
                                </Badge>
                            )}
                            {filters.clientType && (
                                <Badge status="info">
                                    Service: {clientTypeOptions.find(o => o.value.toString() === filters.clientType)?.label || filters.clientType}
                                </Badge>
                            )}
                            {filters.bank !== null && (
                                <Badge status="info">
                                    Bank: {bankOptions.find(o => o.value === filters.bank)?.label || filters.bank}
                                </Badge>
                            )}
                            {filters.sourceCode.length > 0 && (
                                <Badge status="info">
                                    Sources: {filters.sourceCode.length} selected
                                </Badge>
                            )}
                            {filters.province && (
                                <Badge status="info">
                                    Province: {filters.province}
                                </Badge>
                            )}
                            {(filters.ageMin || filters.ageMax) && (
                                <Badge status="info">
                                    Age: {filters.ageMin || 0} - {filters.ageMax || "∞"}
                                </Badge>
                            )}
                            {filters.ownerId && (
                                <Badge status="info">
                                    Consultant: {ownerOptions.find(o => o.value === filters.ownerId)?.label || "Unknown"}
                                </Badge>
                            )}
                            {filters.industryId && (
                                <Badge status="info">
                                    Industry: {industryOptions.find(o => o.value === filters.industryId)?.label || "Unknown"}
                                </Badge>
                            )}
                            {filters.marketingType !== "all" && (
                                <Badge status="info">
                                    {filters.marketingType.charAt(0).toUpperCase() +
                                        filters.marketingType.slice(1)}{" "}
                                    Marketing
                                </Badge>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * MultiSelect Component - Simple checkbox-based implementation
 */
function MultiSelect({
    options,
    selected,
    onChange,
    placeholder
}: {
    options: Option[],
    selected: number[],
    onChange: (val: number[]) => void,
    placeholder: string
}) {
    const [open, setOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");

    const handleToggle = (value: number) => {
        if (selected.includes(value)) {
            onChange(selected.filter(v => v !== value));
        } else {
            onChange([...selected, value]);
        }
    };

    const filteredOptions = options.filter(opt =>
        opt.label.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    role="combobox"
                    aria-expanded={open}
                    className="w-full justify-between bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10 flex items-center text-left"
                >
                    <span className="truncate">
                        {selected.length === 0
                            ? <span className="text-gray-500">{placeholder}</span>
                            : `${selected.length} selected`
                        }
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </button>
            </PopoverTrigger>
            <PopoverContent className="w-[300px] p-0" align="start">
                <div className="p-2 border-b">
                    <div className="flex items-center gap-2 px-2">
                        <Search className="h-4 w-4 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="flex-1 text-sm outline-none bg-transparent placeholder:text-gray-400"
                        />
                    </div>
                </div>
                <div className="max-h-64 overflow-y-auto p-1">
                    {filteredOptions.length === 0 ? (
                        <div className="py-4 text-center text-sm text-gray-500">
                            No items found.
                        </div>
                    ) : (
                        filteredOptions.map((option) => (
                            <label
                                key={option.value}
                                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-100 cursor-pointer text-sm"
                            >
                                <input
                                    type="checkbox"
                                    checked={selected.includes(option.value as number)}
                                    onChange={() => handleToggle(option.value as number)}
                                    className="h-4 w-4 rounded border-gray-300 text-[#1E3A5F] focus:ring-[#1E3A5F]"
                                />
                                <span>{option.label}</span>
                            </label>
                        ))
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}

/**
 * Convert filter state to OData filter expression
 */
export function buildODataFilter(filters: FilterState): string | undefined {
    const conditions: string[] = [];

    // Note: clientType is handled via direct arguments to fetchContacts/getContactCount

    if (filters.marketingType !== "all") {
        const fieldMap = {
            tax: "riivo_taxmarketing",
            accounting: "riivo_accountingmarketing",
            insurance: "riivo_insurancemarketing",
        };
        conditions.push(`${fieldMap[filters.marketingType]} eq true`);
    }

    if (filters.whatsappOptIn !== null) {
        conditions.push(
            `riivo_whatsappoptinout eq ${filters.whatsappOptIn ? "true" : "false"}`
        );
    }

    if (filters.emailEnabled !== null) {
        conditions.push(
            `icon_sendemailclientnotifications eq ${filters.emailEnabled ? "true" : "false"}`
        );
    }

    return conditions.length > 0 ? conditions.join(" and ") : undefined;
}
