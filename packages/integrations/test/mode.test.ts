import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configured, constantTimeEqual, hmacSha256, integrationMode, secretsReport } from "../src/index";

function secretsFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "weft-int-"));
  const p = join(dir, "secrets.env");
  writeFileSync(p, body);
  return p;
}

describe("integration mode selection", () => {
  it("is simulated without WEFT_INTEGRATIONS_REAL or without every required secret", () => {
    const f = secretsFile("CHECKR_API_KEY=test_fake\n");
    expect(integrationMode("checkr", { WEFT_SECRETS_FILE: f })).toBe("simulated");
    expect(integrationMode("docusign", { WEFT_SECRETS_FILE: f, WEFT_INTEGRATIONS_REAL: "1" })).toBe("simulated");
    expect(configured("hireright", { WEFT_SECRETS_FILE: f })).toBe(false);
  });
  it("refuses a real adapter inside a test", () => {
    const f = secretsFile("CHECKR_API_KEY=test_fake\n");
    expect(() => integrationMode("checkr", { WEFT_SECRETS_FILE: f, WEFT_INTEGRATIONS_REAL: "1", VITEST: "true" })).toThrow(/LIVE_INTEGRATION_IN_TEST/);
  });
  it("reports secret names as present or missing, never values", () => {
    const f = secretsFile("DOCUSIGN_INTEGRATION_KEY=abc\n# comment\nDOCUSIGN_USER_ID=\n");
    const r = secretsReport("docusign", { WEFT_SECRETS_FILE: f });
    expect(r.find((x) => x.name === "DOCUSIGN_INTEGRATION_KEY")).toEqual({ name: "DOCUSIGN_INTEGRATION_KEY", present: true, optional: false });
    expect(r.find((x) => x.name === "DOCUSIGN_USER_ID")?.present).toBe(false);
    expect(JSON.stringify(r)).not.toContain("abc");
  });
  it("signs the raw bytes and compares in constant time", () => {
    const raw = new TextEncoder().encode('{"action":"ping"}');
    const sig = hmacSha256("k", raw, "hex");
    expect(constantTimeEqual(sig, hmacSha256("k", raw, "hex"))).toBe(true);
    expect(constantTimeEqual(sig, hmacSha256("k", new TextEncoder().encode('{"action": "ping"}'), "hex"))).toBe(false);
  });
});
