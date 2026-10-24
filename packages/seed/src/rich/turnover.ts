// Rich profile, part 4: the people who joined and left during 2026, so Reports has a hiring curve and every
// departure it counts is a real record. Summer interns (June to August), a seasonal field technician at the Austin
// Yard (March to August), a quality inspector who left in May and a sales hire let go in June. Each one is an
// inactive worker with a pay rate, a tax profile, signed documents, a finished onboarding checklist and a completed
// offboarding case.
//
// Their year-to-date import is computed with the payroll engine (the same computeWorkerPaycheck loop the base seed's
// writeOpeningYtd runs, end date included), so the imported January to August runs pay them period by period and the
// totals still equal the ledger code by code. Current workers' ledger rows are never touched, so a recomputed draft is
// identical to the base seed's. Rafael Ostrander, the July leaver from part 1, gets his import here too.
import { and, eq, isNotNull, like } from "drizzle-orm";
import { benefitEnrollments, benefitPlans, documents, offboardingCases, offboardingSteps, onboardingTasks, payRates, taxProfiles, workers, ytdLedger, type DbTx } from "@weft/db";
import { newId, payroll, sha256Hex } from "@weft/core";

const CO = "cmp_larkspur";
const pt = (date: string, hour: number, minute = 0) => payroll.ptToUtc(date, hour, minute);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface TurnoverApi { tx: DbTx; bump: (table: string, n?: number) => void; action: (a: Record<string, unknown>) => void }

type Leaver = {
  first: string; last: string; title: string; dept: string; wkp: string; state: string; tz: string; empNo: string; kind: "salary" | "hourly"; rateCents: number;
  start: string; end: string; termination: "voluntary" | "involuntary" | "end_of_contract"; reason: string;
};

export const LEAVERS: readonly Leaver[] = [
  { first: "Wen", last: "Talbot", title: "Quality Inspector", dept: "dpt_operations", wkp: "wkp_oakland", state: "CA", tz: "America/Los_Angeles", empNo: "EMP-0093", kind: "salary", rateCents: 6_400_000,
    start: "2026-02-02", end: "2026-05-08", termination: "voluntary", reason: "Accepted a role closer to home" },
  { first: "Lucia", last: "Ferrante", title: "Field Robotics Technician (seasonal)", dept: "dpt_operations", wkp: "wkp_austin", state: "TX", tz: "America/Chicago", empNo: "EMP-0094", kind: "hourly", rateCents: 3_150,
    start: "2026-03-02", end: "2026-08-28", termination: "end_of_contract", reason: "Seasonal field trial season ended" },
  { first: "Dorian", last: "Pike", title: "Sales Development Representative", dept: "dpt_gtm", wkp: "wkp_brooklyn", state: "NY", tz: "America/New_York", empNo: "EMP-0095", kind: "salary", rateCents: 7_000_000,
    start: "2026-04-06", end: "2026-06-26", termination: "involuntary", reason: "Did not complete the ramp plan" },
  { first: "Amara", last: "Okafor", title: "Robotics Engineering Intern", dept: "dpt_engineering", wkp: "wkp_oakland", state: "CA", tz: "America/Los_Angeles", empNo: "EMP-0096", kind: "hourly", rateCents: 3_400,
    start: "2026-06-01", end: "2026-08-14", termination: "end_of_contract", reason: "Summer internship ended" },
  { first: "Felix", last: "Ambrose", title: "Hardware Engineering Intern", dept: "dpt_hardware", wkp: "wkp_brooklyn", state: "NY", tz: "America/New_York", empNo: "EMP-0097", kind: "hourly", rateCents: 3_200,
    start: "2026-06-08", end: "2026-08-21", termination: "end_of_contract", reason: "Summer internship ended" },
  { first: "Sana", last: "Whitlock", title: "Operations Intern", dept: "dpt_operations", wkp: "wkp_austin", state: "TX", tz: "America/Chicago", empNo: "EMP-0098", kind: "hourly", rateCents: 2_600,
    start: "2026-06-15", end: "2026-08-14", termination: "end_of_contract", reason: "Summer internship ended" },
];

/** The regular payday for the semi-monthly period that holds `d` (the 15th or the month end, a business day). */
export function regularPayday(d: string): string {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const end = day <= 15 ? `${d.slice(0, 7)}-15` : new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10);
  return payroll.previousBusinessDayOnOrBefore(end);
}
/** The last day of the month that holds `d`, through which a leaver's coverage runs. */
export const monthEnd = (d: string) => { const [y, m] = d.split("-").map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10); };
const longDay = (d: string) => payroll.shortDay(d, 0);
// The step details as the offboarding screen reads them: dates as days, the systems by the names IT shows.
const STEPS = (l: Leaver, login: string): [string, string][] => [
  ["final_pay", `Final pay included on the ${payroll.shortDay(regularPayday(l.end), 2026)} regular run`], ["directory_suspend", `Suspended Workspace ${login}`],
  ["sso_deactivate", `Suspended SSO ${login}`], ["group_removal", "Removed group memberships"], ["app_removal", `Removed Chat ${login}`],
  ["device_lock", "Device locked and returned"], ["cobra_notice", l.kind === "hourly" && l.title.includes("Intern") ? "Not enrolled in a group health plan, so no COBRA notice is due" : `COBRA notice emailed to ${login}@mail.example`],
  ["benefits_terminate", l.title.includes("Intern") ? "No enrollments to end" : `Terminated enrollments, effective through ${payroll.shortDay(monthEnd(l.end), 2026)}`],
];

