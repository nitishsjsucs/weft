// /v1 expenses routes (wave 3, docs/wave3.md). Owner: w3-expenses. Paths come from packages/contracts/src/api.ts.
// Reads come straight from the expense read model; every write goes through the executor as the signed-in person
// (expenses.submit, expenses.decide with exactly one id, expenses.reopen). The receipt route serves admins only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { EXPENSE_RATES, ExpenseBand, ExpenseCategory, ExpenseDecideBody, ExpenseStatus, ExpenseSubmission, Forbidden, NotFound, Unauthorized, ValidationError, type ToolOutcome } from "@weft/contracts";
import { expenses as exp, ptDateOf } from "@weft/core";
import { actions, payrollRuns, principals, uploads } from "@weft/db";
import type { W3ExpensesDetail, W3ExpensesPage, W3ExpensesRow } from "../../../../packages/contracts/src/ext/w3-expenses";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { parsePage } from "../http/paging";

const ADMIN_ROLES = new Set(["admin", "payroll_admin"]);

/** Admins see every expense; anyone else (an employee persona, a manager until routing lands) sees only their own. */
async function viewerScope(weft: Weft, c: Context<WeftEnv>): Promise<{ admin: boolean; workerId: string | null }> {
  const s = c.var.session;
  if (!s) throw new Unauthorized();
  const [p] = await weft.db.select({ role: principals.role, workerId: principals.workerId }).from(principals).where(eq(principals.id, s.principalId));
  if (s.via === "api_key") return { admin: true, workerId: null };
  return { admin: ADMIN_ROLES.has(p?.role ?? ""), workerId: p?.workerId ?? null };
}

async function outcome(c: Context<WeftEnv>, weft: Weft, command: string, args: unknown): Promise<Response> {
  const s = c.var.session;
  if (!s) throw new Unauthorized();
  const out: ToolOutcome = await weft.executor.human.exec(s, command, args);
  await weft.scheduler.kick();
  if (!out.ok) return c.json({ _tag: "Refused", message: out.refusal.message, code: out.refusal.code, hint: out.refusal.hint, example: out.refusal.example, tainted: out.tainted }, 422);
  return c.json(out);
}

const bad = (what: string, issues: z.core.$ZodIssue[]) => new ValidationError(what, { issues: issues.map((i) => ({ path: i.path.join("."), message: i.message })) });

async function rowsOut(weft: Weft, rows: exp.ExpenseRow[]): Promise<W3ExpensesRow[]> {
  const names = await exp.workerNameMap(weft.db, rows.map((r) => r.workerId));
  const runIds = [...new Set(rows.map((r) => r.payrollRunId).filter((x): x is string => !!x))];
  const runs = runIds.length ? await weft.db.select({ id: payrollRuns.id, status: payrollRuns.status }).from(payrollRuns).where(inArray(payrollRuns.id, runIds)) : [];
  const runStatus = new Map(runs.map((r) => [r.id, r.status]));
  return rows.map((r) => {
    const w = names.get(r.workerId);
    return {
      ...exp.toExpenseDto(r), workerName: w?.name ?? r.workerId, workerTitle: w?.title ?? "", workState: w?.state ?? null, submittedDate: ptDateOf(r.submittedAt),
      hasReceipt: r.receiptUploadId !== null, payrollRunStatus: r.payrollRunId ? runStatus.get(r.payrollRunId) ?? null : null,
    };
  });
}

