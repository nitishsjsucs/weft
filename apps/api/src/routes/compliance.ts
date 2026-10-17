// /v1 compliance calendar, filings and notice upload routes (wave 4, docs/wave4.md). Owner: w4-parity-compliance. Paths come from packages/contracts/src/api.ts.
// Every route answers 501 until the owner registers real handlers before stubRoutes and lists them in `except`.
// Reads come from the calendar and filing read models; preparing runs tax.prepare_filing as the signed-in person, and
// filing always files the person's request as a pending tax.file_return proposal (R4), never a direct filing.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { ComplianceItemKind, ComplianceItemStatus, FilingForm, NotFound, Unauthorized, type ToolOutcome } from "@weft/contracts";
import { ptDateOf } from "@weft/core";
import { filings, taxAccounts } from "@weft/db";
import { eq } from "drizzle-orm";
import { listCalendar } from "../../../../packages/core/src/compliance/calendar";
import { RULE_BY_FORM, periodBounds } from "../../../../packages/core/src/compliance/rules";
import type { PreparedFiling } from "../../../../packages/core/src/compliance/prepare";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { parsePage, toPage } from "../http/paging";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const CalendarQuery = z.object({ from: date, to: date, kind: ComplianceItemKind.optional(), status: ComplianceItemStatus.optional() });
const FilingQuery = z.object({ form: FilingForm.optional(), period: z.string().max(10).optional(), status: z.enum(["draft", "filed", "accepted", "rejected"]).optional() });

const companyOf = (c: Context<WeftEnv>) => c.var.session?.companyId ?? "cmp_larkspur";

async function outcome(c: Context<WeftEnv>, weft: Weft, command: string, args: unknown, mode: "exec" | "propose"): Promise<Response> {
  const s = c.var.session;
  if (!s) throw new Unauthorized();
  const h = weft.executor.human;
  const out: ToolOutcome = mode === "propose" && h.propose ? await h.propose(s, command, args) : await h.exec(s, command, args);
  await weft.scheduler.kick();
  if (!out.ok) return c.json({ _tag: "Refused", message: out.refusal.message, code: out.refusal.code, hint: out.refusal.hint, example: out.refusal.example, tainted: out.tainted }, 422);
  return c.json(out);
}

export interface FilingDto {
  id: string; form: string; formLabel: string; period: string; agency: string; jurisdiction: string; status: string; dueOn: string | null; filedAt: string | null;
  confirmation: string | null; prepared: boolean; periodOpen: boolean; totalDueCents: number | null; balanceDueCents: number | null; sourceUrl: string | null;
}

function toFilingDto(f: typeof filings.$inferSelect & { agency: string }, today: string): FilingDto {
  const p = f.preparedJson ? (JSON.parse(f.preparedJson as string) as PreparedFiling) : null;
  const rule = RULE_BY_FORM[f.form as FilingForm];
  return {
    id: f.id, form: f.form, formLabel: rule?.label ?? f.form, period: f.period, agency: f.agency, jurisdiction: rule?.jurisdiction ?? "", status: f.status, dueOn: f.dueOn, filedAt: f.filedAt,
    confirmation: f.confirmation, prepared: !!p, periodOpen: today <= periodBounds(f.period).end, totalDueCents: p?.total_due_cents ?? null, balanceDueCents: p?.balance_due_cents ?? null,
    sourceUrl: rule?.sourceUrl ?? null,
  };
}

async function companyFilings(weft: Weft, companyId: string) {
  const rows = await weft.db.select({ f: filings, agency: taxAccounts.agency }).from(filings).innerJoin(taxAccounts, eq(filings.taxAccountId, taxAccounts.id)).where(eq(taxAccounts.companyId, companyId));
  return rows.map((r) => ({ ...r.f, agency: r.agency })).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function complianceRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/compliance/calendar", async (c) => {
    const q = CalendarQuery.parse({ from: c.req.query("from"), to: c.req.query("to"), kind: c.req.query("kind"), status: c.req.query("status") });
    return c.json(await listCalendar(weft.db, companyOf(c), ptDateOf(weft.clock.now()), q));
  });
  r.get("/v1/filings", async (c) => {
    const q = FilingQuery.parse({ form: c.req.query("form"), period: c.req.query("period"), status: c.req.query("status") });
    const page = parsePage(c);
    const today = ptDateOf(weft.clock.now());
    let rows = (await companyFilings(weft, companyOf(c))).filter((f) => (!q.form || f.form === q.form) && (!q.period || f.period === q.period) && (!q.status || f.status === q.status));
    if (page.afterId) rows = rows.filter((f) => f.id > page.afterId!);
    return c.json(toPage(rows.slice(0, page.limit + 1).map((f) => toFilingDto(f, today)), page.limit));
  });
  r.get("/v1/filings/:id", async (c) => {
    const f = (await companyFilings(weft, companyOf(c))).find((x) => x.id === c.req.param("id"));
    if (!f) throw new NotFound(`No filing ${c.req.param("id")}`);
    const prepared = f.preparedJson ? (JSON.parse(f.preparedJson as string) as PreparedFiling) : null;
    return c.json({ ...toFilingDto(f, ptDateOf(weft.clock.now())), preparedReturn: prepared });
  });
  r.post("/v1/filings/:id/prepare", (c) => outcome(c, weft, "tax.prepare_filing", { filing_id: c.req.param("id") }, "exec"));
  r.post("/v1/filings/:id/file", (c) => outcome(c, weft, "tax.file_return", { filing_id: c.req.param("id") }, "propose"));
  return stubRoutes(r, "compliance", ["GET /v1/compliance/calendar", "GET /v1/filings", "GET /v1/filings/:id", "POST /v1/filings/:id/prepare", "POST /v1/filings/:id/file"]);
}
