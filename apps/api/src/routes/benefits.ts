// /v1 benefits routes. Owner: t2-world.
import { Hono } from "hono";
import { listEnrollments, listPlans, pageById, toEnrollmentDto, toPlanDto } from "@weft/core";
import type { Weft, WeftEnv } from "../http/context";
import { parsePage, toPage } from "../http/paging";

export function benefitsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/benefits/plans", async (c) => {
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    return c.json((await listPlans(weft.db, companyId)).map(toPlanDto));
  });
  r.get("/v1/benefits/enrollments", async (c) => {
    const page = parsePage(c);
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const rows = await listEnrollments(weft.db, companyId, c.req.query("workerId") || undefined);
    return c.json(toPage(pageById(rows, page).map(toEnrollmentDto), page.limit));
  });
  return r;
}
