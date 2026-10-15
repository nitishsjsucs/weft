// Contract tests for POST /v1/api-keys (owner: t3-governance).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "../src/testing";
import { fixtureWeft } from "../../../packages/executor/test/fixtures";

let weft: TestWeft;
beforeEach(async () => { weft = await fixtureWeft(await createTestWeft({ seed: false })); });
afterEach(async () => { await weft.close(); });
const create = (h: Record<string, string>, body: unknown) => weft.app.request("/v1/api-keys", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /v1/api-keys", () => {
  it("creates a key shown once that authenticates with its scope; non-admins get 403", async () => {
    expect((await create(weft.uiHeaders("usr_sam"), { label: "x", scope: "cli" })).status).toBe(403);
    const res = await create(weft.uiHeaders("usr_dana"), { label: "laptop cli", scope: "cli" });
    expect(res.status).toBe(201);
    const key = await res.json();
    expect(key.plaintext).toMatch(/^weft_sk_[0-9a-f]{48}$/);
    const rows = await weft.db.all<{ hash: string }>(`SELECT hash FROM api_keys WHERE id = '${key.id}'` as never);
    expect(rows[0]!.hash).not.toContain(key.plaintext);
    const tools = await weft.app.request("/v1/tools?surface=main", { headers: { "x-api-key": key.plaintext } });
    expect(tools.status).toBe(200);
    expect(weft.executor.redact(`leak ${key.plaintext}`)).not.toContain(key.plaintext);
  });
});
