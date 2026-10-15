// /v1 company routes. Owner: t2-world.
import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { NotFound, type Company, type Department, type PaySchedule, type Workplace } from "@weft/contracts";
import { companies, departments, paySchedules, workplaces } from "@weft/db";
import type { Weft, WeftEnv } from "../http/context";

export function companyRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/company", async (c) => {
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const [co] = await weft.db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!co) throw new NotFound("No company seeded; run pnpm db:seed");
    const company: Company = { id: co.id, legalName: co.legalName, domain: co.domain, ein: co.ein, hqState: co.hqState as Company["hqState"], foundedOn: co.foundedOn };
    const wk: Workplace[] = (await weft.db.select().from(workplaces).where(eq(workplaces.companyId, companyId)).orderBy(asc(workplaces.id)))
      .map((w) => ({ id: w.id, name: w.name, kind: w.kind as Workplace["kind"], city: w.city, state: w.state, country: w.country }));
    const dp: Department[] = (await weft.db.select().from(departments).where(eq(departments.companyId, companyId)).orderBy(asc(departments.id)))
      .map((d) => ({ id: d.id, name: d.name, leadWorkerId: d.leadWorkerId }));
    const ps: PaySchedule[] = (await weft.db.select().from(paySchedules).where(eq(paySchedules.companyId, companyId)).orderBy(asc(paySchedules.id)))
      .map((p) => ({ id: p.id, name: p.name, frequency: p.frequency as PaySchedule["frequency"], region: p.region as PaySchedule["region"], autopay: p.autopay }));
    return c.json({ company, workplaces: wk, departments: dp, paySchedules: ps });
  });
  return r;
}
