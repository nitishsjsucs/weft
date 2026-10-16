// Seed step w3_timeoff (wave 3, docs/wave3.md). Owner: w3-timeoff. Deterministic; plans: types, policies, assignments, imported balances (Imani 5,063 minutes), the 2026 holiday calendar, requests R-A to R-D, the manager principal usr_imani.
// Never change wave 1 or wave 2 seed counts (SPEC 5.2 numbers are asserted by tests) and never touch processed runs.
// Opening balances are `import` rows dated 2026-10-15 ("imported from the previous provider"), computed from the
// start date and a fixed usage share, never above a cap. Requests go through the real time_off.submit and
// time_off.decide commands (runDirect: no action rows, no events), so their minutes, checks and routing are the
// engine's own. Research: research/wave3/expenses-timeoff.md 8.1.
import { and, eq } from "drizzle-orm";
import { holidayCalendars, holidays, principals, timeOffAssignments, timeOffLedger, timeOffPolicies, timeOffTypes, withWriteLock, workers } from "@weft/db";
import { directCtx, directDeps, newId, runDirect } from "@weft/core";
import type { ExecContext } from "@weft/contracts";
import type { SeedContext } from "./context";

export const IMPORT_DATE = "2026-10-15";
export const IMANI_VACATION_IMPORT = 5_063;   // GP9: 5,063 + floor(360 x 15 / 16) = 5,400 minutes = 90.00 h
export const TIME_OFF_REQUESTS = { grace: "tor_0001", oscar: "tor_0002", ruth: "tor_0003", kenji: "tor_0004", ben: "tor_0005", lucy: "tor_0006" } as const;

const src = (label: string, url: string) => ({ label, url });
const DLSE_VAC = src("CA DLSE vacation FAQ", "https://www.dir.ca.gov/dlse/faq_vacation.htm");
const DLSE_PSL = src("CA DLSE paid sick leave FAQ", "https://www.dir.ca.gov/dlse/Paid_Sick_Leave.htm");
const NYS_PSL = src("NY State paid sick leave", "https://www.ny.gov/new-york-paid-sick-leave/new-york-paid-sick-leave");
const NYC_FAQ = src("NYC Earned Safe and Sick Time FAQ", "https://www.nyc.gov/site/dca/about/paid-sick-leave-FAQs.page");
const NYS_PRE = src("NY State paid prenatal leave", "https://www.ny.gov/new-york-paid-prenatal-leave");
const CO_HFWA = src("CO Healthy Families and Workplaces Act (INFO 6B)", "https://cdle.colorado.gov/infos");
const TWC = src("Texas Workforce Commission: vacation and sick pay", "https://www.twc.texas.gov/news/efte/vacation_sick_leave.html");

export const TIME_OFF_TYPES = [
  { id: "tot_vacation", kind: "vacation", name: "Vacation", paid: true, countsAsVacation: true },
  { id: "tot_sick", kind: "sick", name: "Sick leave", paid: true, countsAsVacation: false },
  { id: "tot_unpaid_sick", kind: "unpaid_sick", name: "Unpaid safe and sick time", paid: false, countsAsVacation: false },
  { id: "tot_prenatal", kind: "prenatal", name: "Prenatal leave", paid: true, countsAsVacation: false },
] as const;

