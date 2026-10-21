// design 4.6 and tracks.md cf1-db on the emulator: the rich world restored from its snapshot, the ten flows of the 8.2
// table run through the API (scripted provider), then a delta reset, twice. Each reset must bring every table back to
// the manifest digests at no more than 25% above the 557 rows written the design measured. The same recorded session
// is replayed in workerd by test-workerd/conformance.workerd.test.ts. Owner: cf1-db.
import { describe, expect, it } from "vitest";
import { DELTA_RESET_MAX_ROWS, FLOWS, recordRichSession } from "../test-workerd/flows";

describe("delta reset after the ten flows (emulator)", () => {
  it("reproduces the manifest digests twice within 25% of the measured rows written", { timeout: 900_000 }, async () => {
    const s = await recordRichSession(2);
    console.log(`[cf1-db] emulator: full restore ${s.restore.rowsWritten} rows written (${s.snapshot.manifest.rows} rows, ${s.snapshot.chunks.length} chunks); delta resets ${s.resets.map((r) => `${r.rowsWritten} rows written, ${r.rowsRead} read, ${r.keys} keys in ${r.tables.length} tables`).join("; ")}; recorded writes ${s.rounds.map((r) => r.length).join(", ")}`);
    expect(s.mismatched).toEqual([[], []]);
    for (const a of s.answers) {
      for (const f of FLOWS.slice(0, 9)) { expect(a[f], f).toBeGreaterThanOrEqual(200); expect(a[f], f).toBeLessThan(300); }
      expect(a[FLOWS[9]]).toBeGreaterThan(40);
    }
    for (const r of s.resets) {
      expect(r.keys).toBeGreaterThan(50);
      expect(r.rowsWritten).toBeLessThanOrEqual(DELTA_RESET_MAX_ROWS);
    }
    expect(s.rounds.every((r) => r.length > 100)).toBe(true);
  });
});
