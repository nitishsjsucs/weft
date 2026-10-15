// Contract tests for /v1/memory (owner: t3-governance): the read-only memory browser.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "../src/testing";
import { fixtureWeft } from "../../../packages/executor/test/fixtures";

let weft: TestWeft;
beforeEach(async () => { weft = await fixtureWeft(await createTestWeft({ seed: false })); });
afterEach(async () => { await weft.close(); });
const get = (p: string) => weft.app.request(p, { headers: weft.uiHeaders("usr_sam") });

describe("/v1/memory", () => {
  it("tree, file and search", async () => {
    const tree = await (await get("/v1/memory/tree?prefix=knowledge/")).json();
    expect(tree).toContain("knowledge/procedures/state-sui-rate-notice.md");
    const file = await (await get("/v1/memory/file?path=knowledge/procedures/state-sui-rate-notice.md")).json();
    expect(file.frontmatter).toMatchObject({ type: "procedure", sources: ["seed"] });
    const hits = await (await get("/v1/memory/search?q=SUI&folders=knowledge")).json();
    expect(hits[0]).toMatchObject({ path: "knowledge/procedures/state-sui-rate-notice.md" });
  });
  it("rejects traversal, a non-hex at and unknown folders", async () => {
    expect((await get("/v1/memory/file?path=knowledge/../.git/config")).status).toBe(400);
    expect((await get("/v1/memory/search?q=x&at=HEAD")).status).toBe(400);
    expect((await get("/v1/memory/search?q=x&folders=.git")).status).toBe(400);
    expect((await get("/v1/memory/file?path=knowledge/nope.md")).status).toBe(404);
  });
});
