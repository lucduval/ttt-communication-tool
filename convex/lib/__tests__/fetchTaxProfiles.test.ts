/**
 * Tests for the batch entry point of the Tax Profile module (issue #25).
 *
 * `fetchTaxProfiles(contactIds)` is the list-facing sibling of `fetchTaxProfile`:
 * it reads ITA34/IRP5 for a page of contacts, dedups each contact's rows to the
 * latest year (the same `pickLatest` rule the singular read uses), and maps each
 * into `TaxProfileData`. Because the list resolves figures through here, the
 * list figure equals the preview figure equals the sent-email figure.
 *
 * The Dynamics boundary (`dynamicsRequest`) is faked the way the sender
 * characterization tests fake it; the module's selection + mapping run for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const boundary = vi.hoisted(() => ({
    dynamicsRequest: vi.fn(),
}));

vi.mock("../dynamics_auth", () => ({
    dynamicsRequest: boundary.dynamicsRequest,
}));

import { fetchTaxProfiles } from "../taxProfile";

function ita34Row(contactId: string, year: number, income: number, taxableIncome: number) {
    return {
        _riivo_taxpayercontact_value: contactId,
        riivo_yearofassessment: year,
        riivo_income: income,
        riivo_taxableincomeassessedloss: taxableIncome,
    };
}

function irp5Row(contactId: string, year: number, paye: number) {
    return {
        _riivo_client_value: contactId,
        riivo_assessmentyearint: year,
        riivo_incomepaye: paye,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("fetchTaxProfiles (faked Dynamics boundary)", () => {
    it("selects the latest ITA34 year per contact", async () => {
        boundary.dynamicsRequest.mockImplementation(async (path: string) => {
            if (path.includes("riivo_ita34s")) {
                return {
                    value: [
                        ita34Row("c1", 2021, 100, 90),
                        ita34Row("c1", 2024, 400, 360),
                        ita34Row("c1", 2022, 200, 180),
                    ],
                };
            }
            if (path.includes("riivo_irp5s")) {
                return { value: [irp5Row("c1", 2024, 380)] };
            }
            return { value: [] };
        });

        const profiles = await fetchTaxProfiles(["c1"]);
        const c1 = profiles.get("c1");
        expect(c1?.ita34?.yearOfAssessment).toBe(2024);
        expect(c1?.ita34?.income).toBe(400);
        expect(c1?.ita34?.taxableIncome).toBe(360);
        expect(c1?.irp5?.assessmentYear).toBe(2024);
    });

    it("keys results by contact and selects the latest IRP5 year per contact", async () => {
        boundary.dynamicsRequest.mockImplementation(async (path: string) => {
            if (path.includes("riivo_ita34s")) {
                return {
                    value: [ita34Row("c1", 2024, 400, 360), ita34Row("c2", 2023, 300, 270)],
                };
            }
            if (path.includes("riivo_irp5s")) {
                return {
                    value: [
                        irp5Row("c1", 2022, 100),
                        irp5Row("c1", 2024, 380),
                        irp5Row("c2", 2023, 290),
                    ],
                };
            }
            return { value: [] };
        });

        const profiles = await fetchTaxProfiles(["c1", "c2"]);
        expect(profiles.get("c1")?.irp5?.assessmentYear).toBe(2024);
        expect(profiles.get("c1")?.irp5?.incomePaye).toBe(380);
        expect(profiles.get("c2")?.ita34?.income).toBe(300);
        expect(profiles.get("c2")?.irp5?.assessmentYear).toBe(2023);
    });

    it("maps a missing IRP5 to null while keeping the ITA34 figures", async () => {
        boundary.dynamicsRequest.mockImplementation(async (path: string) => {
            if (path.includes("riivo_ita34s")) {
                return { value: [ita34Row("c1", 2024, 400, 360)] };
            }
            if (path.includes("riivo_irp5s")) return { value: [] };
            return { value: [] };
        });

        const profiles = await fetchTaxProfiles(["c1"]);
        expect(profiles.get("c1")?.ita34?.taxableIncome).toBe(360);
        expect(profiles.get("c1")?.irp5).toBeNull();
    });

    it("maps a contact with no ITA34 to a null ita34 sub-object", async () => {
        boundary.dynamicsRequest.mockImplementation(async (path: string) => {
            if (path.includes("riivo_ita34s")) {
                return { value: [ita34Row("c1", 2024, 400, 360)] };
            }
            if (path.includes("riivo_irp5s")) return { value: [] };
            return { value: [] };
        });

        const profiles = await fetchTaxProfiles(["c1", "c2"]);
        expect(profiles.get("c1")?.ita34?.income).toBe(400);
        expect(profiles.get("c2")?.ita34).toBeNull();
    });

    it("returns an empty map for an empty id list without calling Dynamics", async () => {
        const profiles = await fetchTaxProfiles([]);
        expect(profiles.size).toBe(0);
        expect(boundary.dynamicsRequest).not.toHaveBeenCalled();
    });

    it("batches reads ~50 ids per request", async () => {
        boundary.dynamicsRequest.mockResolvedValue({ value: [] });
        const ids = Array.from({ length: 120 }, (_, i) => `c${i}`);
        await fetchTaxProfiles(ids);
        // 3 id-batches (50/50/20), two entity reads each → 6 requests.
        expect(boundary.dynamicsRequest).toHaveBeenCalledTimes(6);
    });
});