type PolicySeed = Omit<typeof timeOffPolicies.$inferInsert, "companyId" | "tiersJson" | "sourcesJson"> & { tiers?: { min_service_months: number; minutes_per_period: number }[]; sources: { label: string; url: string }[] };
export const TIME_OFF_POLICIES: readonly PolicySeed[] = [
  { id: "top_vac_us", typeId: "tot_vacation", name: "Larkspur Vacation", jurisdiction: "US", schedule: "per_pay_period", minutesPerPeriod: 300,
    tiers: [{ min_service_months: 0, minutes_per_period: 300 }, { min_service_months: 36, minutes_per_period: 360 }], accrualCapMinutes: 10_800, carryoverCapMinutes: null,
    minIncrementMinutes: 60, payOutAtSeparation: true, effectiveFrom: "2023-01-01", sources: [DLSE_VAC, TWC] },
  { id: "top_sick_ca", typeId: "tot_sick", name: "California sick leave", jurisdiction: "CA", schedule: "per_hour_worked", workedMinutesPerChunk: 30, minutesPerChunk: 1,
    exemptDeemedMinutesPerWeek: 2_400, accrualCapMinutes: 4_800, waitingDaysBeforeUse: 90, minIncrementMinutes: 60, reinstateWithinDays: 365, effectiveFrom: "2024-01-01", sources: [DLSE_PSL] },
  { id: "top_sick_ny", typeId: "tot_sick", name: "New York City sick leave", jurisdiction: "NY-NYC", schedule: "per_hour_worked", workedMinutesPerChunk: 30, minutesPerChunk: 1,
    exemptDeemedMinutesPerWeek: 2_400, annualUseCapMinutes: 2_400, carryoverCapMinutes: 2_400, minIncrementMinutes: 60, reinstateWithinDays: 183, effectiveFrom: "2024-01-01", sources: [NYS_PSL, NYC_FAQ] },
  { id: "top_unpaid_nyc", typeId: "tot_unpaid_sick", name: "NYC unpaid safe and sick time", jurisdiction: "NY-NYC", schedule: "front_load_annual", frontLoadMinutes: 1_920,
    carryoverCapMinutes: 0, minIncrementMinutes: 60, effectiveFrom: "2026-02-22", sources: [NYC_FAQ] },
  { id: "top_prenatal_ny", typeId: "tot_prenatal", name: "New York prenatal leave", jurisdiction: "NY", schedule: "front_load_annual", frontLoadMinutes: 1_200,
    carryoverCapMinutes: 0, minIncrementMinutes: 60, effectiveFrom: "2025-01-01", sources: [NYS_PRE] },
  { id: "top_sick_co", typeId: "tot_sick", name: "Colorado sick leave", jurisdiction: "CO", schedule: "per_hour_worked", workedMinutesPerChunk: 30, minutesPerChunk: 1,
    exemptDeemedMinutesPerWeek: 2_400, annualAccrualCapMinutes: 2_880, carryoverCapMinutes: 2_880, annualUseCapMinutes: 2_880, minIncrementMinutes: 60, effectiveFrom: "2024-01-01", sources: [CO_HFWA] },
  { id: "top_sick_tx", typeId: "tot_sick", name: "Texas sick leave", jurisdiction: "TX", schedule: "front_load_annual", frontLoadMinutes: 2_400, carryoverCapMinutes: 0,
    minIncrementMinutes: 60, effectiveFrom: "2024-01-01", sources: [TWC] },
];

/** Company holidays for 2026 (federal dates from OPM; the day after Thanksgiving is Larkspur's own choice). */
export const HOLIDAYS_2026: readonly [string, string][] = [
  ["2026-01-01", "New Year's Day"], ["2026-01-19", "Martin Luther King Jr. Day"], ["2026-02-16", "Presidents' Day"], ["2026-05-25", "Memorial Day"],
  ["2026-06-19", "Juneteenth"], ["2026-07-03", "Independence Day (observed)"], ["2026-09-07", "Labor Day"], ["2026-11-26", "Thanksgiving Day"],
  ["2026-11-27", "Day after Thanksgiving"], ["2026-12-25", "Christmas Day"],
];

const POLICIES_BY_STATE: Record<string, string[]> = {
  CA: ["top_vac_us", "top_sick_ca"], NY: ["top_vac_us", "top_sick_ny", "top_unpaid_nyc", "top_prenatal_ny"], TX: ["top_vac_us", "top_sick_tx"], CO: ["top_vac_us", "top_sick_co"],
};
const USAGE_SHARE = [55, 62, 48, 70, 58] as const;   // percent of accrued vacation already used, by worker index

/** Semi-monthly period ends after `start` and on or before `through`. */
function periodEnds(start: string, through: string): string[] {
  const out: string[] = [];
  for (let y = Number(start.slice(0, 4)); y <= Number(through.slice(0, 4)); y++) {
    for (let m = 1; m <= 12; m++) {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (const d of [15, last]) {
        const end = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        if (end > start && end <= through) out.push(end);
      }
    }
  }
  return out;
}
function months(start: string, on: string): number {
  const [sy, sm, sd] = start.split("-").map(Number) as [number, number, number];
  const [oy, om, od] = on.split("-").map(Number) as [number, number, number];
  return Math.max(0, (oy - sy) * 12 + (om - sm) - (od < sd ? 1 : 0));
}
const weekdays = (from: string, to: string) => {
  let n = 0;
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86_400_000) { const g = new Date(t).getUTCDay(); if (g !== 0 && g !== 6) n++; }
  return n;
};

