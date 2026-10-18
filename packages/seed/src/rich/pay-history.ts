// Rich profile, part 3: the January to August pay history. The base seed says Larkspur (demo) ran payroll on a
// previous provider until Aug 31 and imports the year-to-date totals into ytd_ledger (source "import"). This layer
// shows that history as sixteen processed, imported runs whose paychecks add up exactly to each worker's imported
// totals, code by code, so the Payroll list and the Reports charts have January to August.
//
// It never writes ytd_ledger: the engine reads year-to-date from the ledger alone, so a recomputed draft (after a
// rate change in the tour) gets the same numbers as on the base seed. Wage-base codes (FUTA, SUI, ETT) fill the
// earliest periods first, as they did in the real year; the rest split evenly over the periods a worker was on payroll.
import { asc, eq } from "drizzle-orm";
import { complianceItems, payRates, paychecks, payrollRuns, workers, ytdLedger, type DbTx } from "@weft/db";
import { newId, payroll } from "@weft/core";

const CO = "cmp_larkspur";
const usd = (amount: number) => ({ amount, currency: "USD", display: `${amount < 0 ? "-" : ""}$${(Math.abs(amount) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` });

/** Wage code each tax line is computed on. */
function wageCodeFor(jur: string, code: string): string {
  if (jur === "US") return ({ fit: "fit_wages", ss: "ss_wages", medicare: "medicare_wages", futa: "futa_wages" } as Record<string, string>)[code] ?? "gross";
  if (code === "pit") return `state_pit_wages:${jur}`;
  if (code === "ett") return "sui_wages:CA";
  return `${code}_wages:${jur}`;
}
const CAPPED = (code: string) => code.startsWith("futa_wages") || code.startsWith("sui_wages") || /^tax:[A-Z]+:(futa|sui|ett):/.test(code);

/** Splits `total` over n periods: evenly (remainder on the last), or front-loaded up to each period's cap. */
function split(total: number, n: number, caps?: number[]): number[] {
  if (!caps) {
    const base = Math.trunc(total / n);
    return Array.from({ length: n }, (_, i) => (i === n - 1 ? total - base * (n - 1) : base));
  }
  let left = total;
  return caps.map((c, i) => { const v = i === n - 1 ? left : Math.min(left, c); left -= v; return v; });
}
/** A tax spread in proportion to its wages per period, remainder on the last period that has wages. */
function proportional(total: number, wages: number[]): number[] {
  const sum = wages.reduce((a, b) => a + b, 0);
  if (sum === 0) return split(total, wages.length);
  const out = wages.map((w) => Math.round((total * w) / sum));
  const last = wages.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0).at(-1) ?? wages.length - 1;
  out[last]! += total - out.reduce((a, b) => a + b, 0);
  return out;
}

