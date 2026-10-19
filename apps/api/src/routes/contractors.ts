// /v1 contractors routes (wave 2, docs/wave2.md). Owner: w2-benefits-contractors. Paths come from packages/contracts/src/api.ts.
// GET payouts first brings open payouts up to the rail simulator's state at the sim clock (like a sim tick: no action
// row, writes only when a transfer moved), so pending, sent and delivered follow the clock without a scheduler hook
// (see .scratch/contract-requests/w2-benefits-contractors.md); POST payouts proposes through the executor.
// Payouts are each contractor's pay, so GET needs the payroll grant like contractors.list_payouts (a manager has
// payroll: none and gets 403 NOT_PERMITTED). The FX table is synthetic market data and names no one.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { Unauthorized, ValidationError, type ToolOutcome } from "@weft/contracts";
import { inArray } from "drizzle-orm";
import { listFxRates, listPayouts, pageById, syncRail, toPayoutDto } from "@weft/core";
import { contractorPayments, withWriteLock } from "@weft/db";
import { createSimulators } from "@weft/sim";
import type { Weft, WeftEnv } from "../http/context";
import { needDomain, viewerScope } from "../http/scope";
import { stubRoutes } from "../http/stub";
import { parsePage, toPage } from "../http/paging";

const PayoutBody = z.object({ workerIds: z.array(z.string().startsWith("wrk_")).min(1).max(50), scheduledFor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const RailStatus = z.enum(["pending", "sent", "delivered", "returned"]).optional();

async function outcome(c: Context<WeftEnv>, weft: Weft, command: string, args: unknown): Promise<Response> {
  const s = c.var.session;
  if (!s) throw new Unauthorized();
  const out: ToolOutcome = await weft.executor.human.exec(s, command, args);
  await weft.scheduler.kick();
  if (!out.ok) return c.json({ _tag: "Refused", message: out.refusal.message, code: out.refusal.code, hint: out.refusal.hint, example: out.refusal.example, tainted: out.tainted }, 422);
  return c.json(out);
}

/** Brings contractor payouts up to the rail simulator's state at the current sim time. */
export async function syncContractorRail(weft: Pick<Weft, "db" | "clock">): Promise<void> {
  const open = await weft.db.select({ id: contractorPayments.id }).from(contractorPayments).where(inArray(contractorPayments.railStatus, ["pending", "sent"])).limit(1);
  if (open.length === 0) return;
  await withWriteLock(() => weft.db.transaction(async (tx) => { await syncRail(tx, createSimulators({ db: tx, clock: weft.clock }), weft.clock.now()); }));
}

export function contractorsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/contractors/payouts", async (c) => {
    needDomain(await viewerScope(weft, c), "payroll", "contractor payouts");
    const page = parsePage(c);
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const status = RailStatus.safeParse(c.req.query("status") || undefined);
    if (!status.success) throw new ValidationError("status must be pending, sent, delivered or returned", { issues: [{ path: "status", message: "enum" }] });
    await syncContractorRail(weft);
    const rows = await listPayouts(weft.db, companyId, { workerId: c.req.query("workerId") || undefined, status: status.data });
    return c.json(toPage(pageById(rows, page).map(toPayoutDto), page.limit));
  });
  r.post("/v1/contractors/payouts", async (c) => {
    const body = PayoutBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new ValidationError("Body must be { workerIds, scheduledFor }", { issues: body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    return outcome(c, weft, "contractors.schedule_payouts", { worker_ids: body.data.workerIds, scheduled_for: body.data.scheduledFor });
  });
  r.get("/v1/contractors/fx", async (c) => {
    return c.json((await listFxRates(weft.db)).map((x) => ({ currency: x.currency, usdPerUnit: x.usdPerUnit, asOf: x.asOf, source: x.source })));
  });
  return stubRoutes(r, "contractors", ["GET /v1/contractors/payouts", "POST /v1/contractors/payouts", "GET /v1/contractors/fx"]);
}