export function expensesRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  const companyOf = (c: Context<WeftEnv>) => c.var.session?.companyId ?? "cmp_larkspur";

  r.get("/v1/expenses", async (c) => {
    const page = parsePage(c);
    const q = z.object({ band: ExpenseBand.optional(), status: ExpenseStatus.optional(), category: ExpenseCategory.optional(), workerId: z.string().startsWith("wrk_").optional() })
      .safeParse({ band: c.req.query("band") || undefined, status: c.req.query("status") || undefined, category: c.req.query("category") || undefined, workerId: c.req.query("workerId") || undefined });
    if (!q.success) throw bad("band, status, category or workerId is not valid", q.error.issues);
    const scope = await viewerScope(weft, c);
    if (!scope.admin && q.data.workerId && q.data.workerId !== scope.workerId) throw new Forbidden("You can see only your own expenses");
    const workerId = scope.admin ? q.data.workerId : scope.workerId ?? "wrk_none";
    const all = await exp.listExpenseRows(weft.db, companyOf(c), { status: q.data.status, category: q.data.category, workerId });
    const bands = Object.fromEntries(ExpenseBand.options.map((b) => [b, all.filter((x) => exp.bandOf(x.status) === b).length])) as W3ExpensesPage["bands"];
    let rows = q.data.band ? all.filter((x) => exp.bandOf(x.status) === q.data.band) : all;
    if (page.afterId) rows = rows.filter((x) => x.id > page.afterId!);
    const slice = rows.slice(0, page.limit + 1);
    const data = await rowsOut(weft, slice.slice(0, page.limit));
    const body: W3ExpensesPage = { hasMore: slice.length > page.limit, count: data.length, data, bands };
    return c.json(body);
  });

  r.get("/v1/expense-policy", async (c) => {
    const p = await exp.activePolicy(weft.db, companyOf(c), ptDateOf(weft.clock.now()));
    return c.json({ version: p.version, effectiveFrom: p.effectiveFrom, rules: p.rules, sources: p.sources, rates: EXPENSE_RATES });
  });

  r.get("/v1/expenses/:id", async (c) => {
    const row = await exp.getExpenseRow(weft.db, companyOf(c), c.req.param("id"));
    const scope = await viewerScope(weft, c);
    if (!row || (!scope.admin && row.workerId !== scope.workerId)) throw new NotFound(`No expense ${c.req.param("id")}`);
    const [base] = await rowsOut(weft, [row]);
    const decidable = exp.DECIDABLE.includes(row.status as never);
    const res = decidable ? await exp.evaluateRow(weft.db, row) : null;
    const trail = (await weft.db.select().from(actions).where(and(like(actions.command, "expenses.%"), like(actions.argsJson, `%"${row.id}"%`))).orderBy(asc(actions.seq)))
      .map((a) => ({ seq: a.seq, at: a.ts, command: a.command, actor: a.actorId, summary: a.summary }));
    const body: W3ExpensesDetail = {
      ...base!, attendees: row.attendees, decisionNote: row.decisionNote, preApprovalRef: row.preApprovalRef, receiptExtract: exp.parseExtract(row.receiptExtractJson),
      allowedDecisions: res?.allowed ?? [], suggestion: res?.suggestion ?? null, reopenBlocker: decidable ? null : await exp.reopenBlocker(weft.db, row),
      paycheckId: row.paycheckId, trail,
    };
    return c.json(body);
  });

  r.get("/v1/expenses/:id/receipt", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const [p] = await weft.db.select({ role: principals.role }).from(principals).where(eq(principals.id, s.principalId));
    if (!p || !ADMIN_ROLES.has(p.role ?? "")) throw new Forbidden("Receipts are shown to admins only");
    const row = await exp.getExpenseRow(weft.db, s.companyId, c.req.param("id"));
    if (!row?.receiptUploadId) throw new NotFound(`No receipt for ${c.req.param("id")}`);
    const [u] = await weft.db.select().from(uploads).where(eq(uploads.id, row.receiptUploadId));
    if (!u || u.purpose !== "receipt") throw new NotFound(`No receipt for ${row.id}`);
    const bytes = readFileSync(join(weft.dataDir, u.storagePath));
    const type = u.fileName.endsWith(".pdf") ? "application/pdf" : u.fileName.endsWith(".jpg") || u.fileName.endsWith(".jpeg") ? "image/jpeg" : u.fileName.endsWith(".webp") ? "image/webp" : "image/png";
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  });

  r.post("/v1/expenses", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const workerId = z.string().startsWith("wrk_").safeParse(raw.workerId);
    if (!workerId.success) throw bad("Body needs workerId", workerId.error.issues);
    const { workerId: _w, ...rest } = raw;
    const body = ExpenseSubmission.safeParse(rest);
    if (!body.success) throw bad("Body must be an ExpenseSubmission plus workerId", body.error.issues);
    const b = body.data;
    return outcome(c, weft, "expenses.submit", {
      worker_id: workerId.data, category: b.category, merchant: b.merchant, amount_cents: b.amountCents, transaction_date: b.transactionDate, business_purpose: b.businessPurpose,
      ...(b.attendees ? { attendees: b.attendees } : {}), ...(b.milesX10 ? { miles_x10: b.milesX10 } : {}), ...(b.tripRef ? { trip_ref: b.tripRef } : {}), ...(b.preApprovalRef ? { pre_approval_ref: b.preApprovalRef } : {}),
    });
  });

  r.post("/v1/expenses/:id/decide", async (c) => {
    const body = ExpenseDecideBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw bad("Body must be { decision, reasonCode?, note? } for one expense", body.error.issues);
    return outcome(c, weft, "expenses.decide", { expense_id: c.req.param("id"), decision: body.data.decision, ...(body.data.reasonCode ? { reason_code: body.data.reasonCode } : {}), ...(body.data.note ? { note: body.data.note } : {}) });
  });

  r.post("/v1/expenses/:id/reopen", async (c) => outcome(c, weft, "expenses.reopen", { expense_id: c.req.param("id") }));

  return stubRoutes(r, "expenses", [
    "GET /v1/expenses", "GET /v1/expenses/:id", "GET /v1/expenses/:id/receipt", "POST /v1/expenses", "POST /v1/expenses/:id/decide", "POST /v1/expenses/:id/reopen", "GET /v1/expense-policy",
  ]);
}
