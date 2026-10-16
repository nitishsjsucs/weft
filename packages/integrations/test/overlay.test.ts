// The real-adapter overlay (docs/wave3.md 3.1): without WEFT_INTEGRATIONS_REAL or without every secret the simulated
// connectors pass through untouched; asking for a real adapter inside a test throws LIVE_INTEGRATION_IN_TEST.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VendorConnectors } from "@weft/contracts";
import { createVendorOverlay, integrationModes } from "../src/index";

const fakeSims = () => Object.fromEntries(["greenhouse", "workday", "checkr", "hireright", "docusign"].map((v) => [v, { tag: `sim-${v}` }])) as unknown as VendorConnectors;
const secrets = (body: string) => { const d = mkdtempSync(join(tmpdir(), "weft-ovl-")); const p = join(d, "s.env"); writeFileSync(p, body); return p; };

describe("vendor overlay", () => {
  it("keeps every simulated connector without WEFT_INTEGRATIONS_REAL, even with secrets present", () => {
    const f = secrets("WEFT_GREENHOUSE_CLIENT_ID=id\nWEFT_GREENHOUSE_CLIENT_SECRET=s\n");
    const sims = fakeSims();
    const out = createVendorOverlay({ WEFT_SECRETS_FILE: f })(sims);
    for (const v of Object.keys(sims) as (keyof VendorConnectors)[]) expect(out[v]).toBe(sims[v]);
    expect(Object.values(integrationModes({ WEFT_SECRETS_FILE: f }))).toEqual(["simulated", "simulated", "simulated", "simulated", "simulated"]);
  });
  it("keeps the simulator with WEFT_INTEGRATIONS_REAL=1 but a secret missing", () => {
    const f = secrets("WEFT_GREENHOUSE_CLIENT_ID=id\n");
    const sims = fakeSims();
    expect(createVendorOverlay({ WEFT_SECRETS_FILE: f, WEFT_INTEGRATIONS_REAL: "1" })(sims).greenhouse).toBe(sims.greenhouse);
  });
  it("throws LIVE_INTEGRATION_IN_TEST when a real adapter would run inside a test", () => {
    const f = secrets("WEFT_GREENHOUSE_CLIENT_ID=id\nWEFT_GREENHOUSE_CLIENT_SECRET=s\n");
    expect(() => createVendorOverlay({ WEFT_SECRETS_FILE: f, WEFT_INTEGRATIONS_REAL: "1", VITEST: "true" })).toThrow(/LIVE_INTEGRATION_IN_TEST/);
    expect(() => createVendorOverlay({ WEFT_SECRETS_FILE: f, WEFT_INTEGRATIONS_REAL: "1" }, { testMode: true })).toThrow(/LIVE_INTEGRATION_IN_TEST/);
  });
});