export async function seedImportedPayHistory(tx: DbTx, bump: (t: string, n?: number) => void): Promise<void> {
  const periods = payroll.semimonthlyPeriodsThrough(2026, "2026-08-31").map((p) => payroll.semimonthlyRunDates(p.periodEnd));
  const ws = new Map((await tx.select().from(workers).orderBy(asc(workers.id))).map((w) => [w.id, w]));
  const hourly = new Set((await tx.select().from(payRates)).filter((r) => r.kind === "hourly").map((r) => r.workerId));
  const rows = await tx.select().from(ytdLedger).where(eq(ytdLedger.source, "import"));
  const byWorker = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.year !== 2026) continue;
    const m = byWorker.get(r.workerId) ?? new Map<string, number>();
    m.set(r.code, (m.get(r.code) ?? 0) + r.amountCents);
    byWorker.set(r.workerId, m);
  }
  // Per worker, per period: the paycheck numbers.
  type Line = { gross: number; codes: Map<string, number> };
  const lines = new Map<string, Line[]>();   // worker -> one entry per period index (undefined when not on payroll)
  const onPayroll = new Map<string, number[]>();
  for (const [wid, codes] of byWorker) {
    const w = ws.get(wid);
    if (!w) continue;
    const idx = periods.map((p, i) => (w.startDate <= p.periodEnd ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    onPayroll.set(wid, idx);
    const n = idx.length;
    const grossSplit = split(codes.get("gross") ?? 0, n);
    const per: Line[] = idx.map((_, k) => ({ gross: grossSplit[k]!, codes: new Map([["gross", grossSplit[k]!]]) }));
    // Wage codes first (capped ones front-loaded against each period's gross), then the taxes on them.
    for (const [code, total] of codes) {
      if (code === "gross" || code.startsWith("tax:")) continue;
      const s = CAPPED(code) ? split(total, n, grossSplit) : split(total, n);
      s.forEach((v, k) => per[k]!.codes.set(code, v));
    }
    for (const [code, total] of codes) {
      if (!code.startsWith("tax:")) continue;
      const [, jur, tcode] = code.split(":") as [string, string, string];
      const wc = wageCodeFor(jur, tcode);
      const s = proportional(total, per.map((p) => p.codes.get(wc) ?? 0));
      s.forEach((v, k) => per[k]!.codes.set(code, v));
    }
    lines.set(wid, per);
  }
  // Runs, newest last so ids sort by period; the paychecks and the run totals.
  for (const [i, p] of periods.entries()) {
    const id = `pay_${p.periodEnd.replaceAll("-", "_")}`;
    const checks: (typeof paychecks.$inferInsert)[] = [];
    let gross = 0, net = 0, workerTaxes = 0, employerTaxes = 0, pretax = 0;
    for (const [wid, idx] of onPayroll) {
      const k = idx.indexOf(i);
      if (k < 0) continue;
      const line = lines.get(wid)![k]!;
      const w = ws.get(wid)!;
      const c = (code: string) => line.codes.get(code) ?? 0;
      const k401 = c("k401_deferral");
      const s125 = Math.max(0, line.gross - c("fit_wages") - k401);
      const taxes = [...line.codes.entries()].filter(([code]) => code.startsWith("tax:")).map(([code, amount]) => {
        const [, jur, tcode, payer] = code.split(":") as [string, string, string, string];
        return { code: tcode, jurisdiction: jur, payer, taxable_wages_cents: c(wageCodeFor(jur, tcode)), rate: null, amount_cents: amount };
      });
      const ee = taxes.filter((t) => t.payer === "employee").reduce((a, t) => a + t.amount_cents, 0);
      const er = taxes.filter((t) => t.payer === "employer").reduce((a, t) => a + t.amount_cents, 0);
      const deductions = [...(s125 ? [{ code: "section125_medical", pretax: true, amountCents: s125 }] : []), ...(k401 ? [{ code: "401k_traditional", pretax: true, amountCents: k401 }] : [])];
      const netCents = line.gross - ee - s125 - k401;
      checks.push({
        id: await newId(tx, "pyc_"), payrollRunId: id, workerId: wid, status: "processed", reviewGroup: "ready", hoursX100: null, grossCents: line.gross, netCents,
        reimbursementsCents: 0, reimbursementsJson: "[]", earningsJson: JSON.stringify([{ type: hourly.has(w.id) ? "hourly" : "salary", amountCents: line.gross, hoursX100: null }]),
        deductionsJson: JSON.stringify(deductions), benefitsJson: "[]", taxesJson: JSON.stringify(taxes), flagsJson: "[]",
        explanation: "Imported from the previous provider: totals per tax code match the year-to-date import.", explanationSource: "template",
      });
      gross += line.gross; net += netCents; workerTaxes += ee; employerTaxes += er; pretax += s125 + k401;
    }
    if (!checks.length) continue;
    const total = gross + employerTaxes;
    await tx.insert(payrollRuns).values({
      id, companyId: CO, payScheduleId: "ps_us_semimonthly", type: "us", subtype: "regular", status: "processed", periodStart: p.periodStart, periodEnd: p.periodEnd, payday: p.payday,
      approvalDeadline: p.approvalDeadline, fundingMethod: "ach",
      totalsJson: JSON.stringify({ cashRequirement: usd(total), grossPay: usd(gross), netPay: usd(net), reimbursements: usd(0), workerTaxes: usd(workerTaxes), employerTaxes: usd(employerTaxes),
        preTaxDeductions: usd(pretax), postTaxDeductions: usd(0), workerBenefitContributions: usd(pretax), employerBenefitContributions: usd(0), transactionFees: usd(0), totalCost: usd(total) }),
      anomalySummaryJson: JSON.stringify({ needsReview: 0, ready: checks.length, blocked: 0, excluded: 0, runFlags: [] }), subjectHash: null, taxDataVersion: "imported",
      previousRunId: null, excludedWorkerIdsJson: "[]", approvedBy: null, approvedAt: null, bankBatchId: null, settleAt: p.settleAt, processedAt: p.settleAt,
      createdAt: payroll.ptToUtc(p.periodStart, 9), updatedAt: p.settleAt,
    });
    await tx.insert(paychecks).values(checks);
    bump("payroll_runs"); bump("paychecks", checks.length);
  }
  // Monthly federal deposits for January to August, made on time.
  const [tmpl] = await tx.select().from(complianceItems).where(eq(complianceItems.subjectRef, "txa_0001:2026-09"));
  for (let m = 1; m <= 8; m++) {
    const period = `2026-${String(m).padStart(2, "0")}`;
    const due = `2026-${String(m + 1).padStart(2, "0")}-15`;
    await tx.insert(complianceItems).values({ id: await newId(tx, "cal_"), companyId: CO, kind: "deposit", title: `Federal tax deposit for ${period} (monthly schedule)`, jurisdiction: tmpl?.jurisdiction ?? "US",
      agency: tmpl?.agency ?? "irs", form: tmpl?.form ?? null, period, dueOn: due, status: "done", subjectRef: `txa_0001:${period}`, ownerPrincipalId: tmpl?.ownerPrincipalId ?? null,
      createdAt: payroll.ptToUtc(`${period}-01`, 9), doneAt: payroll.ptToUtc(payroll.businessDaysBefore(due, 1), 6) }).onConflictDoNothing();
    bump("compliance_items");
  }
}
