// design 4.6 and tracks.md cf1-db on the emulator: the rich world restored from its snapshot, the ten flows of the 8.2
// table run through the API (scripted provider), then a delta reset, twice. Each reset must bring every table back to
// the manifest digests at no more than 25% above the rows written measured for the session's memory repository: the
// design's 557 on git memory, which it was measured on, and the SQL repo's own measured baseline (flows.ts), which
// hosted worlds always use. The same recorded sessions are replayed in workerd by
// test-workerd/conformance.workerd.test.ts. Owner: cf1-db.
import { describe, expect, it } from "vitest";
import { deltaResetMaxRows, FLOWS, recordRichSession, SESSION_MEMORIES } from "../test-workerd/flows";

const MEMORY_TABLES = ["mem_log", "mem_objects", "mem_refs"];

describe("delta reset after the ten flows (emulator)", () => {
  for (const memory of SESSION_MEMORIES) {
    it(`on ${memory} memory: reproduces the manifest digests twice within 25% of the measured rows written`, { timeout: 900_000 }, async () => {
      const s = await recordRichSession(memory, 2);
      console.log(`[cf1-db] emulator, ${memory} memory: full restore ${s.restore.rowsWritten} rows written (${s.snapshot.manifest.rows} rows, ${s.snapshot.chunks.length} chunks); delta resets ${s.resets.map((r) => `${r.rowsWritten} rows written, ${r.rowsRead} read, ${r.keys} keys in ${r.tables.length} tables`).join("; ")}; recorded writes ${s.rounds.map((r) => r.length).join(", ")}`);
      expect(s.mismatched).toEqual([[], []]);
      for (const a of s.answers) {
        for (const f of FLOWS.slice(0, 9)) { expect(a[f], f).toBeGreaterThanOrEqual(200); expect(a[f], f).toBeLessThan(300); }
        expect(a[FLOWS[9]]).toBeGreaterThan(40);
      }
      // The session ran on the memory repository it names, whatever WEFT_MEMORY the shell set.
      expect((s.snapshot.seed.mem_objects?.rows.length ?? 0) > 0).toBe(memory === "sqlite");
      for (const r of s.resets) {
        expect(r.keys).toBeGreaterThan(50);
        expect(r.tables.filter((t) => MEMORY_TABLES.includes(t)).sort()).toEqual(memory === "sqlite" ? MEMORY_TABLES : []);
        expect(r.rowsWritten).toBeLessThanOrEqual(deltaResetMaxRows(memory));
      }
      expect(s.rounds.every((r) => r.length > 100)).toBe(true);
    });
  }
});
