// design 11.3 in workerd: every case of cases.ts against Miniflare's workerd, compared with the same expected
// observation the emulator run (test/conformance.test.ts) must produce. `pnpm --filter @weft/db test:workerd`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CASES } from "./cases";
import { startConformanceWorker, type ConformanceWorker } from "./miniflare";
import { deltaResetMaxRows, recordRichSession, SESSION_MEMORIES } from "./flows";

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

// tracks.md cf1-db: restore then delta reset after the ten recorded flows, in workerd, twice. The session is recorded
// on Node (flows.ts), once on each memory repository; workerd restores the snapshot in steps as ReseedWorkflow does,
// replays each round's committed writes and resets, with workerd's own rows-written counts.
describe("delta reset in workerd after the recorded flows (design 4.6)", () => {
  for (const memory of SESSION_MEMORIES) {
    it(`on ${memory} memory: reproduces the manifest digests twice within 25% of the measured rows written`, { timeout: 900_000 }, async () => {
      const s = await recordRichSession(memory, 2);
      const ok = (o: { ok: boolean; value?: unknown; error?: string }) => { if (!o.ok) throw new Error(o.error); return o.value as Record<string, unknown>; };
      const begin = ok(await worker.session("begin", { manifest: s.snapshot.manifest, migrations: s.migrations, journalHash: s.journalHash }));
      let restoreRows = Number((begin.cost as { rowsWritten: number }).rowsWritten);
      for (let i = 0; i < s.snapshot.chunks.length; i += 25) restoreRows += Number(ok(await worker.session("chunks", s.snapshot.chunks.slice(i, i + 25))).rowsWritten);
      const finish = ok(await worker.session("finish", { manifest: s.snapshot.manifest, triggers: begin.triggers }));
      restoreRows += Number(finish.rowsWritten);
      expect(finish.digest).toBe(s.snapshot.manifest.digest);
      const resets: Record<string, unknown>[] = [];
      for (const round of s.rounds) {
        ok(await worker.session("replay", round));
        const reset = ok(await worker.session("reset", { manifest: s.snapshot.manifest, seed: s.snapshot.seed }));
        expect(reset.mismatched).toEqual([]);
        resets.push(reset);
      }
      console.log(`[cf1-db] workerd, ${memory} memory: full restore ${restoreRows} rows written; delta resets ${resets.map((r) => `${r.rowsWritten} rows written, ${r.rowsRead} read, ${r.keys} keys`).join("; ")} (emulator: ${s.resets.map((r) => r.rowsWritten).join(", ")})`);
      for (const r of resets) expect(Number(r.rowsWritten)).toBeLessThanOrEqual(deltaResetMaxRows(memory));
      expect(resets.map((r) => r.keys)).toEqual(s.resets.map((r) => r.keys));
    });
  }
});
