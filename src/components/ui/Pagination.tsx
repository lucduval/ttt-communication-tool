"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

interface PaginationProps {
    currentPage: number;
    totalPages: number;
    totalItems: number;
    itemsPerPage: number;
    onPageChange: (page: number) => void;
    isLoading?: boolean;
}

export function Pagination({
    currentPage,
    totalPages,
    totalItems,
    itemsPerPage,
    onPageChange,
    isLoading = false,
}: PaginationProps) {
    // Calculate which items are showing
    const startItem = (currentPage - 1) * itemsPerPage + 1;
    const endItem = Math.min(currentPage * itemsPerPage, totalItems);

    // Generate page numbers to show
    const getPageNumbers = (): (number | "...")[] => {
        const pages: (number | "...")[] = [];
        const maxVisible = 5;

        if (totalPages <= maxVisible) {
            for (let i = 1; i <= totalPages; i++) {
                pages.push(i);
            }
        } else {
            // Always show first page
            pages.push(1);

            if (currentPage > 3) {
                pages.push("...");
            }

            // Show pages around current
            const start = Math.max(2, currentPage - 1);
            const end = Math.min(totalPages - 1, currentPage + 1);

            for (let i = start; i <= end; i++) {
                pages.push(i);
            }

            if (currentPage < totalPages - 2) {
                pages.push("...");
            }

            // Always show last page
            if (totalPages > 1) {
                pages.push(totalPages);
            }
        }

        return pages;
    };

    if (totalPages <= 1) {
        return (
            <div className="text-center text-sm text-gray-500">
                Showing {totalItems.toLocaleString()} contact{totalItems !== 1 ? "s" : ""}
            </div>
        );
    }

    return (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            {/* Item count */}
            <div className="text-sm text-gray-500">
                Showing <span className="font-medium text-gray-900">{startItem.toLocaleString()}</span> to{" "}
                <span className="font-medium text-gray-900">{endItem.toLocaleString()}</span> of{" "}
                <span className="font-medium text-gray-900">{totalItems.toLocaleString()}</span> contacts
            </div>

            {/* Page navigation */}
            <div className="flex items-center gap-1">
                {/* First page */}
                <button
                    onClick={() => onPageChange(1)}
                    disabled={currentPage === 1 || isLoading}
                    className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    title="First page"
                >
                    <ChevronsLeft size={18} className="text-gray-600" />
                </button>

                {/* Previous page */}
                <button
                    onClick={() => onPageChange(currentPage - 1)}
                    disabled={currentPage === 1 || isLoading}
                    className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    title="Previous page"
                >
                    <ChevronLeft size={18} className="text-gray-600" />
                </button>

                {/* Page numbers */}
                <div className="flex items-center gap-1 mx-2">
                    {getPageNumbers().map((page, index) =>
                        page === "..." ? (
                            <span key={`ellipsis-${index}`} className="px-2 py-1 text-gray-400">
                                …
                            </span>
                        ) : (
                            <button
                                key={page}
                                onClick={() => onPageChange(page)}
                                disabled={isLoading}
                                className={`min-w-[36px] h-9 px-3 rounded-lg font-medium transition-colors ${currentPage === page
                                        ? "bg-[#1E3A5F] text-white"
                                        : "text-gray-600 hover:bg-gray-100"
                                    } ${isLoading ? "opacity-50 cursor-not-allowed" : ""}`}
                            >
                                {page}
                            </button>
                        )
                    )}
                </div>

                {/* Next page */}
                <button
                    onClick={() => onPageChange(currentPage + 1)}
                    disabled={currentPage === totalPages || isLoading}
                    className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    title="Next page"
                >
                    <ChevronRight size={18} className="text-gray-600" />
                </button>

                {/* Last page */}
                <button
                    onClick={() => onPageChange(totalPages)}
                    disabled={currentPage === totalPages || isLoading}
                    className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    title="Last page"
                >
                    <ChevronsRight size={18} className="text-gray-600" />
                </button>
            </div>
        </div>
    );
}
