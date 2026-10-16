// contractors.* commands (wave 2, docs/wave2.md). Owner: w2-benefits-contractors. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
import { z } from "zod";
import { eq } from "drizzle-orm";
import { formatCents } from "@weft/contracts";
import { contractorPayments } from "@weft/db";
import type { WeftCommand } from "../shared/deps";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import { DomainRefusal, readCommand, responseFormatField, writeCommand } from "../demo/define";
import { listFxRates, listPayouts, PAYOUT_CREDENTIAL_REF, planPayouts, toPayoutDto } from "../contractors/index";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date is YYYY-MM-DD");

const ListInput = z.object({ worker_id: z.string().optional(), rail_status: z.enum(["pending", "sent", "delivered", "returned"]).optional(), ...responseFormatField });
type ListInput = z.infer<typeof ListInput>;
const listPayoutsCmd = readCommand({
  name: "contractors.list_payouts", domain: "payroll",
  summary: "List contractor payouts with currency, fixed FX rate, USD cents and rail status.",
  description: "List global contractor payouts: contractor, amount in the contractor's currency (minor units), the fixed FX rate used, the USD amount in cents with display, scheduled date and payment rail status (pending, sent, delivered, returned) with sent and delivered times.",
  input: ListInput,
  async run(i: ListInput, ctx, deps) {
    const rows = await listPayouts(deps.tx, ctx.companyId, { workerId: i.worker_id, status: i.rail_status });
    const payouts = rows.map(toPayoutDto).map((p) => ({ ...p, usd_display: formatCents(p.usdCents) }));
    return { data: { count: payouts.length, payouts }, summary: `Listed ${payouts.length} payouts` };
  },
});

const FxInput = z.object({ ...responseFormatField });
type FxInput = z.infer<typeof FxInput>;
const listFxCmd = readCommand({
  name: "contractors.list_fx_rates", domain: "payroll",
  summary: "List the fixed synthetic FX table used for contractor payouts.",
  description: "List the fixed synthetic FX table (not market data): currency, USD per unit as a decimal string, as-of date and source. Payouts convert minor units with these rates, rounding half up to whole USD cents.",
  input: FxInput,
  async run(_i: FxInput, _ctx, deps) {
    const rates = (await listFxRates(deps.tx)).map((r) => ({ currency: r.currency, usd_per_unit: r.usdPerUnit, as_of: r.asOf, source: r.source }));
    return { data: { count: rates.length, rates }, summary: `Listed ${rates.length} FX rates` };
  },
});

const ScheduleInput = z.object({ worker_ids: z.array(z.string().startsWith("wrk_")).min(1).max(50), scheduled_for: Day });
type ScheduleInput = z.infer<typeof ScheduleInput>;
async function plan(i: ScheduleInput, companyId: string, deps: Parameters<WeftCommand["run"]>[2]) {
  const p = await planPayouts(deps.tx, companyId, i.worker_ids, i.scheduled_for);
  if (!p.ok) throw new DomainRefusal(p.code as `DOMAIN_${string}`, p.message, "List contractors with people.search (type contractor)", { worker_ids: ["wrk_0049"], scheduled_for: i.scheduled_for });
  return p;
}
const schedulePayoutsCmd = writeCommand({
  name: "contractors.schedule_payouts", summary: "Propose monthly payouts to global contractors through the payment rail.",
  description: "Propose this month's payouts for the given contractors (worker_ids) on scheduled_for. Amounts come from each contractor's contract rate and the fixed FX table, never from arguments. Always a proposal; approval books each payment on the payment rail simulator (pending, then sent, then delivered).",
  input: ScheduleInput, domain: "payroll", needs: "edit", effect: "external", risk: () => "R4", approval: "always", reversible: false,
  amountCents: async (i, ctx, deps) => { const p = await planPayouts(deps.tx, ctx.companyId, i.worker_ids, i.scheduled_for); return p.ok ? p.totalUsdCents : null; },
  async preview(i: ScheduleInput, ctx, deps) {
    const p = await plan(i, ctx.companyId, deps);
    return {
      title: `Pay ${p.lines.length} contractor${p.lines.length === 1 ? "" : "s"} ${formatCents(p.totalUsdCents)} on ${i.scheduled_for}`,
      diff: p.lines.map((l) => ({ label: l.name, before: "no payout", after: `${(l.amountMinor / 100).toFixed(2)} ${l.currency} at ${l.fxRate} = ${formatCents(l.usdCents)}` })),
      content: [], moneyCents: p.totalUsdCents, subjectRef: `contractor_payouts:${i.scheduled_for}`,
      subjectHash: sha256Hex(canonicalJson({ at: i.scheduled_for, lines: p.lines.map((l) => [l.workerId, l.amountMinor, l.currency, l.fxRate, l.usdCents]) })),
      evidence: p.lines.map((l) => ({ label: `${l.name} contract rate`, ref: l.workerId })),
    };
  },
  async run(i: ScheduleInput, ctx, deps) {
    const p = await plan(i, ctx.companyId, deps);
    const credential = await deps.resolveCredential(PAYOUT_CREDENTIAL_REF);
    const out: { id: string; worker_id: string; usd_cents: number; rail_ref: string; rail_status: string }[] = [];
    for (const l of p.lines) {
      const id = await deps.newId("cpy_");
      await deps.tx.insert(contractorPayments).values({ id, workerId: l.workerId, amountMinor: l.amountMinor, currency: l.currency, fxRate: l.fxRate, usdCents: l.usdCents, status: "scheduled", scheduledFor: i.scheduled_for, railStatus: "pending", railRef: null, sentAt: null, deliveredAt: null });
      const r = await deps.sims.rail.send({ paymentId: id, amountMinor: l.amountMinor, currency: l.currency, credential });
      await deps.tx.update(contractorPayments).set({ railRef: r.railRef, railStatus: r.status }).where(eq(contractorPayments.id, id));
      out.push({ id, worker_id: l.workerId, usd_cents: l.usdCents, rail_ref: r.railRef, rail_status: r.status });
    }
    return { data: { count: out.length, total_usd_cents: p.totalUsdCents, total_usd_display: formatCents(p.totalUsdCents), payouts: out }, summary: `Booked ${out.length} payouts on the rail (${formatCents(p.totalUsdCents)})`, moneyCents: p.totalUsdCents };
  },
});

export const contractorsCommands: WeftCommand[] = [listPayoutsCmd, listFxCmd, schedulePayoutsCmd];
