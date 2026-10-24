import { describe, expect, it } from "vitest";
import type { ReadOnlyExecutor, ToolOutcome } from "@weft/contracts";
import { PRECHECKS } from "../src/index";

const done = (data: unknown): ToolOutcome => ({ ok: true, status: "done", resultId: "res_1", data, summary: "ok", actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" });
type Answer = unknown | ((args: Record<string, unknown>) => unknown);
const exec = (answers: Record<string, Answer>): ReadOnlyExecutor & { seen: { command: string; args: unknown }[] } => {
  const seen: { command: string; args: unknown }[] = [];
  return { seen, async exec(_c, command, args) {
    seen.push({ command, args });
    const a = answers[command];
    return done(typeof a === "function" ? (a as (x: Record<string, unknown>) => unknown)(args as Record<string, unknown>) : a ?? {});
  } };
};
const ctx = (payload: unknown) => ({ companyId: "cmp_larkspur", now: "2026-10-26T16:00:00.000Z", triggerRef: "evt_0001", payload });

describe("prechecks on the t1 and t2 read shapes", () => {
  it("agency_notice derives tax.update_rate from the notice extract and reads the impact", async () => {
    const ex = exec({
      "notices.get": { notice: { id: "ntc_0001", kind: "rate_change", tax_account_id: "txa_0003", agency: "ca_edd", extracted: { agency: "ca_edd", kind: "rate_change", taxAccountId: "txa_0003", effectiveFrom: "2026-01-01", respondBy: "2026-11-05", rates: [{ code: "sui", oldRate: "0.034", newRate: "0.015" }] } } },
      "tax.rate_change_impact": { rate_delta: "0.019", affected_count: 22 },
    });
    const r = await PRECHECKS.agency_notice!(ctx({ notice_id: "ntc_0001" }), ex);
    expect(r).toMatchObject({ action: "run", severity: "interrupt", derivedArgs: { "tax.update_rate": { tax_account_id: "txa_0003", code: "sui", rate: "0.015", effective_from: "2026-01-01", source_notice_id: "ntc_0001" } } });
    expect(ex.seen.find((s) => s.command === "tax.rate_change_impact")?.args).toMatchObject({ jurisdiction: "CA", code: "sui", new_rate: "0.015" });
  });

  it("agency_notice plans a notice that is not a rate change instead of skipping it (FM1)", async () => {
    const r = await PRECHECKS.agency_notice!(ctx({ notice_id: "ntc_0002" }), exec({ "notices.get": { notice: { id: "ntc_0002", kind: "missing_filing", agency: "ny_dtf", form_code: "NYS-45", extracted: { rates: [] } } } }));
    // No form code in the extract, so no filing can be matched: the planner escalates with notices.escalate.
    expect(r).toMatchObject({ action: "run", derivedArgs: { plan: "escalate", "notices.escalate": { notice_id: "ntc_0002", reason_code: "missing_filing" } } });
    expect(JSON.stringify(r)).not.toContain("handoffs.open");
  });

  // Fix group duplicate-proposal: idempotent per notice, and per letter when the same letter arrives twice.
  const rateNotice = (extra: Record<string, unknown>) => ({ notice: { id: "ntc_0002", kind: "rate_change", status: "in_review", tax_account_id: "txa_0003", agency: "ca_edd", extracted: { agency: "ca_edd", kind: "rate_change", taxAccountId: "txa_0003", effectiveFrom: "2026-01-01", rates: [{ code: "sui", oldRate: "0.034", newRate: "0.015" }] }, ...extra } });
  it("agency_notice skips a notice whose proposals are still open, naming them, and reads nothing else", async () => {
    const ex = exec({ "notices.get": rateNotice({ proposals: [{ id: "prp_0002", command: "notices.send_response", status: "pending" }, { id: "prp_0001", command: "tax.update_rate", status: "pending" }], duplicate_of: null }) });
    const r = await PRECHECKS.agency_notice!(ctx({ notice_id: "ntc_0002" }), ex);
    expect(r).toMatchObject({ action: "skip" });
    expect(r.action === "skip" && r.reason).toBe("Notice ntc_0002 is already being handled: notices.send_response prp_0002 (pending), tax.update_rate prp_0001 (pending). Nothing new to propose until a person decides.");
    expect(ex.seen.map((s) => s.command)).toEqual(["notices.get"]);
  });

  it("agency_notice runs again when every earlier proposal was denied or expired", async () => {
    const r = await PRECHECKS.agency_notice!(ctx({ notice_id: "ntc_0002" }), exec({ "notices.get": rateNotice({ proposals: [{ id: "prp_0001", command: "tax.update_rate", status: "expired" }, { id: "prp_0002", command: "notices.send_response", status: "denied" }] }) }));
    expect(r).toMatchObject({ action: "run", derivedArgs: { plan: "update_rate" } });
  });

  it("agency_notice skips a later copy of a letter that is being handled or resolved, and handles one whose first copy never was", async () => {
    const copy = (duplicate_of: unknown) => exec({ "notices.get": rateNotice({ status: "new", proposals: [], duplicate_of }) });
    const handled = await PRECHECKS.agency_notice!(ctx({ notice_id: "ntc_0002" }), copy({ id: "ntc_0001", status: "in_review", open_proposals: 2 }));
    expect(handled.action === "skip" && handled.reason).toContain("Notice ntc_0002 repeats ntc_0001 (same agency, form, account, parsed fields and text), which is already in_review with 2 open proposals.");
    const resolved = await PRECHECKS.agency_notice!(ctx({ notice_id: "ntc_0002" }), copy({ id: "ntc_0001", status: "resolved", open_proposals: 0 }));
    expect(resolved.action === "skip" && resolved.reason).toContain("which is already resolved.");
    expect(await PRECHECKS.agency_notice!(ctx({ notice_id: "ntc_0002" }), copy({ id: "ntc_0001", status: "new", open_proposals: 0 }))).toMatchObject({ action: "run" });
  });

  // Review fix group notices-and-proposals: a rate notice that confirms the rate in effect is acknowledge-only.
  const impactFor = (inEffect: Record<string, string>) => (a: Record<string, unknown>) => {
    const old = inEffect[String(a.code)]!;
    return { old_rate: old, new_rate: a.new_rate, rate_delta: old === a.new_rate ? "0" : "0.019" };
  };
  it("agency_notice acknowledges a rate notice whose rate is already in effect: skipped with the reason, nothing proposed", async () => {
    const ex = exec({ "notices.get": rateNotice({ form_code: "DE 2088", proposals: [], duplicate_of: null }), "tax.rate_change_impact": impactFor({ sui: "0.015" }) });
    const r = await PRECHECKS.agency_notice!(ctx({ notice_id: "ntc_0002" }), ex);
    expect(r).toEqual({ action: "skip", reason: "Acknowledge only: notice ntc_0002 (DE 2088) confirms the rate already in effect, CA SUI 1.5% effective 2026-01-01. Nothing to change or reply to, so no rate change or reply is proposed. A person can record it as read with notices.acknowledge." });
    // The delta is against the rate in effect, not the notice's own "previously" figure (here 3.4%).
    expect(ex.seen.find((s) => s.command === "tax.rate_change_impact")?.args).toMatchObject({ jurisdiction: "CA", code: "sui", new_rate: "0.015", effective_from: "2026-01-01" });
    expect(JSON.stringify(r)).not.toContain("tax.update_rate\"");
  });

  it("agency_notice treats an equal rate written differently (0.0340 against 0.034) as no change", async () => {
    const notice = { notice: { id: "ntc_0003", kind: "rate_change", status: "new", tax_account_id: "txa_0002", agency: "ca_edd", form_code: "DE 2088", proposals: [], extracted: { agency: "ca_edd", kind: "rate_change", effectiveFrom: "2026-01-01", rates: [{ code: "sui", oldRate: "0.034", newRate: "0.0340" }] } } };
    const r = await PRECHECKS.agency_notice!(ctx({ notice_id: "ntc_0003" }), exec({ "notices.get": notice, "tax.rate_change_impact": { old_rate: "0.034", new_rate: "0.0340", rate_delta: "0.0000" } }));
    expect(r.action === "skip" && r.reason).toContain("confirms the rate already in effect, CA SUI 3.4% effective 2026-01-01");
  });

  it("agency_notice proposes the rate that changes when another stated rate is already in effect", async () => {
    const notice = rateNotice({ proposals: [], extracted: { agency: "ca_edd", kind: "rate_change", taxAccountId: "txa_0003", effectiveFrom: "2026-01-01", rates: [{ code: "sui", oldRate: "0.034", newRate: "0.034" }, { code: "ett", oldRate: "0.002", newRate: "0.001" }] } });
    const r = await PRECHECKS.agency_notice!(ctx({ notice_id: "ntc_0002" }), exec({ "notices.get": notice, "tax.rate_change_impact": impactFor({ sui: "0.034", ett: "0.002" }) }));
    expect(r).toMatchObject({ action: "run", derivedArgs: { plan: "update_rate", "tax.update_rate": { code: "ett", rate: "0.001" } } });
  });

  it("agency_notice keeps the update_rate plan when the rate in effect cannot be read", async () => {
    const ex: ReadOnlyExecutor = { async exec(_c, command) { return command === "notices.get" ? done(rateNotice({ proposals: [] })) : { ok: false, refusal: { code: "DOMAIN_NO_CURRENT_RATE", message: "none", hint: null, example: null }, tainted: false } as ToolOutcome; } };
    expect(await PRECHECKS.agency_notice!(ctx({ notice_id: "ntc_0002" }), ex)).toMatchObject({ action: "run", derivedArgs: { plan: "update_rate", "tax.update_rate": { rate: "0.015" } } });
  });

  it("new_hire derives accounts, the welcome, registrations for unregistered accounts and the laptop", async () => {
    const r = await PRECHECKS.new_hire!(ctx({ worker_id: "wrk_0049", offer_id: "offr_0001" }), exec({
      "people.get": { worker: { id: "wrk_0049", name: "Noor Castellanos (wrk_0049)", work_state: "CO" } },
      "tax.list_registrations": { accounts: [{ id: "txa_0010", jurisdiction: "CO", agency: "co_dor", status: "not_registered" }, { id: "txa_0011", jurisdiction: "CO", agency: "co_cdle", status: "not_registered" }] },
    }));
    expect(r).toMatchObject({ action: "run", derivedArgs: {
      "it.create_account": [{ worker_id: "wrk_0049", system: "chat" }, { worker_id: "wrk_0049", system: "google_ws" }, { worker_id: "wrk_0049", system: "github" }],
      "comms.send_message": { channel: "#new-hires" },
      "tax.register_state_account": [{ tax_account_id: "txa_0010" }, { tax_account_id: "txa_0011" }],
      "it.order_device": { worker_id: "wrk_0049" },
    } });
  });

  it("people_digest posts counts from the precheck to #people-ops", async () => {
    const r = await PRECHECKS.people_digest!(ctx({ slot: "cron:2026-10-26T16:00:00.000Z" }), exec({ "people.search": (a: Record<string, unknown>) => (a.status === "active" ? { total: 48 } : { total: 0 }) }));
    expect(r).toMatchObject({ action: "run", severity: "digest", derivedArgs: { slot: "cron:2026-10-26T16:00:00.000Z", "comms.send_message": { channel: "#people-ops", text: expect.stringContaining("48 active people") } } });
  });

  it("people_digest cites the per-state employee counts that comms grounding knows (contractors carry no state)", async () => {
    const r = await PRECHECKS.people_digest!(ctx({ slot: "cron:2026-10-26T16:00:00.000Z" }), exec({ "people.search": (a: Record<string, unknown>) => (a.status === "active" ? { total: 51, by_state: { TX: 12, CA: 22, NY: 14 } } : { total: 0, by_state: {} }) }));
    expect(r).toMatchObject({ action: "run", findings: { headcount: 48, by_state: { CA: 22, NY: 14, TX: 12 } } });
    const text = (r as { derivedArgs: Record<string, { text: string }> }).derivedArgs["comms.send_message"]!.text;
    expect(text).toBe("Weekly people digest: 48 employees by work state (CA 22, NY 14, TX 12). Open items are in the Weft inbox.");
    expect(text).not.toContain("51");
  });

  it("people_digest counts current employees with a status filter: onboarding and offboarding count, others do not (FM10)", async () => {
    const ex = exec({ "people.search": (a: Record<string, unknown>) => ({ active: { total: 48, by_state: { CA: 22, NY: 14, TX: 12 } }, onboarding: { total: 1, by_state: { CO: 1 } }, offboarding: { total: 1, by_state: { CA: 1 } } } as Record<string, unknown>)[String(a.status)] ?? { total: 99, by_state: { CA: 99 } } });
    const r = await PRECHECKS.people_digest!(ctx({ slot: "cron:2026-10-26T16:00:00.000Z" }), ex);
    expect(ex.seen.filter((s) => s.command === "people.search").map((s) => (s.args as { status: string }).status)).toEqual(["active", "onboarding", "offboarding"]);
    expect(r).toMatchObject({ action: "run", findings: { headcount: 50, by_state: { CA: 23, CO: 1, NY: 14, TX: 12 } } });
    expect((r as { derivedArgs: Record<string, { text: string }> }).derivedArgs["comms.send_message"]!.text).toContain("50 employees by work state (CA 23, CO 1, NY 14, TX 12)");
  });
});
