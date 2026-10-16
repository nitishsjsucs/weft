// HireRight simulator (w3-integrations-screening-esign): labeled "Simulated, API shape not published", Weft's normalized
// event shape, the same state machine and signed deliveries as the Checkr simulator.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFaults } from "../../src/faults";
import { createHireRightSim, HIRERIGHT_SIM_LABEL } from "../../src/vendors/hireright";
import { w3ScreeningSimControls } from "../../../contracts/src/ext/w3-integrations-screening-esign";
import { simWorld, type SimTestWorld } from "../helpers";

let w: SimTestWorld;
beforeEach(async () => { w = await simWorld(); });
afterEach(async () => { await w.close(); });

describe("HireRight simulator", () => {
  it("is labeled as unpublished, runs invited to clear, and signs every delivery", async () => {
    const s = createHireRightSim(w.db, w.clock, createFaults(w.db)), c = w3ScreeningSimControls(s)!;
    expect(await s.status()).toMatchObject({ vendor: "hireright", mode: "simulated", detail: HIRERIGHT_SIM_LABEL });
    expect(HIRERIGHT_SIM_LABEL).toBe("Simulated, API shape not published");
    const o = await s.createOrder({ orderId: "scr_0001", candidate: { first: "A", last: "B", email: "a.b@candidate.example" }, packageSlug: "hr_standard_sim", workLocation: { country: "US", state: "TX", city: "Austin" } });
    await c.consent(o.vendorOrderId, "A B");
    await c.advance("2026-10-27T15:30:00.000Z");
    expect((await s.getOrder(o.vendorOrderId)).status).toBe("complete_clear");
    const out = await c.outbox(w.clock.now() > "2026-10-27" ? w.clock.now() : "2026-10-27T15:30:00.000Z");
    expect(out.length).toBeGreaterThan(0);
    for (const d of out) {
      const raw = new TextEncoder().encode(d.raw);
      expect(s.verifyWebhook(raw, d.headers).ok).toBe(true);
      expect(JSON.parse(d.raw)).toMatchObject({ simulated: HIRERIGHT_SIM_LABEL });
      expect(s.parseWebhook(raw)[0]).toMatchObject({ dedupeKey: d.dedupeKey });
      expect(s.verifyWebhook(new TextEncoder().encode(JSON.stringify(JSON.parse(d.raw), null, 2)), d.headers).ok).toBe(false);
    }
  });
});
