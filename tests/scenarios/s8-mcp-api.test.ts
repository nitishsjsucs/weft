// Scenario s8 (SPEC 12, 13). Owner: t3-governance. S8 MCP stdio and REST API with scoped keys.
// Drives apps/mcp in process (InMemoryTransport) against the Hono app with the seeded mcp key; ends by verifying the
// action chain and the memory repo SHA.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "./helpers";
import { fixtureWeft } from "../../packages/executor/test/fixtures";
import { Client, createMcpServer, InMemoryTransport } from "../../apps/mcp/src/testing";

let weft: TestWeft;
let client: InstanceType<typeof Client>;
let mcpKey: string;
beforeEach(async () => {
  weft = await fixtureWeft(await createTestWeft({ seed: false }));
  mcpKey = readFileSync(join(weft.dataDir, "demo-mcp-key.txt"), "utf8").trim();
  const server = createMcpServer({ apiUrl: "http://127.0.0.1:4070", apiKey: mcpKey }, (u, i) => Promise.resolve(weft.app.request(u, i)));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "s8", version: "0.0.0" });
  await client.connect(ct);
});
afterEach(async () => { await client.close(); await weft.close(); });

describe("S8 MCP stdio and REST API with scoped keys", () => {
  it("runs end to end: lists read and propose tools only, tax__update_rate returns a proposal id, the mcp key gets 403 on decisions", async () => {
    expect(client.getInstructions()).toMatch(/fictional/);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["tax__update_rate", "notices__get", "people__search", "memory__search", "actions__list", "agent_ask"]));
    for (const n of names) expect(n).not.toMatch(/approve|deny|rollback|vault|settings|api_key|write_note|routines__enable/);
    expect(tools.find((t) => t.name === "people__search")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

    const r = await client.callTool({ name: "tax__update_rate", arguments: { rate_id: "etr_0001", rate: "0.015", source_notice_id: null } });
    const outcome = JSON.parse((r.content as { text: string }[])[0]!.text);
    expect(outcome).toMatchObject({ ok: true, status: "pending_approval", tainted: true });
    expect(outcome.proposalId).toMatch(/^prp_\d{4}$/);
    const read = await client.callTool({ name: "notices__get", arguments: { notice_id: "ntc_0001" } });
    expect((read.content as { text: string }[])[0]!.text).toContain("<untrusted n=");

    const post = (path: string, body: unknown = {}) => weft.app.request(path, { method: "POST", headers: { "x-api-key": mcpKey, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post(`/v1/proposals/${outcome.proposalId}/approve`)).status).toBe(403);
    expect((await post(`/v1/actions/1/rollback`, { reason: "x" })).status).toBe(403);
    expect((await post(`/v1/api-keys`, { label: "x", scope: "admin" })).status).toBe(403);
    expect((await weft.app.request("/v1/settings/permissions", { headers: { "x-api-key": mcpKey } })).status).toBe(403);
    expect((await weft.app.request("/v1/sim/state", { headers: { "x-api-key": mcpKey } })).status).toBe(403);
    const hidden = await weft.app.request("/v1/tools/vault__list", { method: "POST", headers: { "x-api-key": mcpKey, "content-type": "application/json" }, body: "{}" });
    expect(await hidden.json()).toMatchObject({ code: "UNAVAILABLE" });

    const approve = await weft.app.request(`/v1/proposals/${outcome.proposalId}/approve`, { method: "POST", headers: { ...weft.uiHeaders("usr_theo"), "content-type": "application/json" }, body: "{}" });
    expect(await approve.json()).toMatchObject({ ok: true, proposal: { status: "executed" } });
  });

  it("the admin key lists the main surface; the API key plaintext never comes back in a response", async () => {
    const admin = readFileSync(join(weft.dataDir, "demo-api-key.txt"), "utf8").trim();
    const res = await weft.app.request("/v1/tools?surface=main", { headers: { "x-api-key": admin } });
    const list = await res.json() as { name: string }[];
    expect(list.map((t) => t.name)).toContain("comms__post_update");
    const echo = await weft.app.request("/v1/tools/comms__post_update", { method: "POST", headers: { "x-api-key": admin, "content-type": "application/json" }, body: JSON.stringify({ text: `key ${admin}` }) });
    expect(await echo.text()).not.toContain(admin);
  });

  it("verifies the action chain and the memory SHA", async () => {
    expect((await weft.executor.verifyChain()).ok).toBe(true);
    expect(await weft.executor.memory.head()).toMatch(/^[0-9a-f]{40}$/);
  });
});
