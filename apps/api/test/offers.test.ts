// Contract tests for /v1/offers and the t2 registry rules (owner: t2-world).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Offer, Page } from "@weft/contracts";
import { commands, directExecutors, ensureTestPrincipals, nonEmptyUntrusted, findCommand } from "@weft/core";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); await ensureTestPrincipals(weft.db); });
afterAll(async () => { await weft.close(); });

const T2 = ["people.", "onboarding.", "tax.", "notices.", "benefits.", "it.", "comms.send_message", "sim."];
const t2 = commands.filter((c) => T2.some((p) => c.name.startsWith(p)));

describe("GET /v1/offers", () => {
  it("lists Noor's sent, HR-entered offer", async () => {
    const page = Page(Offer).parse(await (await weft.app.request("/v1/offers", { headers: weft.uiHeaders("usr_dana") })).json());
    expect(page.data).toEqual([expect.objectContaining({ id: "offr_0001", candidateFirst: "Noor", candidateLast: "Castellanos", title: "Senior Firmware Engineer", workState: "CO", status: "sent", managerId: "wrk_0004", base: { amount: 16_800_000, currency: "USD", display: "$168,000.00" }, startDate: "2026-11-02" })]);
  });
  it("POST accept goes through the executor (501 while it is a stub)", async () => {
    const res = await weft.app.request("/v1/offers/offr_0001/accept", { method: "POST", headers: weft.uiHeaders("usr_dana") });
    expect(weft.stubs.includes("executor") ? 501 : 200).toBe(res.status);
  });
});

describe("t2 registry rules (harness 5.4)", () => {
  it("every R2+ command needs approval, R4 never auto-allows, descriptions fit, human and system commands are hidden", () => {
    const samples: Record<string, unknown> = {
      "it.create_account": { worker_id: "wrk_0001", system: "chat" }, "it.order_device": { worker_id: "wrk_0001" },
    };
    for (const c of t2) {
      expect(c.description.length, c.name).toBeLessThanOrEqual(400);
      expect(c.compactDescription.length, c.name).toBeLessThanOrEqual(200);
      const risk = c.risk((samples[c.name] ?? {}) as never);
      if (risk >= "R2") { expect(c.approval, c.name).not.toBe("never"); expect(c.preview ?? c.access !== "all", c.name).toBeTruthy(); }
      if (risk === "R4") expect(c.autoAllow, c.name).toBe("never");
      if (c.access !== "all") { expect(c.tiers, c.name).toEqual({ main: "unavailable", task: "unavailable" }); expect(c.mcp, c.name).toBe("hidden"); }
      if (c.autoAllow === "untainted") expect(risk, c.name).toBe("R3");
    }
    expect(findCommand("it.create_account").risk({ worker_id: "wrk_0001", system: "google_ws", groups: ["workspace-admin"] })).toBe("R4");
    expect(t2.filter((c) => c.autoAllow === "untainted").map((c) => c.name).sort()).toEqual(["comms.send_message", "it.create_account", "onboarding.send_checkins"]);
    expect(findCommand("tax.record_registration").access).toBe("system_only");
    expect(["people.accept_offer", "sim.deliver_notice"].map((n) => findCommand(n).access)).toEqual(["human_only", "human_only"]);
  });

  it("every t2 command parses an all-null-optionals sample (null mapped to undefined)", () => {
    const required: Record<string, Record<string, unknown>> = {
      "people.get": { worker_id: "wrk_0001" }, "people.update_profile": { worker_id: "wrk_0001" }, "people.set_pay_rate": { worker_id: "wrk_0001", amount_cents: 1, effective_from: "2026-11-01" }, "people.revert_pay_rate": { pay_rate_id: "prt_0001" },
      "people.accept_offer": { offer_id: "offr_0001" }, "onboarding.get_checklist": { worker_id: "wrk_0001" }, "onboarding.complete_task": { worker_id: "wrk_0001", kind: "device" },
      "tax.rate_change_impact": { jurisdiction: "CA", code: "sui", new_rate: "0.015" }, "tax.update_rate": { tax_account_id: "txa_0002", code: "sui", rate: "0.015", effective_from: "2026-01-01", source_notice_id: "ntc_0002" },
      "tax.revert_rate": { rate_id: "etr_0001" }, "tax.register_state_account": { tax_account_id: "txa_0006" }, "tax.record_registration": { application_id: "sima_0001" },
      "notices.get": { notice_id: "ntc_0001" }, "notices.draft_response": { notice_id: "ntc_0001" }, "notices.send_response": { notice_id: "ntc_0001" },
      "benefits.get_enrollment": { worker_id: "wrk_0001" }, "it.create_account": { worker_id: "wrk_0001", system: "chat" }, "it.order_device": { worker_id: "wrk_0001" },
      "comms.send_message": { text: "hi" }, "sim.deliver_notice": { scenario: "ca_de2088_rate_change" }, "it.record_delivery": { order_ref: "simd_0001" },
      // wave 3 (w3-parity-routines)
      "notices.escalate": { notice_id: "ntc_0001", reason_code: "missing_filing" }, "onboarding.send_checkins": { send: [], nudge: [] },
      "onboarding.submit_checkin": { checkin_id: "chk_0001", answers: { overall: "good", equipped: "yes", unclear: "", better: "" } },
      // wave 4 (w4-parity-compliance)
      "tax.get_filing": { filing_id: "fil_0001" }, "tax.prepare_filing": { filing_id: "fil_0001" }, "tax.file_return": { filing_id: "fil_0001" },
      "tax.set_deposit_schedule": { tax_account_id: "txa_0001", schedule: "semiweekly", effective_from: "2027-01-01", source_notice_id: "ntc_0002" }, "notices.acknowledge": { notice_id: "ntc_0001" },
      "notices.ingest_upload": { notice_id: "ntc_0001" },
      // wave 4 (w4-parity-people)
      "benefits.report_life_event": { kind: "marriage", event_date: "2026-10-20" }, "benefits.elect_in_window": { window_id: "ewn_0001", elections: [] },
      "onboarding.submit_checkin_form": { checkin_id: "chk_0001", answers: { settled: 4, tools: true, clarity: true } },
      "benefits.open_window": { kind: "open_enrollment", opens_on: "2026-11-02", closes_on: "2026-11-20" }, "comms.send_first_day_message": { worker_ids: ["wrk_0049"] },
    };
    for (const c of t2) {
      const shape = (c.input as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      const sample = Object.fromEntries(Object.keys(shape).map((k) => [k, required[c.name]?.[k] ?? null]));
      const mapped = JSON.parse(JSON.stringify(sample), (_k, v) => (v === null ? undefined : v));
      expect(c.input.safeParse(mapped).success, c.name).toBe(true);
    }
  });

  it("the people digest allowlist cannot taint in concise reads", async () => {
    const d = directExecutors(weft.db, weft.clock, weft.sims);
    const out = await d.readOnly.exec("cmp_larkspur", "people.search", {});
    expect(out.ok && nonEmptyUntrusted(findCommand("people.search"), (out as { data: unknown }).data)).toEqual([]);
  });
});
