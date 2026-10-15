import { describe, expect, it } from "vitest";
import type { ReadOnlyExecutor, ToolOutcome } from "@weft/contracts";
import { PRECHECKS } from "../src/index";

const done = (data: unknown): ToolOutcome => ({ ok: true, status: "done", resultId: "res_1", data, summary: "ok", actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" });
const exec = (answers: Record<string, unknown>): ReadOnlyExecutor & { seen: { command: string; args: unknown }[] } => {
  const seen: { command: string; args: unknown }[] = [];
  return { seen, async exec(_c, command, args) { seen.push({ command, args }); return done(answers[command] ?? {}); } };
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

  it("agency_notice skips a notice that is not a rate change", async () => {
    const r = await PRECHECKS.agency_notice!(ctx({ notice_id: "ntc_0002" }), exec({ "notices.get": { notice: { id: "ntc_0002", kind: "missing_filing", extracted: { rates: [] } } } }));
    expect(r.action).toBe("skip");
  });

  it("new_hire derives accounts, the welcome, registrations for unregistered accounts and the laptop", async () => {
    const r = await PRECHECKS.new_hire!(ctx({ worker_id: "wrk_0049", offer_id: "offr_0001" }), exec({
      "people.get": { worker: { id: "wrk_0049", name: "Noor Castellanos (demo) (wrk_0049)", work_state: "CO" } },
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
    const r = await PRECHECKS.people_digest!(ctx({ slot: "cron:2026-10-26T16:00:00.000Z" }), exec({ "people.search": { total: 48 } }));
    expect(r).toMatchObject({ action: "run", severity: "digest", derivedArgs: { slot: "cron:2026-10-26T16:00:00.000Z", "comms.send_message": { channel: "#people-ops", text: expect.stringContaining("48 active people") } } });
  });

  it("people_digest cites the per-state employee counts that comms grounding knows (contractors carry no state)", async () => {
    const r = await PRECHECKS.people_digest!(ctx({ slot: "cron:2026-10-26T16:00:00.000Z" }), exec({ "people.search": { total: 51, by_state: { TX: 12, CA: 22, NY: 14 } } }));
    expect(r).toMatchObject({ action: "run", findings: { headcount: 48, by_state: { CA: 22, NY: 14, TX: 12 } } });
    const text = (r as { derivedArgs: Record<string, { text: string }> }).derivedArgs["comms.send_message"]!.text;
    expect(text).toBe("Weekly people digest: 48 employees by work state (CA 22, NY 14, TX 12). Open items are in the Weft inbox.");
    expect(text).not.toContain("51");
  });
});
