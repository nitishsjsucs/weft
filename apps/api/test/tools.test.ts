// Contract tests for /v1/tools (owner: t3-governance).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "../src/testing";
import { fixtureWeft } from "../../../packages/executor/test/fixtures";

let weft: TestWeft;
beforeEach(async () => { weft = await fixtureWeft(await createTestWeft({ seed: false })); });
afterEach(async () => { await weft.close(); });

describe("/v1/tools", () => {
  it("the mcp surface lists read and propose tools with strict schemas and nothing hidden", async () => {
    const mcp = readFileSync(join(weft.dataDir, "demo-mcp-key.txt"), "utf8").trim();
    const list = await (await weft.app.request("/v1/tools?surface=main", { headers: { "x-api-key": mcp } })).json() as { name: string; mcp: string; parameters: { additionalProperties: boolean } }[];
    expect(list.every((t) => t.mcp !== "hidden")).toBe(true);
    expect(list.map((t) => t.name)).not.toContain("memory__write_note");
    expect(list.map((t) => t.name)).not.toContain("tax__revert_rate");
    expect(list.every((t) => t.parameters.additionalProperties === false)).toBe(true);
  });
  it("a UI session executes directly as the human; an mcp key proposes", async () => {
    const ui = await weft.app.request("/v1/tools/tax__update_rate", { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify({ rate_id: "etr_0001", rate: "0.02" }) });
    expect(await ui.json()).toMatchObject({ ok: true, status: "done", actionSeq: 1 });
    const mcp = readFileSync(join(weft.dataDir, "demo-mcp-key.txt"), "utf8").trim();
    const p = await weft.app.request("/v1/tools/tax__update_rate", { method: "POST", headers: { "x-api-key": mcp, "content-type": "application/json" }, body: JSON.stringify({ rate_id: "etr_0001", rate: "0.015" }) });
    expect(await p.json()).toMatchObject({ ok: true, status: "pending_approval" });
  });
});
