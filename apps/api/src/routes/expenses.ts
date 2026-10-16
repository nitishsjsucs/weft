// /v1 expenses routes (wave 3, docs/wave3.md). Owner: w3-expenses. Paths come from packages/contracts/src/api.ts.
// Reads come straight from the expense read model; every write goes through the executor as the signed-in person
// (expenses.submit, expenses.resubmit, expenses.decide with exactly one id, expenses.reopen). The receipt route serves admins
// only. /v1/portal/expenses* serve the caller's own claims to the new hire persona, which reaches only /v1/portal/*.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, eq, inArray, like, or } from "drizzle-orm";
import { EXPENSE_RATES, ExpenseBand, ExpenseCategory, ExpenseDecideBody, ExpenseStatus, ExpenseSubmission, Forbidden, NotFound, Unauthorized, ValidationError, type ToolOutcome } from "@weft/contracts";
import { expenses as exp, ptDateOf } from "@weft/core";
import { actions, payrollRuns, principals, uploads } from "@weft/db";
import type { W3ExpensesDetail, W3ExpensesPage, W3ExpensesPortalPage, W3ExpensesRow } from "../../../../packages/contracts/src/ext/w3-expenses";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { parsePage } from "../http/paging";

const ADMIN_ROLES = new Set(["admin", "payroll_admin"]);
/** Receipts reuse the I-9 upload path and limits (routes/portal.ts): 5 MB, PNG, JPEG, WebP or PDF, stored as uploads/<sha256>.bin. */
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const RECEIPT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
const maskName = (n: string) => `${n.slice(0, 2)}***${/\.[A-Za-z0-9]{1,5}$/.exec(n)?.[0] ?? ""}`;

type Claim = { workerId: unknown; submission: Record<string, unknown>; receipt: File | null };

/** Reads a claim from JSON or from multipart form data (fields plus an optional `receipt` file). */
async function readClaim(c: Context<WeftEnv>): Promise<Claim> {
  const type = c.req.header("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const body = await c.req.parseBody().catch(() => null);
    if (!body) throw new ValidationError("Send multipart form data with the claim fields and an optional receipt", { issues: [] });
    const str = (k: string) => (typeof body[k] === "string" && (body[k] as string).trim() !== "" ? (body[k] as string) : undefined);
    const num = (k: string) => (str(k) !== undefined && /^\d+$/.test(str(k)!) ? Number(str(k)) : str(k));
    const submission: Record<string, unknown> = {
      category: str("category"), merchant: str("merchant"), amountCents: num("amountCents"), transactionDate: str("transactionDate"), businessPurpose: str("businessPurpose"),
      attendees: str("attendees") ?? null, milesX10: num("milesX10") ?? null, tripRef: str("tripRef") ?? null, preApprovalRef: str("preApprovalRef") ?? null,
    };
    const f = body.receipt;
    return { workerId: str("workerId"), submission, receipt: f instanceof File && f.size > 0 ? f : null };
  }
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { workerId, ...submission } = raw;
  return { workerId, submission, receipt: null };
}

/** Validates and stores a receipt file; returns the command's receipt argument and a cleanup for a refused claim. */
function storeReceipt(weft: Weft, f: File, bytes: Buffer): { arg: { file_name: string; bytes: number; sha256: string; storage_path: string }; undo: () => void } {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const rel = `uploads/${sha}.bin`;
  const abs = join(weft.dataDir, rel);
  const fresh = !existsSync(abs);
  mkdirSync(join(weft.dataDir, "uploads"), { recursive: true });
  if (fresh) writeFileSync(abs, bytes, { mode: 0o600 });
  return {
    arg: { file_name: maskName(f.name || "receipt"), bytes: bytes.length, sha256: sha, storage_path: rel },
    undo: () => { if (fresh) { try { unlinkSync(abs); } catch { /* already gone */ } } },
  };
}

