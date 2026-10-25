// /v1 workers routes. Owner: t2-world. List (filters status, state, type), detail (masked; compensation when the
// session's grants allow), onboarding checklist.
import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { idInMessage, NotFound } from "@weft/contracts";
import { principals, workers } from "@weft/db";
import { bankSummary, getWorker, homeAddressText, inScope, listTasks, lookups, pageById, payRateHistory, readScopeFor, taxProfile, toPayRateDto, toTaskDto, toWorkerDto, withheldReason, workerWhere, type WorkerRow } from "@weft/core";
import type { Weft, WeftEnv } from "../http/context";
import { parsePage, toPage } from "../http/paging";

const ListQuery = z.object({
  status: z.enum(["draft", "invited", "onboarding", "active", "offboarding", "inactive"]).optional(),
  state: z.enum(["CA", "NY", "TX", "CO"]).optional(),
  type: z.enum(["employee", "contractor"]).optional(),
});

export async function canSeeComp(weft: Weft, principalId: string | undefined): Promise<boolean> {
  if (!principalId) return false;
  const [p] = await weft.db.select().from(principals).where(eq(principals.id, principalId)).limit(1);
  if (!p) return false;
  if (p.role === "admin") return true;
  try {
    const g = JSON.parse(p.grantsJson) as Record<string, string>;
    return (g.payroll ?? "none") !== "none" || g.people === "edit" || g.people === "approve";
  } catch { return false; }
}

export function workersRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/workers", async (c) => {
    const q = ListQuery.parse({ status: c.req.query("status"), state: c.req.query("state"), type: c.req.query("type") });
    const page = parsePage(c);
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const rows = await weft.db.select().from(workers).where(workerWhere(companyId, q));
    // A manager (packages/core/src/people/scope.ts) sees ID numbers only for their own record and their reports.
    const scope = await readScopeFor(weft.db, companyId, c.var.session?.principalId ?? null);
    const dto = (w: WorkerRow) => (inScope(scope, w.id) ? toWorkerDto(w) : { ...toWorkerDto(w), ssnMasked: null });
    return c.json(toPage(pageById(rows, page).map(dto), page.limit));
  });

  r.get("/v1/workers/:id", async (c) => {
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const w = await getWorker(weft.db, companyId, c.req.param("id"));
    if (!w) throw new NotFound(`No worker ${idInMessage(c.req.param("id"))}`);
    const L = await lookups(weft.db, companyId);
    const bank = await bankSummary(weft.db, w.id);
    const tp = await taxProfile(weft.db, w.id);
    const scope = await readScopeFor(weft.db, companyId, c.var.session?.principalId ?? null);
    if (scope && !inScope(scope, w.id)) {
      // Outside a manager's reports: the directory record only, never pay, bank, W-4, ID numbers or personal fields.
      return c.json({
        worker: { ...toWorkerDto(w), ssnMasked: null },
        department: L.dept(w.departmentId), manager: L.person(w.managerId), workplace: L.place(w.workplaceId),
        payRates: null, bankAccount: null, taxProfile: null,
        profile: { preferredName: null, personalEmail: null, homeAddress: null, untrusted: true },
        access: { scope: "directory", reason: withheldReason(scope, w.id) },
      });
    }
    const comp = await canSeeComp(weft, c.var.session?.principalId);
    return c.json({
      worker: toWorkerDto(w),
      department: L.dept(w.departmentId), manager: L.person(w.managerId), workplace: L.place(w.workplaceId),
      payRates: comp ? (await payRateHistory(weft.db, w.id)).map(toPayRateDto) : null,
      bankAccount: bank.active ? { id: bank.active.id, bankName: bank.active.bankName, last4: bank.active.accountLast4, status: bank.active.status, source: bank.active.source } : null,
      taxProfile: tp ? { w4Version: tp.w4Version, filingStatus: tp.filingStatus, stateFilingStatus: tp.stateFilingStatus, stateAllowances: tp.stateAllowances, source: tp.source } : null,
      profile: { preferredName: w.preferredName, personalEmail: w.personalEmail, homeAddress: homeAddressText(w.homeAddressJson), untrusted: true },
    });
  });

  r.get("/v1/workers/:id/onboarding", async (c) => {
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const w = await getWorker(weft.db, companyId, c.req.param("id"));
    if (!w) throw new NotFound(`No worker ${idInMessage(c.req.param("id"))}`);
    // Onboarding tasks (W-4, direct deposit, I-9, background check) are private to the hire's own management chain.
    if (!inScope(await readScopeFor(weft.db, companyId, c.var.session?.principalId ?? null), w.id)) return c.json([]);
    return c.json((await listTasks(weft.db, w.id)).map(toTaskDto));
  });
  return r;
}
