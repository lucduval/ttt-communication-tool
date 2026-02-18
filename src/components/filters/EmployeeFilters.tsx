"use client";

import { useState, useMemo } from "react";
import { Button, Badge } from "@/components/ui";
import { Filter, X, Search, ChevronsUpDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface EmployeeFilterState {
    emailDomains: string[];
    status: "all" | "active" | "inactive";
}

interface EmployeeFiltersProps {
    filters: EmployeeFilterState;
    onFiltersChange: (filters: EmployeeFilterState) => void;
    availableDomains: string[];
    totalCount?: number | null;
}

export function EmployeeFilters({
    filters,
    onFiltersChange,
    availableDomains,
    totalCount,
}: EmployeeFiltersProps) {
    const [showAdvanced, setShowAdvanced] = useState(false);

    const updateFilter = <K extends keyof EmployeeFilterState>(
        key: K,
        value: EmployeeFilterState[K]
    ) => {
        onFiltersChange({ ...filters, [key]: value });
    };

    const clearFilters = () => {
        onFiltersChange({ emailDomains: [], status: "all" });
    };

    const hasActiveFilters =
        filters.emailDomains.length > 0 || filters.status !== "all";

    return (
        <div className="space-y-4">
            <div className="flex flex-col md:flex-row gap-4">
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
                                {totalCount.toLocaleString()} employees
                            </span>
                        </div>
                    )}
                </div>
            </div>

            {showAdvanced && (
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-100 space-y-4">
                    <div className="flex justify-between items-center">
                        <h4 className="font-semibold text-sm text-gray-700">
                            Filter Employees
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
                        {/* Email Domain */}
                        <div className="md:col-span-2">
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Email Domain
                            </label>
                            <DomainMultiSelect
                                options={availableDomains}
                                selected={filters.emailDomains}
                                onChange={(selected) => updateFilter("emailDomains", selected)}
                                placeholder="All domains"
                            />
                        </div>

                        {/* Status */}
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Status
                            </label>
                            <select
                                value={filters.status}
                                onChange={(e) =>
                                    updateFilter("status", e.target.value as EmployeeFilterState["status"])
                                }
                                className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                            >
                                <option value="all">All</option>
                                <option value="active">Active Only</option>
                                <option value="inactive">Inactive Only</option>
                            </select>
                        </div>
                    </div>

                    {hasActiveFilters && (
                        <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
                            {filters.emailDomains.length > 0 && (
                                <Badge status="info">
                                    Domains: {filters.emailDomains.join(", ")}
                                </Badge>
                            )}
                            {filters.status !== "all" && (
                                <Badge status="info">
                                    Status: {filters.status === "active" ? "Active" : "Inactive"}
                                </Badge>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function DomainMultiSelect({
    options,
    selected,
    onChange,
    placeholder,
}: {
    options: string[];
    selected: string[];
    onChange: (val: string[]) => void;
    placeholder: string;
}) {
    const [open, setOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");

    const handleToggle = (value: string) => {
        if (selected.includes(value)) {
            onChange(selected.filter((v) => v !== value));
        } else {
            onChange([...selected, value]);
        }
    };

    const filteredOptions = options.filter((opt) =>
        opt.toLowerCase().includes(searchTerm.toLowerCase())
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
                        {selected.length === 0 ? (
                            <span className="text-gray-500">{placeholder}</span>
                        ) : (
                            selected.join(", ")
                        )}
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
                            placeholder="Search domains..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="flex-1 text-sm outline-none bg-transparent placeholder:text-gray-400"
                        />
                    </div>
                </div>
                <div className="max-h-64 overflow-y-auto p-1">
                    {filteredOptions.length === 0 ? (
                        <div className="py-4 text-center text-sm text-gray-500">
                            No domains found.
                        </div>
                    ) : (
                        filteredOptions.map((domain) => (
                            <label
                                key={domain}
                                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-100 cursor-pointer text-sm"
                            >
                                <input
                                    type="checkbox"
                                    checked={selected.includes(domain)}
                                    onChange={() => handleToggle(domain)}
                                    className="h-4 w-4 rounded border-gray-300 text-[#1E3A5F] focus:ring-[#1E3A5F]"
                                />
                                <span>{domain}</span>
                            </label>
                        ))
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}