const refusal = (c: Context<WeftEnv>, code: string, message: string) => c.json({ _tag: "Refused", code, message, hint: null, example: null }, 422);

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
    // The submit's args carry no expense id (it is created), so its action row is found by the summary naming the id.
    const named = new RegExp(`\\b${row.id}\\b`);
    const trail = (await weft.db.select().from(actions).where(and(like(actions.command, "expenses.%"), or(like(actions.argsJson, `%"${row.id}"%`), like(actions.summary, `%${row.id}%`)))).orderBy(asc(actions.seq)))
      .filter((a) => a.argsJson.includes(`"${row.id}"`) || named.test(a.summary))
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

  /** Submits (or, with expenseId, resubmits) one claim through the executor; a receipt is stored first and removed if refused. */
  const fileClaim = async (c: Context<WeftEnv>, claim: Claim, target: { workerId: string } | { expenseId: string }): Promise<Response> => {
    const body = ExpenseSubmission.safeParse(claim.submission);
    if (!body.success) throw bad("Body must be an ExpenseSubmission", body.error.issues);
    let receipt: ReturnType<typeof storeReceipt> | null = null;
    if (claim.receipt) {
      const f = claim.receipt;
      if (f.size > MAX_RECEIPT_BYTES) return refusal(c, "INVALID_INPUT", "receipt: the file must be 5 MB or smaller");
      if (!RECEIPT_TYPES.has(f.type)) return refusal(c, "INVALID_INPUT", "receipt: use a PNG, JPEG, WebP or PDF file");
      receipt = storeReceipt(weft, f, Buffer.from(await f.arrayBuffer()));
    }
    const b = body.data;
    const args = {
      ...("workerId" in target ? { worker_id: target.workerId } : { expense_id: target.expenseId }),
      category: b.category, merchant: b.merchant, amount_cents: b.amountCents, transaction_date: b.transactionDate, business_purpose: b.businessPurpose,
      ...(b.attendees ? { attendees: b.attendees } : {}), ...(b.milesX10 ? { miles_x10: b.milesX10 } : {}), ...(b.tripRef ? { trip_ref: b.tripRef } : {}), ...(b.preApprovalRef ? { pre_approval_ref: b.preApprovalRef } : {}),
      ...(receipt ? { receipt: receipt.arg } : {}),
    };
    const res = await outcome(c, weft, "workerId" in target ? "expenses.submit" : "expenses.resubmit", args);
    if (res.status !== 200) receipt?.undo();
    return res;
  };

  r.post("/v1/expenses", async (c) => {
    const claim = await readClaim(c);
    const workerId = z.string().startsWith("wrk_").safeParse(claim.workerId);
    if (!workerId.success) throw bad("Body needs workerId", workerId.error.issues);
    return fileClaim(c, claim, { workerId: workerId.data });
  });

  // The portal (the new hire persona reaches only /v1/portal/*): the caller's own claims, submit and resubmit.
  const ownWorker = async (c: Context<WeftEnv>): Promise<string | null> => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const [p] = await weft.db.select({ workerId: principals.workerId }).from(principals).where(eq(principals.id, s.principalId));
    return p?.workerId ?? null;
  };

  r.get("/v1/portal/expenses", async (c) => {
    const workerId = await ownWorker(c);
    const all = workerId ? await exp.listExpenseRows(weft.db, companyOf(c), { workerId }) : [];
    const rows = all.slice().sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : a.id < b.id ? 1 : -1)).slice(0, 100);
    const out = await rowsOut(weft, rows);
    const notes = new Map(rows.map((x) => [x.id, x.decisionNote]));
    const bands = Object.fromEntries(ExpenseBand.options.map((b) => [b, all.filter((x) => exp.bandOf(x.status) === b).length])) as W3ExpensesPage["bands"];
    const body: W3ExpensesPortalPage = { hasMore: all.length > rows.length, count: out.length, data: out.map((x) => ({ ...x, decisionNote: notes.get(x.id) ?? null })), bands, workerId };
    return c.json(body);
  });

  r.post("/v1/portal/expenses", async (c) => {
    const workerId = await ownWorker(c);
    if (!workerId) throw new Forbidden("Your sign-in has no worker record yet; sign the offer letter first", { code: "NO_WORKER" });
    const claim = await readClaim(c);
    return fileClaim(c, claim, { workerId });
  });

  r.post("/v1/portal/expenses/:id/resubmit", async (c) => {
    const workerId = await ownWorker(c);
    const row = await exp.getExpenseRow(weft.db, companyOf(c), c.req.param("id"));
    if (!row || !workerId || row.workerId !== workerId) throw new NotFound(`No expense ${c.req.param("id")}`);
    return fileClaim(c, await readClaim(c), { expenseId: row.id });
  });

  r.post("/v1/expenses/:id/decide", async (c) => {
    const body = ExpenseDecideBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw bad("Body must be { decision, reasonCode?, note? } for one expense", body.error.issues);
    return outcome(c, weft, "expenses.decide", { expense_id: c.req.param("id"), decision: body.data.decision, ...(body.data.reasonCode ? { reason_code: body.data.reasonCode } : {}), ...(body.data.note ? { note: body.data.note } : {}) });
  });

  r.post("/v1/expenses/:id/reopen", async (c) => outcome(c, weft, "expenses.reopen", { expense_id: c.req.param("id") }));

  return stubRoutes(r, "expenses", [
    "GET /v1/expenses", "GET /v1/expenses/:id", "GET /v1/expenses/:id/receipt", "POST /v1/expenses", "POST /v1/expenses/:id/decide", "POST /v1/expenses/:id/reopen", "GET /v1/expense-policy",
    "GET /v1/portal/expenses", "POST /v1/portal/expenses", "POST /v1/portal/expenses/:id/resubmit",
  ]);
}
