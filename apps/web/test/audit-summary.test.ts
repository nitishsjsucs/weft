// The audit log's summaries as copy (owner: layout-and-ui): file names, offer ids and agency codes read as words.
import { describe, expect, it } from "vitest";
import { auditSummary } from "../src/components/app/audit/audit-view";

describe("auditSummary", () => {
  it("names a delivered notice by its form, not its file", () => {
    expect(auditSummary("Delivered CA_EDD_DE2088_2026.txt from ca_edd as the notice")).toBe("Delivered the CA EDD DE 2088 notice");
  });
  it("drops the offer id and keeps the candidate", () => {
    expect(auditSummary("Drafted offer offr_0002 for Tess Harlow, Firmware Test Engineer")).toBe("Drafted an offer for Tess Harlow, Firmware Test Engineer");
  });
  it("reads a numbered draft response, a quarter and an agency code as words", () => {
    expect(auditSummary("Drafted response 1 for ntc_0005")).toBe("Drafted a response to the notice");
    expect(auditSummary("Filed NYS45 for 2026-Q2 with ny_dtf; accepted")).toBe("Filed NYS45 for Q2 2026 with NY DTF; accepted");
    expect(auditSummary("Filed DE9 for 2026-Q2 with ca_edd; accepted")).toBe("Filed DE9 for Q2 2026 with CA EDD; accepted");
    expect(auditSummary("Delivered ca_edd_notice.txt from ca_edd as the notice")).toBe("Delivered a notice from CA EDD");
  });
  it("leaves no row id or ISO date in a person or run summary", () => {
    const s = auditSummary("Added Tobias Wren (wrk_0056) as Mechanical Technician, starting 2026-11-30");
    expect(s).not.toMatch(/wrk_|\d{4}-\d{2}-\d{2}/);
  });
});
