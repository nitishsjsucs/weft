// The redactor learns provider keys that come only from WEFT_SECRETS_FILE (harness 6.4), not just process.env ones.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft | null = null;
let dir: string | null = null;
const saved = process.env.WEFT_SECRETS_FILE;
afterEach(async () => {
  await weft?.close();
  weft = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.WEFT_SECRETS_FILE; else process.env.WEFT_SECRETS_FILE = saved;
});

describe("secrets file redaction", () => {
  it("redacts an OPENAI_API_KEY that only the secrets file holds", async () => {
    dir = mkdtempSync(join(tmpdir(), "weft-secrets-"));
    const key = "sk-test-redactme-0123456789abcdefghijklmnop";
    writeFileSync(join(dir, "secrets.env"), `OPENAI_API_KEY=${key}\n`);
    process.env.WEFT_SECRETS_FILE = join(dir, "secrets.env");
    expect(process.env.OPENAI_API_KEY ?? "").not.toBe(key);
    weft = await createTestWeft({ seed: false });
    expect(weft.executor.redact(`the key is ${key}`)).not.toContain(key);
  });
});