/** A leaver's health enrollments while they worked here, written as the base seed writes enrollments (the plan's
 * employee price for the tier, from the start date or Jan 1). They stay active until the pay history is imported
 * (the YTD import and the imported paychecks read them as the engine would), then terminateLeaverEnrollments ends
 * them through the month of the last day, as offboarding.run_step's benefits termination does. */
export async function enrollLeaver(tx: DbTx, workerId: string, start: string, tier: "ee" | "ee_spouse", plans: readonly ("ppo" | "dental" | "vision" | "k401")[], deferralBps = 400): Promise<number> {
  const names: Record<string, string> = { ppo: "Juniper PPO 1500", dental: "Juniper Dental Plus", vision: "Juniper Vision", k401: "Tidewater 401(k)" };
  const all = await tx.select().from(benefitPlans);
  let n = 0;
  for (const key of plans) {
    const plan = all.find((x) => x.name === names[key]);
    if (!plan) continue;
    const prices = JSON.parse(plan.pricesJson) as Record<string, number>;
    const k401 = key === "k401";
    await tx.insert(benefitEnrollments).values({ id: await newId(tx, "ben_"), workerId, planId: plan.id, tier: k401 ? null : tier, employeeCents: k401 ? null : prices[tier] ?? null, deferralBps: k401 ? deferralBps : null, status: "active",
      effectiveFrom: start > "2026-01-01" ? start : "2026-01-01", effectiveTo: null });
    n++;
  }
  return n;
}

/** Ends every 2026 leaver's enrollments through the month of the last day (after the pay history read them). */
export async function terminateLeaverEnrollments(tx: DbTx): Promise<void> {
  const leavers = await tx.select().from(workers).where(and(eq(workers.companyId, CO), eq(workers.status, "inactive"), isNotNull(workers.endDate)));
  for (const w of leavers) {
    const through = monthEnd(w.endDate!);
    for (const e of await tx.select().from(benefitEnrollments).where(eq(benefitEnrollments.workerId, w.id))) {
      if (e.status !== "active") continue;
      await tx.update(benefitEnrollments).set({ status: "terminated", effectiveTo: e.effectiveTo !== null && e.effectiveTo < through ? e.effectiveTo : through }).where(eq(benefitEnrollments.id, e.id));
    }
  }
}

