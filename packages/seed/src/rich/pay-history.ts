// Rich profile, part 3: the January to August pay history. The base seed says Larkspur (demo) ran payroll on a
// previous provider until Aug 31 and imports the year-to-date totals into ytd_ledger (source "import"). This layer
// shows that history as sixteen processed, imported runs whose paychecks add up exactly to each worker's imported
// totals, code by code, so the Payroll list and the Reports charts have January to August.
//
// It never writes ytd_ledger: the engine reads year-to-date from the ledger alone, so a recomputed draft (after a
// rate change in the tour) gets the same numbers as on the base seed. Wage-base codes (FUTA, SUI, ETT) fill the
// earliest periods first, as they did in the real year; the rest split evenly over the periods a worker was on payroll.
import { and, asc, eq, isNull } from "drizzle-orm";
import { benefitEnrollments, benefitPlans, complianceItems, expenses, payRates, paychecks, payrollRuns, workers, ytdLedger, type DbTx } from "@weft/db";
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
    const idx = periods.map((p, i) => (w.startDate <= p.periodEnd && (w.endDate === null || w.endDate >= p.periodStart) ? i : -1)).filter((i) => i >= 0);
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
  // Paid expense claims ride the first imported run whose approval deadline is on or after the decision, on the
  // claimant's paycheck: outside gross and net, inside the bank entry and the totals. A claim past the 60-day window
  // was paid as taxable wages, so it is an earning line carved out of the imported gross (the gross still equals the
  // ledger). Claims decided after the last imported deadline stay with the runs Weft made.
  const paid = (await tx.select().from(expenses).where(and(eq(expenses.companyId, CO), eq(expenses.status, "paid"), isNull(expenses.payrollRunId)))).sort((a, b) => (a.id < b.id ? -1 : 1));
  const claims = new Map<string, { id: string; category: string; amountCents: number; taxable: boolean }[]>();   // `${period}:${worker}`
  for (const e of paid) {
    const decided = e.decidedAt;   // both are UTC instants
    const i = decided ? periods.findIndex((p) => p.approvalDeadline >= decided) : -1;
    if (i < 0 || !onPayroll.get(e.workerId)?.includes(i)) continue;
    const key = `${i}:${e.workerId}`;
    claims.set(key, [...(claims.get(key) ?? []), { id: e.id, category: e.category, amountCents: e.amountCents, taxable: e.decisionReasonCode === "taxable_late" }]);
  }
  // Benefits on each imported paycheck, from the enrollments active in that period, as the engine reads them: the
  // employer share per plan from the plan's match (so cost reports carry employer benefits from January), and the
  // employee share split so the plan lines add up to the imported pretax deductions exactly.
  const plans = new Map((await tx.select().from(benefitPlans)).map((p) => [p.id, p]));
  const enrollments = (await tx.select().from(benefitEnrollments)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const benefitsFor = (wid: string, p: { periodStart: string; periodEnd: string }, gross: number, s125: number, k401: number) => {
    // An enrollment ended since (Owen Mercer's, through October) still covered the periods inside its dates.
    const mine = enrollments.filter((e) => e.workerId === wid && (e.status === "active" || e.status === "terminated") && e.effectiveFrom <= p.periodEnd && (e.effectiveTo === null || e.effectiveTo >= p.periodStart));
    const lines = mine.flatMap((e) => { const plan = plans.get(e.planId); return plan ? [{ plan, b: payroll.benefitAmounts(plan, e, gross) }] : []; });
    const health = lines.filter((x) => x.plan.type !== "401k");
    const weights = health.map((x) => x.b.employeeCents);
    const shares = proportional(s125, weights.length ? weights : []);
    return lines.map((x) => {
      const employeeCents = x.plan.type === "401k" ? k401 : (shares[health.indexOf(x)] ?? 0);
      return { planId: x.b.planId, employeeCents, employerCents: x.b.employerCents };
    });
  };
  // Runs, newest last so ids sort by period; the paychecks and the run totals.
  for (const [i, p] of periods.entries()) {
    const id = `pay_${p.periodEnd.replaceAll("-", "_")}`;
    const checks: (typeof paychecks.$inferInsert)[] = [];
    let gross = 0, net = 0, workerTaxes = 0, employerTaxes = 0, pretax = 0, reimb = 0, erBenefits = 0;
    const linked: string[] = [];
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
      const erTax = taxes.filter((t) => t.payer === "employer").reduce((a, t) => a + t.amount_cents, 0);
      const deductions = [...(s125 ? [{ code: "section125_medical", pretax: true, amountCents: s125 }] : []), ...(k401 ? [{ code: "401k_traditional", pretax: true, amountCents: k401 }] : [])];
      const netCents = line.gross - ee - s125 - k401;
      const mine = claims.get(`${i}:${wid}`) ?? [];
      const plain = mine.filter((x) => !x.taxable);
      const taxable = mine.filter((x) => x.taxable && x.amountCents < line.gross).reduce((a, x) => a + x.amountCents, 0);
      const reimbursementsCents = plain.reduce((a, x) => a + x.amountCents, 0);
      const earnings = [{ type: hourly.has(w.id) ? "hourly" : "salary", amountCents: line.gross - taxable, hoursX100: null }, ...(taxable ? [{ type: "taxable_reimbursement", amountCents: taxable, hoursX100: null }] : [])];
      linked.push(...mine.filter((x) => !x.taxable || x.amountCents < line.gross).map((x) => x.id));
      const benefits = benefitsFor(wid, p, line.gross, s125, k401);
      // A pretax amount with no enrollment line behind it (none expected) stays a deduction only.
      const er = benefits.reduce((a, b) => a + b.employerCents, 0);
      checks.push({
        id: await newId(tx, "pyc_"), payrollRunId: id, workerId: wid, status: "processed", reviewGroup: "ready", hoursX100: null, grossCents: line.gross, netCents,
        reimbursementsCents, reimbursementsJson: JSON.stringify(plain.map((x) => ({ expenseId: x.id, category: x.category, amountCents: x.amountCents }))), earningsJson: JSON.stringify(earnings),
        deductionsJson: JSON.stringify(deductions), benefitsJson: JSON.stringify(benefits), taxesJson: JSON.stringify(taxes), flagsJson: "[]",
        explanation: "Imported from the previous provider: totals per tax code match the year-to-date import.", explanationSource: "template",
      });
      gross += line.gross; net += netCents; workerTaxes += ee; employerTaxes += erTax; pretax += s125 + k401; reimb += reimbursementsCents; erBenefits += er;
    }
    if (!checks.length) continue;
    const total = gross + reimb + employerTaxes + erBenefits;
    await tx.insert(payrollRuns).values({
      id, companyId: CO, payScheduleId: "ps_us_semimonthly", type: "us", subtype: "regular", status: "processed", periodStart: p.periodStart, periodEnd: p.periodEnd, payday: p.payday,
      approvalDeadline: p.approvalDeadline, fundingMethod: "ach",
      totalsJson: JSON.stringify({ cashRequirement: usd(total), grossPay: usd(gross), netPay: usd(net), reimbursements: usd(reimb), workerTaxes: usd(workerTaxes), employerTaxes: usd(employerTaxes),
        preTaxDeductions: usd(pretax), postTaxDeductions: usd(0), workerBenefitContributions: usd(pretax), employerBenefitContributions: usd(erBenefits), transactionFees: usd(0), totalCost: usd(total) }),
      anomalySummaryJson: JSON.stringify({ needsReview: 0, ready: checks.length, blocked: 0, excluded: 0, runFlags: [] }), subjectHash: null, taxDataVersion: "imported",
      previousRunId: null, excludedWorkerIdsJson: "[]", approvedBy: null, approvedAt: null, bankBatchId: null, settleAt: p.settleAt, processedAt: p.settleAt,
      createdAt: payroll.ptToUtc(p.periodStart, 9), updatedAt: p.settleAt,
    });
    await tx.insert(paychecks).values(checks);
    for (const eid of linked) await tx.update(expenses).set({ payrollRunId: id }).where(eq(expenses.id, eid));
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
