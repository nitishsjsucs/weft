// Seed step w4_compliance (wave 4, docs/wave4.md). Owner: w4-parity-compliance. Deterministic.
// Never change wave 1 to 3 seed counts (asserted by tests), never touch processed runs, every domain is *.example.
//
// - Filing rows (2026-Q3 and 2026-Q4 for every quarterly form of an active account, and 2026 for the annual forms) and
//   the calendar built from them, the federal deposits, notices and contractor forms. Nothing is prepared or filed:
//   the 941 for 2026-Q3 is due Monday 2026-11-02 (October 31 is a Saturday), so it shows due soon.
// - Required training: the four course rules, and one assignment per required course for every active employee in
//   California, New York or Illinois. A recent hire's course is due from the start date; for everyone else the last
//   cycle is completed, except every fifth person (due in 10 days) and every seventh from the fourth (overdue by a week).
// runDirect: the seed writes rows only (no action rows, no events), like the wave 3 time-off seed.
import { asc, eq } from "drizzle-orm";
import { directCtx, directDeps, ptDateOf, runDirect } from "@weft/core";
import { trainingAssignments, workers } from "@weft/db";
import { addDays, addMonths, ensureCourses, requiredCourses } from "../../core/src/compliance/training";
import type { SeedContext } from "./context";

export async function seedW4Compliance(ctx: SeedContext): Promise<void> {
  const deps = directDeps(ctx.db, ctx.clock, ctx.sims);
  const now = ctx.clock.now();
  const today = ptDateOf(now);
  const courses = await ensureCourses(ctx.db, ctx.companyId, (p) => deps.newId(p as never));
  const ws = await ctx.db.select().from(workers).where(eq(workers.companyId, ctx.companyId)).orderBy(asc(workers.id));
  const supervisors = new Set(ws.map((w) => w.managerId).filter((x): x is string => !!x));
  let k = 0;
  for (const w of ws) {
    for (const r of requiredCourses(w, supervisors)) {
      const c = courses.get(r.code)!;
      const fromHire = addDays(w.startDate, r.dueWithinDays);
      const base = { id: await deps.newId("tra_" as never), workerId: w.id, courseId: c.id, assignedAt: now, remindedAt: null, certificateUploadId: null, proposalId: null };
      if (fromHire >= today) {
        await ctx.db.insert(trainingAssignments).values({ ...base, dueOn: fromHire, status: "assigned", completedAt: null });
      } else if (k % 5 === 0) {
        await ctx.db.insert(trainingAssignments).values({ ...base, dueOn: addDays(today, 10), status: "assigned", completedAt: null });
      } else if (k % 7 === 3) {
        await ctx.db.insert(trainingAssignments).values({ ...base, dueOn: addDays(today, -7), status: "assigned", completedAt: null });
      } else {
        const done = addMonths(today, -Math.max(1, Math.floor(r.repeatMonths / 2)));
        await ctx.db.insert(trainingAssignments).values({ ...base, dueOn: done, status: "completed", completedAt: `${done}T17:00:00.000Z` });
      }
      k++;
    }
  }
  await runDirect("compliance.refresh_calendar", {}, directCtx(ctx.clock, { principal: { id: "svc_events", kind: "service", role: null }, onBehalfOf: null, surface: "system", agentKind: null }), deps);
}
