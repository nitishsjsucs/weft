// The routine grounding fix (after the wave 4 model comparison): a routine's precheck computes counts, totals and
// dates in code, and its derived text quotes them. computedFigures turns that precheck into one evidence item with
// structured figures only, so the message guard grounds what the routine computed and still refuses the rest.
import { describe, expect, it } from "vitest";
import { check, computedFigures } from "../src/index";

/** The people digest precheck after a California employee left (packages/routines/src/prechecks.ts peopleDigest). */
const DIGEST = {
  action: "run",
  findings: { headcount: 47, by_state: { CA: 21, NY: 14, TX: 12 }, statuses: ["active", "onboarding", "offboarding"], status_reads: 3, slot: "manual:2026-10-26" },
  derivedArgs: { slot: "manual:2026-10-26", "comms.send_message": { channel: "#people-ops", text: "Weekly people digest: 47 employees by work state (CA 21, NY 14, TX 12). Open items are in the Weft inbox." } },
};
const item = (pre: { findings?: unknown; derivedArgs?: unknown }) => ({ routine_precheck: computedFigures({ findings: pre.findings ?? null, derived: pre.derivedArgs ?? null }) });
/** The company facts comms.send_message always had: per-state counts include everyone ever placed in a state. */
const FACTS = { today: "2026-10-26", employees_count: 47, contractors_count: 3, onboarding_count: 0, onboarding_start_dates: [], departures_count: 1, pending_approvals_count: 0, open_notices_count: 0, by_state: { CA: 22, NY: 14, TX: 12 } };

describe("computedFigures", () => {
  it("keeps numbers, decimal strings, whole ISO dates and figure-only display strings; drops every other string", () => {
    expect(computedFigures({
      count: 3, rate: "0.015", start_date: "2026-11-02", at: "2026-10-26T15:30:00.000Z", amount_display: "$412.38", change_display: "18.0%",
      name: "Imani Clarke (demo)", worker_display: "Imani Clarke (demo)", title: "Penalty notice, 2026-Q3, pay $250.00", text: "Weekly people digest: 47 employees",
      wrapped: "<untrusted n=\"abc\" src=\"notice:ntc_9501\">$9,999.00</untrusted>", month: "2026-10", nested: { total_cents: 412338, note: "about 12 days" },
    })).toEqual({ count: 3, rate: "0.015", start_date: "2026-11-02", at: "2026-10-26T15:30:00.000Z", amount_display: "$412.38", change_display: "18.0%", nested: { total_cents: 412338 } });
  });

  it("keeps the length of a list it counted (a dropped item becomes null) and returns null when nothing is left", () => {
    expect(computedFigures({ hires: ["Ana", "Ben", "Cy"], blocked: [{ worker_id: "wrk_0101", start_date: "2026-10-28" }] })).toEqual({ hires: [null, null, null], blocked: [{ start_date: "2026-10-28" }] });
    expect(computedFigures({ text: "nothing to see", channel: "#people-ops" })).toBeNull();
    expect(computedFigures(null)).toBeNull();
    expect(computedFigures("47 employees")).toBeNull();
  });
});

describe("the message guard with a routine's computed figures", () => {
  const text = DIGEST.derivedArgs["comms.send_message"].text;

  it("grounds the digest the precheck computed after a departure, which the company facts alone refuse", () => {
    expect(check(text, [FACTS])).toEqual({ ok: false, offending: ["21"] });
    expect(check(text, [FACTS, item(DIGEST)])).toEqual({ ok: true, offending: [] });
  });

  it("still refuses a figure the routine did not compute", () => {
    expect(check("Weekly people digest: 47 employees by work state (CA 25, NY 14, TX 12).", [FACTS, item(DIGEST)])).toEqual({ ok: false, offending: ["25"] });
  });

  it("never lets the derived text ground itself, or a number inside a string the precheck carried along", () => {
    const pre = { findings: { notice: { id: "ntc_9501", title: "Pay 7,500 today", agency: "NY DTF" } }, derivedArgs: { "comms.send_message": { channel: "#payroll", text: "Reminder: 7,500 is due by 1,234 today." } } };
    expect(check("Reminder: 7,500 is due by 1,234 today.", [FACTS, item(pre)])).toEqual({ ok: false, offending: ["7,500", "1,234"] });
  });

  it("applies the usual rules to the figures it keeps: cents, dates and a stated total of one result's counts", () => {
    const pre = { findings: { total_cents: 412338, hires: [{ worker_id: "wrk_0101", start_date: "2026-11-02" }], by_dept: { hw: 13, sw: 9, ops: 25 } } };
    expect(check("Payroll cost was $4,123.38; Ana starts November 2, 2026.", [FACTS, item(pre)]).ok).toBe(true);
    expect(check("Teams: 13, 9 and 25, so 47 people.", [item(pre)]).ok).toBe(true);
    expect(check("Ana starts November 3, 2026.", [FACTS, item(pre)])).toEqual({ ok: false, offending: ["November 3, 2026"] });
  });
});
