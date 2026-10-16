import { describe, expect, it } from "vitest";
import { CHAT_ACT_TOOLS, CHAT_TOOLS, CHAT_TOOLS_W3, EXPENSE_BANDS, ExpenseStatus, ID_PREFIXES, INTEGRATION_SECRETS, IntegrationVendor, OFFER_TRANSITIONS_W3, parseEventBody, ROUTES, VENDOR_CATEGORY, W3_PLANNED_COMMANDS, WAVE3_EVENT_TYPES, WAVE3_ID_PREFIXES } from "../src/index";

describe("wave 3 scaffold contracts", () => {
  it("planned commands are unique, and model-facing writes are always proposals", () => {
    const names = W3_PLANNED_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of W3_PLANNED_COMMANDS.filter((x) => x.access === "all" && ["R2", "R4"].includes(x.risk))) expect(c.approval, c.name).toBe("always");
    expect(names.some((n) => /approve_all|bulk/.test(n))).toBe(false);
    expect(W3_PLANNED_COMMANDS.filter((c) => /adverse|engage|review|proceed/.test(c.name)).every((c) => c.access === "human_only")).toBe(true);
  });
  it("chat allowlists stay within the 16-tool cap and chat_act writes are proposal-only commands", () => {
    expect(CHAT_TOOLS).toHaveLength(14);
    expect(CHAT_TOOLS_W3.length).toBeLessThanOrEqual(16);
    expect(CHAT_ACT_TOOLS.length).toBeLessThanOrEqual(16);
    const planned = new Map(W3_PLANNED_COMMANDS.map((c) => [c.name, c]));
    for (const t of ["expenses.decide", "time_off.decide"] as const) expect(planned.get(t)?.approval).toBe("always");
  });
  it("every expense status sits in exactly one band", () => {
    for (const s of ExpenseStatus.options) expect(Object.values(EXPENSE_BANDS).filter((b) => b.includes(s)), s).toHaveLength(1);
  });
  it("new id prefixes are registered once and wave 3 events parse with id-only payloads", () => {
    for (const p of WAVE3_ID_PREFIXES) expect(ID_PREFIXES.filter((x) => x === p), p).toHaveLength(1);
    expect(new Set(ID_PREFIXES).size).toBe(ID_PREFIXES.length);
    expect(WAVE3_EVENT_TYPES).toContain("expense.submitted");
    expect(parseEventBody({ type: "time_off.request.created", payload: { request_id: "tor_0001", worker_id: "wrk_0012" } }).type).toBe("time_off.request.created");
    expect(() => parseEventBody({ type: "expense.submitted", payload: { expense_id: "exp_0001", worker_id: "wrk_0001", note: "free text" } })).toThrow();
  });
  it("integrations cover the five vendors and offers can be declined only before acceptance", () => {
    expect(IntegrationVendor.options.sort()).toEqual(["checkr", "docusign", "greenhouse", "hireright", "workday"]);
    for (const v of IntegrationVendor.options) { expect(VENDOR_CATEGORY[v]).toBeTruthy(); expect(Array.isArray(INTEGRATION_SECRETS[v])).toBe(true); }
    expect(OFFER_TRANSITIONS_W3.viewed).toContain("declined");
    expect(OFFER_TRANSITIONS_W3.accepted).toEqual([]);
    expect(ROUTES.find((r) => r.path === "/v1/integrations/:vendor/webhook")?.auth).toBe("public");
  });
});