/** The 2026 joiners and leavers, then the engine-computed YTD import for every 2026 leaver without one. */
export async function seedTurnover(L: TurnoverApi): Promise<void> {
  const { tx } = L;
  for (const l of LEAVERS) {
    const id = await newId(tx, "wrk_");
    const login = `${l.first.toLowerCase()}.${l.last.toLowerCase()}`;
    await tx.insert(workers).values({ id, companyId: CO, employeeNumber: l.empNo, type: "employee", workerType: "us_w2", status: "inactive", firstName: l.first, lastName: l.last,
      workEmail: `${login}@larkspur.example`, title: l.title, departmentId: l.dept, managerId: null, workplaceId: l.wkp, workState: l.state, timezone: l.tz,
      startDate: l.start, endDate: l.end, payScheduleId: "ps_us_semimonthly", createdAt: pt(addDays(l.start, -21), 10), updatedAt: pt(l.end, 17) });
    await tx.insert(payRates).values({ id: await newId(tx, "prt_"), workerId: id, kind: l.kind, amountCents: l.rateCents, effectiveFrom: l.start, effectiveTo: l.end });
    await tx.insert(taxProfiles).values({ workerId: id, w4Version: "2020", filingStatus: "single", source: "seed" });
    L.bump("workers");
    // The salaried leavers were on the medical and dental plans and the 401(k) (Dorian also on vision); interns and the seasonal
    // technician were not eligible.
    if (l.kind === "salary") L.bump("benefit_enrollments", await enrollLeaver(tx, id, l.start, "ee", l.first === "Dorian" ? ["ppo", "dental", "vision", "k401"] : ["ppo", "dental", "k401"], l.first === "Dorian" ? 500 : 300));
    for (const k of ["sign_offer", "federal_w4", "state_withholding", "direct_deposit", "i9_sim", "benefits_selection", "it_accounts"]) {
      await tx.insert(onboardingTasks).values({ id: await newId(tx, "obt_"), workerId: id, kind: k, status: "done", owner: k === "i9_sim" ? "hr" : k === "it_accounts" ? "agent" : "employee",
        dueOn: l.start, doneAt: pt(addDays(l.start, -4), 11) });
      L.bump("onboarding_tasks");
    }
    const signed = pt(addDays(l.start, -10), 10);
    for (const [kind, title] of [["offer_letter", `Offer letter: ${l.title}`], ["confidentiality_agreement", "Confidentiality and invention assignment agreement"], ["w4", "Form W-4, employee's withholding certificate"], ["i9", "Form I-9 receipt (masked)"]] as const) {
      const body = `${title}\nLarkspur Robotics\n${l.first} ${l.last}\nSigned ${longDay(signed.slice(0, 10))}.`;
      await tx.insert(documents).values({ id: await newId(tx, "doc_"), companyId: CO, workerId: id, offerId: null, kind, title, status: "signed", bodyText: body, sha256: sha256Hex(body), createdAt: signed, sentAt: signed, signedAt: signed });
      L.bump("documents");
    }
    const sent = pt(l.end, 16);
    const statement = `Final pay statement\nLarkspur Robotics\n${l.first} ${l.last}\nLast day ${longDay(l.end)}. Final wages paid on the ${longDay(regularPayday(l.end))} regular run.`;
    await tx.insert(documents).values({ id: await newId(tx, "doc_"), companyId: CO, workerId: id, offerId: null, kind: "final_pay_statement", title: "Final pay statement", status: "sent", bodyText: statement, sha256: sha256Hex(statement), createdAt: sent, sentAt: sent, signedAt: null });
    L.bump("documents");
    const opened = pt(addDays(l.end, l.termination === "involuntary" ? 0 : -14), 10);
    const caseId = await newId(tx, "ofb_");
    await tx.insert(offboardingCases).values({ id: caseId, companyId: CO, workerId: id, kind: l.termination, lastDay: l.end, reasonNote: l.reason, status: "complete", createdAt: opened, closedAt: pt(addDays(l.end, 3), 12) });
    for (const [kind, detail] of STEPS(l, login)) {
      await tx.insert(offboardingSteps).values({ id: await newId(tx, "ofs_"), caseId, kind, status: "done", detail, doneAt: pt(kind === "final_pay" ? l.end : addDays(l.end, 1), 10) });
    }
    L.bump("offboarding_cases");
    L.action({ ts: pt(addDays(l.start, -21), 10), actorKind: "human", actorId: "usr_sam", command: "people.create_worker", args: { worker_id: id }, summary: `Added ${l.first} ${l.last} (${id}) as ${l.title}, starting ${l.start}`, reversible: "no" });
    L.action({ ts: opened, actorKind: "human", actorId: "usr_sam", command: "offboarding.start", args: { worker_id: id, last_day: l.end }, summary: `Started offboarding for ${l.first} ${l.last} (${id}), last day ${l.end}`, reversible: "no" });
  }
  await importLeaverYtd(tx, L.bump);
}

/** Engine-computed YTD import (Jan 1 to Aug 31) for 2026 leavers that have none, as writeOpeningYtd does for staff. */
async function importLeaverYtd(tx: DbTx, bump: TurnoverApi["bump"]): Promise<void> {
  const leavers = (await tx.select().from(workers).where(and(eq(workers.companyId, CO), eq(workers.type, "employee"), eq(workers.status, "inactive"), isNotNull(workers.endDate), like(workers.endDate, "2026-%"))))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const withRows = new Set((await tx.select({ w: ytdLedger.workerId }).from(ytdLedger).where(eq(ytdLedger.year, 2026))).map((r) => r.w));
  const todo = leavers.filter((w) => !withRows.has(w.id) && w.endDate! <= "2026-08-31");
  if (!todo.length) return;
  const world = await payroll.loadWorld(tx, CO, todo.map((w) => w.id));
  const periods = payroll.semimonthlyPeriodsThrough(2026, "2026-08-31");
  for (const w of todo) {
    const ytd: Record<string, number> = {};
    for (const p of periods) {
      if (w.startDate > p.periodEnd || (w.endDate !== null && w.endDate < p.periodStart)) continue;
      const spec = { companyId: CO, payScheduleId: "ps_us_semimonthly", ...p, payday: payroll.previousBusinessDayOnOrBefore(p.periodEnd) };
      const cp = payroll.computeWorkerPaycheck(w, spec, world, { ...ytd }, { defaultHoursX100: payroll.IMPORT_DEFAULT_HOURS_X100 });
      for (const [k, v] of Object.entries(cp.calc.ytdDeltas)) ytd[k] = (ytd[k] ?? 0) + v;
    }
    const values = Object.entries(ytd).filter(([, v]) => v !== 0).sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, amountCents]) => ({ workerId: w.id, year: 2026, code, amountCents, source: "import" }));
    if (values.length) { await tx.insert(ytdLedger).values(values); bump("ytd_ledger", values.length); }
  }
}
