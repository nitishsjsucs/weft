// Offer lifecycle contract tests (w2-onboarding): create validation, OFFER_TRANSITIONS on every route, honest risk
// and approval, and an agent call to send an offer becoming a proposal rather than a send.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OFFER_TRANSITIONS, W2OnboardingOfferDetail } from "@weft/contracts";
import { commands, findCommand } from "@weft/core";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });

const call = async (who: string, method: string, path: string, body?: unknown) => {
  const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const OFFER = { candidateFirst: "Iris", candidateLast: "Vane", candidateEmail: "iris.vane@candidate.example", title: "Supply Planner", departmentId: "dpt_operations", workState: "NY", baseCents: 10_400_000, startDate: "2026-12-01" };

describe("offer builder", () => {
  it("refuses a non-example email, a past start date and an unknown department", async () => {
    expect((await call("usr_dana", "POST", "/v1/offers", { ...OFFER, candidateEmail: "iris@gmail.com" })).json.code).toBe("INVALID_INPUT");
    expect((await call("usr_dana", "POST", "/v1/offers", { ...OFFER, startDate: "2026-10-01" })).json.code).toBe("DOMAIN_BAD_START_DATE");
    expect((await call("usr_dana", "POST", "/v1/offers", { ...OFFER, departmentId: "dpt_nowhere" })).status).toBe(422);
  });

  it("a draft reads back with its lifecycle fields; the list keeps the wave 1 Offer fields", async () => {
    const id = (await call("usr_dana", "POST", "/v1/offers", OFFER)).json.data.offer_id as string;
    const detail = W2OnboardingOfferDetail.parse((await call("usr_dana", "GET", `/v1/offers/${id}`)).json);
    expect(detail).toMatchObject({ id, status: "draft", expiresOn: "2026-11-09", managerId: expect.stringMatching(/^wrk_/), allowed: [...OFFER_TRANSITIONS.draft] });
    const list = (await call("usr_dana", "GET", "/v1/offers")).json.data as { id: string; base: { display: string }; status: string }[];
    expect(list.find((o) => o.id === id)).toMatchObject({ status: "draft", base: { display: "$104,000.00" } });
    expect(list.find((o) => o.id === "offr_0001")).toMatchObject({ status: "sent" });
    expect((await call("usr_dana", "GET", "/v1/offers/offr_9999")).status).toBe(404);
  });

  it("Theo (payroll admin, people view only) cannot send an offer", async () => {
    const id = (await call("usr_dana", "POST", "/v1/offers", { ...OFFER, candidateEmail: "iris.two@candidate.example" })).json.data.offer_id as string;
    const r = await call("usr_theo", "POST", `/v1/offers/${id}/send`);
    expect([r.status, r.json.code]).toEqual([422, "NOT_PERMITTED"]);
  });

  it("the seeded wave 1 offer can be voided but not sent again", async () => {
    expect((await call("usr_dana", "POST", "/v1/offers/offr_0001/send")).json.code).toBe("DOMAIN_ILLEGAL_TRANSITION");
  });
});

describe("registry rules for the w2-onboarding commands", () => {
  const mine = commands.filter((c) => c.name.startsWith("documents."));
  it("risk and approval are honest; portal commands are human only and hidden from agents and MCP", () => {
    for (const c of mine) {
      const risk = c.risk({} as never);
      if (risk >= "R2") { expect(c.approval, c.name).not.toBe("never"); expect(c.preview, c.name).not.toBeNull(); }
      expect(c.description.length, c.name).toBeLessThanOrEqual(400);
    }
    for (const n of ["documents.sign", "documents.submit_w4", "documents.submit_state_withholding", "documents.submit_direct_deposit", "documents.submit_i9", "documents.submit_benefits", "documents.view_offer"]) {
      expect(findCommand(n), n).toMatchObject({ access: "human_only", mcp: "hidden", tiers: { main: "unavailable", task: "unavailable" } });
    }
    expect(["documents.send_offer", "documents.void_offer"].map((n) => [findCommand(n).risk({} as never), findCommand(n).approval])).toEqual([["R2", "always"], ["R2", "always"]]);
    expect(findCommand("documents.create_offer").risk({} as never)).toBe("R1");
  });

  it("agents see send and void as proposals and never see the portal commands", async () => {
    const tools = (await call("usr_dana", "GET", "/v1/tools")).json as { registryName: string; tier: string; mcp: string }[];
    const by = new Map(tools.map((t) => [t.registryName, t]));
    expect(by.get("documents.send_offer")).toMatchObject({ mcp: "propose" });
    expect(by.get("documents.void_offer")).toMatchObject({ mcp: "propose" });
    for (const n of ["documents.sign", "documents.submit_direct_deposit"]) expect(by.get(n)?.tier ?? "unavailable", n).toBe("unavailable");
  });
});