/** Opening vacation balance on the import date: accrued by tier per period, minus a fixed usage share, rounded to whole days, under the cap. */
export function vacationImport(start: string, index: number): number {
  let accrued = 0;
  for (const end of periodEnds(start, IMPORT_DATE)) accrued += months(start, end) >= 36 ? 360 : 300;
  const used = Math.floor((accrued * USAGE_SHARE[index % USAGE_SHARE.length]!) / 100 / 480) * 480;
  const cap = months(start, IMPORT_DATE) >= 36 ? 12_960 : 10_800;
  return Math.max(0, Math.min(cap, accrued - used));
}

/** Opening CA or CO sick balance: 1 per 30 deemed worked minutes this year (5,200 a full period), minus usage, under the cap. */
export function sickImport(start: string, index: number, cap: number): number {
  const from = start > "2026-01-01" ? start : "2026-01-01";
  let worked = 0;
  for (const end of periodEnds("2025-12-31", IMPORT_DATE)) {
    const ps = end.endsWith("-15") ? `${end.slice(0, 8)}01` : `${end.slice(0, 8)}16`;
    if (end < from) continue;
    worked += from <= ps ? 5_200 : Math.floor((2_400 * weekdays(from, end)) / 5);
  }
  const accrued = Math.floor(worked / 30);
  const used = Math.min(Math.floor(accrued / 480) * 480, (index % 3) * 480);
  return Math.min(cap, accrued - used);
}

const DANA_CTX = { principal: { id: "usr_dana", kind: "human" as const, role: "admin" }, onBehalfOf: null, surface: "human_ui" as const, agentKind: null };
const IMANI_CTX = { principal: { id: "usr_imani", kind: "human" as const, role: "manager" }, onBehalfOf: null, surface: "human_ui" as const, agentKind: null };

