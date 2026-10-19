// Rich profile, part 4: the people who joined and left during 2026, so Reports has a hiring curve and every
// departure it counts is a real record. Summer interns (June to August), a seasonal field technician at the Austin
// Yard (March to August), a quality inspector who left in May and a sales hire let go in June. Each one is an
// inactive worker with a pay rate, a tax profile, signed documents, a finished onboarding checklist and a completed
// offboarding case.
//
// Their year-to-date import is computed with the payroll engine (the same computeWorkerPaycheck loop the base seed's
// writeOpeningYtd runs, end date included), so the imported January to August runs pay them period by period and the
// totals still equal the ledger code by code. Current workers' ledger rows are never touched, so a recomputed draft is
// identical to the base seed's. Rafael Ostrander (demo), the July leaver from part 1, gets his import here too.
import { and, eq, isNotNull, like } from "drizzle-orm";
import { documents, offboardingCases, offboardingSteps, onboardingTasks, payRates, taxProfiles, workers, ytdLedger, type DbTx } from "@weft/db";
import { newId, payroll, sha256Hex } from "@weft/core";

const CO = "cmp_larkspur";
const pt = (date: string, hour: number, minute = 0) => payroll.ptToUtc(date, hour, minute);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const DEMO_DOC = "DEMO DOCUMENT. Fictional company, fictional person, simulated signature. Not a real record.";

export interface TurnoverApi { tx: DbTx; bump: (table: string, n?: number) => void; action: (a: Record<string, unknown>) => void }

type Leaver = {
  first: string; last: string; title: string; dept: string; wkp: string; state: string; tz: string; empNo: string; kind: "salary" | "hourly"; rateCents: number;
  start: string; end: string; termination: "voluntary" | "involuntary" | "end_of_contract"; reason: string;
};

export const LEAVERS: readonly Leaver[] = [
  { first: "Wen", last: "Calloway", title: "Quality Inspector", dept: "dpt_operations", wkp: "wkp_oakland", state: "CA", tz: "America/Los_Angeles", empNo: "EMP-0093", kind: "salary", rateCents: 6_400_000,
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

const STEPS = (l: Leaver, login: string): [string, string][] => [
  ["final_pay", `Final pay included on the regular run for the period that holds ${l.end}`], ["directory_suspend", `Suspended Google Workspace (sim) ${login}`],
  ["sso_deactivate", `Suspended SSO (sim) ${login}`], ["group_removal", "Removed group memberships"], ["app_removal", `Removed Team chat (sim) ${login}`],
  ["device_lock", "Device locked and returned"], ["cobra_notice", l.kind === "hourly" && l.title.includes("Intern") ? "Not enrolled in a group health plan, so no COBRA notice is due" : `COBRA notice emailed to ${login}@mail.example`],
  ["benefits_terminate", l.title.includes("Intern") ? "No enrollments to end" : `Terminated enrollments, effective to the end of ${l.end.slice(0, 7)}`],
];

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
    for (const k of ["sign_offer", "federal_w4", "state_withholding", "direct_deposit", "i9_sim", "benefits_selection", "it_accounts"]) {
      await tx.insert(onboardingTasks).values({ id: await newId(tx, "obt_"), workerId: id, kind: k, status: "done", owner: k === "i9_sim" ? "hr" : k === "it_accounts" ? "agent" : "employee",
        dueOn: l.start, doneAt: pt(addDays(l.start, -4), 11) });
      L.bump("onboarding_tasks");
    }
    const signed = pt(addDays(l.start, -10), 10);
    for (const [kind, title] of [["offer_letter", `Offer letter: ${l.title}`], ["confidentiality_agreement", "Confidentiality and invention assignment agreement"], ["w4", "Form W-4, employee's withholding certificate"], ["i9", "Form I-9 receipt (masked)"]] as const) {
      const body = `${DEMO_DOC}\n\n${title}\nLarkspur Robotics (demo)\n${l.first} ${l.last} (demo)\nSigned ${signed.slice(0, 10)}.`;
      await tx.insert(documents).values({ id: await newId(tx, "doc_"), companyId: CO, workerId: id, offerId: null, kind, title, status: "signed", bodyText: body, sha256: sha256Hex(body), createdAt: signed, sentAt: signed, signedAt: signed });
      L.bump("documents");
    }
    const sent = pt(l.end, 16);
    const statement = `${DEMO_DOC}\n\nFinal pay statement\nLarkspur Robotics (demo)\n${l.first} ${l.last} (demo)\nLast day ${l.end}. Final wages paid on the regular run for that period.`;
    await tx.insert(documents).values({ id: await newId(tx, "doc_"), companyId: CO, workerId: id, offerId: null, kind: "final_pay_statement", title: "Final pay statement", status: "sent", bodyText: statement, sha256: sha256Hex(statement), createdAt: sent, sentAt: sent, signedAt: null });
    L.bump("documents");
    const opened = pt(addDays(l.end, l.termination === "involuntary" ? 0 : -14), 10);
    const caseId = await newId(tx, "ofb_");
    await tx.insert(offboardingCases).values({ id: caseId, companyId: CO, workerId: id, kind: l.termination, lastDay: l.end, reasonNote: l.reason, status: "complete", createdAt: opened, closedAt: pt(addDays(l.end, 3), 12) });
    for (const [kind, detail] of STEPS(l, login)) {
      await tx.insert(offboardingSteps).values({ id: await newId(tx, "ofs_"), caseId, kind, status: "done", detail, doneAt: pt(kind === "final_pay" ? l.end : addDays(l.end, 1), 10) });
    }
    L.bump("offboarding_cases");
    L.action({ ts: pt(addDays(l.start, -21), 10), actorKind: "human", actorId: "usr_sam", command: "people.create_worker", args: { worker_id: id }, summary: `Added ${l.first} ${l.last} (demo) (${id}) as ${l.title}, starting ${l.start}`, reversible: "no" });
    L.action({ ts: opened, actorKind: "human", actorId: "usr_sam", command: "offboarding.start", args: { worker_id: id, last_day: l.end }, summary: `Started offboarding for ${l.first} ${l.last} (demo) (${id}), last day ${l.end}`, reversible: "no" });
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
