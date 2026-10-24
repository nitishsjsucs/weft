// Greenhouse simulator (w3-integrations-hr): Harvest v3 shapes (bare arrays, Link cursor that must stand alone,
// rate-limit headers and the 429 fault, versioned offers with current_only), signed hire_candidate deliveries over
// the raw bytes with the vendor's escaping, the retry schedule on the sim clock, and the empty-offers permission gap.
import { afterEach, describe, expect, it } from "vitest";
import type { W3GreenhouseSimControls } from "@weft/contracts";
import { createSimulators } from "../../src/index";
import { simWorld, type SimTestWorld } from "../helpers";

let w: SimTestWorld | null = null;
afterEach(async () => { await w?.close(); w = null; });
async function gh() {
  w = await simWorld();
  const sims = createSimulators({ db: w.db, clock: w.clock });
  const g = sims.vendors.greenhouse as typeof sims.vendors.greenhouse & W3GreenhouseSimControls;
  await g.seedLarkspur();
  return { sims, g };
}
const enc = (s: string) => new TextEncoder().encode(s);

describe("greenhouse simulator", () => {
  it("lists bare arrays by id descending with a Link cursor that must be the only query parameter", async () => {
    const { g } = await gh();
    const first = await g.harvest("/v3/jobs", { per_page: "2" });
    expect(first.status).toBe(200);
    expect(Array.isArray(first.body)).toBe(true);
    expect((first.body as { id: number }[]).map((j) => j.id)).toEqual([4_400_103, 4_400_102]);
    expect(first.headers).toMatchObject({ "x-ratelimit-limit": "75", "x-ratelimit-remaining": "74" });
    const cursor = /cursor=([^>]+)>; rel="next"/.exec(first.headers.link!)![1]!;
    const next = await g.harvest("/v3/jobs", { cursor });
    expect((next.body as { id: number }[]).map((j) => j.id)).toEqual([4_400_101]);
    expect(next.headers.link).toBeUndefined();
    expect((await g.harvest("/v3/jobs", { cursor, per_page: "2" })).status).toBe(422);
    expect((await g.harvest("/v3/jobs", { cursor: "not-a-cursor" })).status).toBe(422);
    expect((await g.harvest("/v3/jobs", { per_page: "501" })).status).toBe(422);
  });

  it("answers 429 with Retry-After under the rate-limit fault", async () => {
    const { sims, g } = await gh();
    await sims.faults.arm({ target: "greenhouse.rateLimit", kind: "error", mode: "once" });
    const r = await g.harvest("/v3/applications", {});
    expect([r.status, r.headers["retry-after"], r.headers["x-ratelimit-remaining"]]).toEqual([429, "3", "0"]);
    expect((await g.harvest("/v3/applications", {})).status).toBe(200);
  });

  it("a simulated hire reads back normalized, and a start date change is a new offer version (current_only)", async () => {
    const { g } = await gh();
    const h = await g.simulate("hire");
    const hire = await g.getHire(h.applicationId);
    expect(hire).toMatchObject({ applicationId: h.applicationId, offerVersion: 1, first: "Marisol", last: "Quint", email: "marisol.quint@candidate.example", jobName: "Firmware Test Engineer", departmentExtId: "3300102", officeExtId: "2200109", startDate: "2026-11-16", salary: { amountMinor: 13_200_000, currency: "USD" } });
    const c = await g.simulate("start_date_change", { applicationId: h.applicationId });
    expect(c.offerVersion).toBe(2);
    const all = (await g.harvest("/v3/offers", { application_ids: h.applicationId })).body as { version: number; status: string }[];
    expect(all.map((o) => `${o.version}:${o.status}`)).toEqual(["2:Accepted", "1:Deprecated"]);
    const current = (await g.harvest("/v3/offers", { application_ids: h.applicationId, current_only: "true" })).body as { version: number; starts_on: string }[];
    expect(current).toEqual([expect.objectContaining({ version: 2, starts_on: "2026-11-30" })]);
    expect((await g.listHires({ updatedAfter: null, cursor: null })).items.map((x) => x.offerVersion)).toEqual([2]);
  });

  it("signs the raw bytes: the stored body verifies, a re-serialized one does not, and the event id is the dedupe key", async () => {
    const { g } = await gh();
    await g.simulate("hire");
    const [d] = await g.dueDeliveries(w!.clock.now());
    expect(d!.raw).toContain("\\u0026");   // the vendor escapes &, < and > before signing
    expect(g.verifyWebhook(enc(d!.raw), d!.headers)).toEqual({ ok: true, dedupeKey: d!.dedupeKey });
    expect(g.verifyWebhook(enc(JSON.stringify(JSON.parse(d!.raw))), d!.headers).ok).toBe(false);
    expect(g.verifyWebhook(enc(d!.raw), { ...d!.headers, signature: "sha256 " + "0".repeat(64) }).ok).toBe(false);
    expect(g.parseWebhook(enc(d!.raw))).toEqual({ action: "hire_candidate", applicationId: expect.stringMatching(/^\d+$/) });
  });

  it("retries a failed delivery on the 7-attempt schedule of the sim clock, then gives up", async () => {
    const { g } = await gh();
    await g.simulate("hire");
    const [d] = await g.dueDeliveries(w!.clock.now());
    const t0 = w!.clock.now();
    const plus = (m: number) => new Date(Date.parse(t0) + m * 60_000).toISOString();
    const seen: (string | null)[] = [];
    for (let i = 0; i < 7; i++) seen.push((await g.recordAttempt(d!.id, false, w!.clock.now())).nextAt);
    expect(seen).toEqual([plus(1), plus(16), plus(76), plus(196), plus(436), plus(916), null]);
    expect(await g.dueDeliveries(plus(2000))).toEqual([]);
  });

  it("the offers-hidden fault is the permission gap: the hire reads as null and the test reports it", async () => {
    const { sims, g } = await gh();
    const h = await g.simulate("hire");
    await sims.faults.arm({ target: "greenhouse.offersHidden", kind: "error", mode: "always" });
    expect(await g.getHire(h.applicationId)).toBeNull();
    expect(await g.testConnection()).toMatchObject({ health: "permission_gap", detail: "offers_hidden_by_permissions", mode: "simulated" });
  });
});
