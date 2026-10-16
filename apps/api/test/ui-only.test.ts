// The background check review and the adverse action steps are ui_only: a cli or admin API key cannot reach them
// through POST /v1/tools/:name (the dedicated adjudicate route is ui_only too).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });

describe("ui_only screening commands", () => {
  it("refuse an API key with NOT_PERMITTED", async () => {
    const res = await weft.app.request("/v1/api-keys", { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify({ label: "script", scope: "cli" }) });
    expect(res.status).toBe(201);
    const key = (await res.json()).plaintext as string;
    for (const name of ["screening.review", "screening.engage", "screening.start_pre_adverse", "screening.send_final_adverse", "screening.cancel_adverse", "screening.proceed_to_criminal"]) {
      const out = await weft.app.request(`/v1/tools/${name}`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ order_id: "scr_0001" }) });
      expect([out.status, (await out.json()).code], name).toEqual([422, "NOT_PERMITTED"]);
    }
  });
});
