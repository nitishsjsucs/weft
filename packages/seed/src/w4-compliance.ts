// Seed step w4_compliance (wave 4, docs/wave4.md). Owner: w4-parity-compliance. Deterministic; plans: filing rows with due dates for 2026 Q3 and Q4, compliance calendar rows, training courses and a few assignments (one overdue), one uploaded-notice fixture.
// Never change wave 1 to 3 seed counts (asserted by tests), never touch processed runs, every name ends with (demo).
//
// Round 1: the filing rows (2026-Q3 and 2026-Q4 for every quarterly form of an active account, and 2026 for the
// annual forms) and the calendar built from them, the federal deposits, notices and contractor forms. Nothing is
// prepared or filed: the 941 for 2026-Q3 is due Monday 2026-11-02 (October 31 is a Saturday), so it shows due soon.
// Training courses and the uploaded-notice fixture are round 2 (docs/tracks/w4-parity-compliance.md).
// runDirect: the seed writes rows only (no action rows, no events), like the wave 3 time-off seed.
import { directCtx, directDeps, runDirect } from "@weft/core";
import type { SeedContext } from "./context";

export async function seedW4Compliance(ctx: SeedContext): Promise<void> {
  await runDirect("compliance.refresh_calendar", {}, directCtx(ctx.clock, { principal: { id: "svc_events", kind: "service", role: null }, onBehalfOf: null, surface: "system", agentKind: null }), directDeps(ctx.db, ctx.clock, ctx.sims));
}