export async function seedW3TimeOff(ctx: SeedContext): Promise<void> {
  const { db, companyId, clock } = ctx;
  const now = clock.now();
  for (const t of TIME_OFF_TYPES) await db.insert(timeOffTypes).values({ ...t, companyId }).onConflictDoNothing();
  for (const { tiers, sources, ...p } of TIME_OFF_POLICIES) {
    await db.insert(timeOffPolicies).values({ ...p, companyId, tiersJson: JSON.stringify(tiers ?? []), sourcesJson: JSON.stringify(sources) }).onConflictDoNothing();
  }
  await db.insert(holidayCalendars).values({ id: "hcal_2026", companyId, name: "Larkspur holidays 2026", year: 2026 }).onConflictDoNothing();
  for (const [d, name] of HOLIDAYS_2026) await db.insert(holidays).values({ id: `hol_${d.replaceAll("-", "_")}`, calendarId: "hcal_2026", date: d, name, minutes: 480, workerTypes: "employee" }).onConflictDoNothing();

  // The one manager principal: Imani, Hardware lead, decides time off for her direct reports only (checked in time_off.decide).
  const [imani] = await db.select().from(workers).where(and(eq(workers.companyId, companyId), eq(workers.firstName, "Imani"), eq(workers.lastName, "Ferreira"))).limit(1);
  if (imani) {
    await db.insert(principals).values({
      id: "usr_imani", companyId, kind: "human", workerId: imani.id, display: "Imani Ferreira (demo)", email: imani.workEmail, role: "manager",
      grantsJson: JSON.stringify({ people: "view", payroll: "none", tax: "none", benefits: "none", it: "none", comms: "view", company: "view" }),
    }).onConflictDoNothing();
  }

  // Assignments and opening balances, in worker id order.
  const emps = (await db.select().from(workers).where(and(eq(workers.companyId, companyId), eq(workers.type, "employee")))).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const [index, w] of emps.entries()) {
    for (const policyId of POLICIES_BY_STATE[w.workState ?? "CA"] ?? POLICIES_BY_STATE.CA!) {
      const pol = TIME_OFF_POLICIES.find((p) => p.id === policyId)!;
      const from = w.startDate > pol.effectiveFrom ? w.startDate : pol.effectiveFrom;
      const asn = await newId(db, "tasn_");
      await db.insert(timeOffAssignments).values({ id: asn, policyId, workerId: w.id, assignedAt: now, effectiveFrom: from, effectiveTo: w.endDate, accrualRemainderMinutes: 0 });
      if (w.startDate > IMPORT_DATE) continue;   // hired after the import: accrues from the first run
      let minutes = 0;
      if (policyId === "top_vac_us") minutes = w.id === imani?.id ? IMANI_VACATION_IMPORT : vacationImport(w.startDate, index);
      else if (policyId === "top_sick_ca") minutes = sickImport(w.startDate, index, 4_800);
      else if (policyId === "top_sick_co") minutes = sickImport(w.startDate, index, 2_880);
      else if (policyId === "top_sick_ny") minutes = 1_200 + (index % 4) * 480;
      else if (policyId === "top_sick_tx") minutes = 2_400 - (index % 3) * 480;
      else if (policyId === "top_unpaid_nyc" || policyId === "top_prenatal_ny") minutes = pol.frontLoadMinutes ?? 0;
      if (minutes <= 0) continue;
      const frontLoad = policyId === "top_unpaid_nyc" || policyId === "top_prenatal_ny";
      await db.insert(timeOffLedger).values({
        id: await newId(db, "tol_"), assignmentId: asn, workerId: w.id, policyId, kind: frontLoad ? "front_load" : "import", minutes,
        effectiveDate: frontLoad ? (from > "2026-01-01" ? from : "2026-01-01") : IMPORT_DATE, sourceRef: null, runKey: null,
        note: frontLoad ? "front load for 2026" : "imported from the previous provider", actionSeq: null, createdAt: now,
      });
    }
  }

  // Requests through the real commands: Hardware coverage demo (R-A approved, R-B pending), a clean NY sick
  // request, a CA sick request inside the 90-day wait, and an approved TX vacation day inside the open draft.
  const byKey = (first: string, last: string) => emps.find((w) => w.firstName === first && w.lastName === last)?.id;
  const submit = async (first: string, last: string, policyId: string, start: string, end: string, reason: string, partial?: number) => {
    const workerId = byKey(first, last);
    if (!workerId) return null;
    return withWriteLock(() => db.transaction(async (tx) => {
      const out = await runDirect("time_off.submit", { worker_id: workerId, policy_id: policyId, start_date: start, end_date: end, reason, ...(partial ? { partial_day_minutes: partial } : {}) },
        directCtx(clock, DANA_CTX as Partial<ExecContext>), directDeps(tx, clock, ctx.sims));
      return (out.data as { request_id: string }).request_id;
    }));
  };
  const decide = async (requestId: string | null, by: typeof DANA_CTX) => {
    if (!requestId) return;
    await withWriteLock(() => db.transaction(async (tx) => {
      await runDirect("time_off.decide", { request_id: requestId, decision: "approve", note: "" }, directCtx(clock, by as Partial<ExecContext>), directDeps(tx, clock, ctx.sims));
    }));
  };
  await decide(await submit("Grace", "Adeyemi", "top_vac_us", "2026-11-23", "2026-11-25", "Thanksgiving week trip"), IMANI_CTX);
  await decide(await submit("Oscar", "Lindqvist", "top_vac_us", "2026-11-23", "2026-11-25", "Visiting family"), IMANI_CTX);
  await submit("Ruth", "Okoro", "top_vac_us", "2026-11-23", "2026-11-27", "Holiday week with family");
  await submit("Kenji", "Watanabe", "top_sick_ny", "2026-10-29", "2026-10-29", "Medical appointment", 240);
  await submit("Ben", "Ashdown", "top_sick_ca", "2026-10-28", "2026-10-28", "Feeling unwell");
  await decide(await submit("Lucy", "Harrow", "top_vac_us", "2026-10-23", "2026-10-23", "Long weekend"), DANA_CTX);
}
