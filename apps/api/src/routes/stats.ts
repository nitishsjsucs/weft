// /v1 stats (public): live counts for the landing page and Home. Owner: t2-world.
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { Stats } from "@weft/contracts";
import type { Weft, WeftEnv } from "../http/context";

export const SIMULATED_AGENCIES = 7;

export function statsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/stats", async (c) => {
    const count = async (q: ReturnType<typeof sql>) => Number((await weft.db.all<{ n: number }>(q))[0]?.n ?? 0);
    const body: Stats = {
      employees: await count(sql`SELECT COUNT(*) AS n FROM workers WHERE type = 'employee' AND status IN ('active', 'onboarding', 'offboarding')`),
      contractors: await count(sql`SELECT COUNT(*) AS n FROM workers WHERE type = 'contractor' AND status = 'active'`),
      simulatedAgencies: SIMULATED_AGENCIES,
      runsLogged: await count(sql`SELECT COUNT(*) AS n FROM agent_runs`),
      actionsLogged: await count(sql`SELECT COUNT(*) AS n FROM actions`),
      realAgenciesContacted: 0,
      payrollsProcessed: await count(sql`SELECT COUNT(*) AS n FROM payroll_runs WHERE status = 'processed'`),
    };
    return c.json(body);
  });
  return r;
}
