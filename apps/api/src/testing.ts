// Test harness (SPEC 9.0): createTestWeft() builds a seeded world on a temp data dir with a frozen clock and the
// scripted provider; uiHeaders() adds x-weft-principal and the generated x-weft-proxy. Re-exported by tests/scenarios/helpers.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@weft/contracts";
import { seedWorld } from "@weft/seed";
import { createWeft, type Weft } from "./compose";

export interface TestWeft extends Weft { uiHeaders(principalId: string): Record<string, string> }
export interface CreateTestWeftOptions { seed?: boolean; provider?: ModelProvider }

let current: TestWeft | null = null;

export async function createTestWeft(opts: CreateTestWeftOptions = {}): Promise<TestWeft> {
  const dataDir = mkdtempSync(join(tmpdir(), "weft-test-"));
  const weft = await createWeft({ dataDir, testMode: true, provider: opts.provider });
  if (opts.seed ?? true) await seedWorld(weft);
  await weft.clock.set("2026-10-26T15:30:00.000Z", 0);
  const close = weft.close.bind(weft);
  const t: TestWeft = Object.assign(weft, {
    uiHeaders: (principalId: string) => ({ "x-weft-principal": principalId, "x-weft-proxy": weft.proxySecret }),
    async close() { await close(); rmSync(dataDir, { recursive: true, force: true }); if (current === t) current = null; },
  });
  current = t;
  return t;
}

/** Headers for a proxy-authenticated UI request as `principalId`, using the latest createTestWeft() world. */
export function uiHeaders(principalId: string, weft: Pick<Weft, "proxySecret"> | null = current): Record<string, string> {
  if (!weft) throw new Error("uiHeaders: call createTestWeft() first");
  return { "x-weft-principal": principalId, "x-weft-proxy": weft.proxySecret };
}
