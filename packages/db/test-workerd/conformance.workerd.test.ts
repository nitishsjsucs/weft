// design 11.3 in workerd: every case of cases.ts against Miniflare's workerd, compared with the same expected
// observation the emulator run (test/conformance.test.ts) must produce. `pnpm --filter @weft/db test:workerd`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CASES } from "./cases";
import { startConformanceWorker, type ConformanceWorker } from "./miniflare";

let worker: ConformanceWorker;
beforeAll(async () => { worker = await startConformanceWorker(); }, 120_000);
afterAll(async () => { await worker?.dispose(); });

describe("transaction conformance in workerd (design 11.3)", () => {
  for (const c of CASES) {
    // The hang cases wait out workerd's 30 s input-gate timeout; they run concurrently with the rest.
    it.concurrent(c.name, async () => {
      expect(await worker.run(c.name)).toEqual(c.expect);
      if (c.after) expect(await worker.after(c.name)).toEqual({ ok: true, value: c.expectAfter });
    }, c.slow ? 90_000 : 30_000);
  }
});
