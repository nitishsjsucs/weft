// Tests for the auth middleware (owner: t3-governance): Host allowlist, Origin on mutations, scoped keys, dev auth.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "../src/testing";
import { fixtureWeft } from "../../../packages/executor/test/fixtures";

let weft: TestWeft;
beforeEach(async () => { weft = await fixtureWeft(await createTestWeft({ seed: false })); });
afterEach(async () => { await weft.close(); });

describe("auth", () => {
  it("rejects foreign Hosts and foreign Origins on mutations", async () => {
    expect((await weft.app.request("http://attacker.example:4070/v1/proposals", { headers: weft.uiHeaders("usr_dana") })).status).toBe(403);
    const res = await weft.app.request("/v1/proposals/prp_0001/deny", { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), origin: "http://attacker.example" }, body: "{}" });
    expect(res.status).toBe(403);
    const ok = await weft.app.request("/v1/proposals/prp_0001/deny", { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), origin: "http://localhost:3070" }, body: "{}" });
    expect(ok.status).toBe(422);
  });
  it("requires a session, a valid key, and the proxy secret for x-weft-principal", async () => {
    expect((await weft.app.request("/v1/proposals")).status).toBe(401);
    expect((await weft.app.request("/v1/proposals", { headers: { "x-api-key": "weft_sk_nope" } })).status).toBe(401);
    expect((await weft.app.request("/v1/proposals", { headers: { "x-weft-principal": "usr_dana" } })).status).toBe(401);
    expect((await weft.app.request("/v1/proposals", { headers: weft.uiHeaders("svc_events") })).status).toBe(401);
  });
  it("mcp-scope keys get 403 on decision, rollback, settings, api-keys and sim routes", async () => {
    const mcp = readFileSync(join(weft.dataDir, "demo-mcp-key.txt"), "utf8").trim();
    const h = { "x-api-key": mcp, "content-type": "application/json" };
    for (const [m, p] of [["POST", "/v1/proposals/prp_0001/approve"], ["POST", "/v1/proposals/prp_0001/deny"], ["POST", "/v1/proposals/prp_0001/dismiss"], ["POST", "/v1/proposals/prp_0001/start"],
      ["POST", "/v1/actions/1/rollback"], ["GET", "/v1/settings/permissions"], ["PUT", "/v1/settings/agent-grants"], ["POST", "/v1/api-keys"], ["GET", "/v1/sim/state"], ["POST", "/v1/sim/reset"]] as const) {
      expect((await weft.app.request(p, { method: m, headers: h, body: m === "GET" ? undefined : "{}" })).status, `${m} ${p}`).toBe(403);
    }
    expect((await weft.app.request("/v1/proposals", { headers: h })).status).toBe(200);
  });
  it("rate limits 60 requests per minute per API key", async () => {
    const admin = readFileSync(join(weft.dataDir, "demo-api-key.txt"), "utf8").trim();
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await weft.app.request("/v1/events", { headers: { "x-api-key": admin } })).status;
    expect(last).toBe(429);
  });
});
