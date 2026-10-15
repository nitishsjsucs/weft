// Seed step "people" (SPEC 5.2). Owner: t2-world. 48 W-2 employees (CA 22, NY 14, TX 12), 3 global contractors,
// pay rates, W-4 and state profiles, synthetic bank accounts, TX tech hours, department leads and Noor's offer.
import { eq } from "drizzle-orm";
import { bankAccounts, departments, offers, payRates, taxProfiles, timeEntries, workers } from "@weft/db";
import { newId, workEmail } from "@weft/core";
import type { SeedContext } from "./context";
import type { DepartmentId } from "./company";

type State = "CA" | "NY" | "TX";
type Filing = "single" | "mfj" | "hoh";
export interface RosterEntry {
  key: string; first: string; last: string; state: State; workplace: string; dept: DepartmentId; title: string;
  pay: { kind: "salary" | "hourly"; cents: number }; start: string; filing: Filing;
  lead?: true; end?: string; noBank?: true; pre2020?: { allowances: number }; step2?: true; step3?: number;
  step4?: { a?: number; b?: number; c?: number }; profile?: { preferredName?: string; personalEmail?: string; homeAddress?: Record<string, string> };
}

const S = (cents: number) => ({ kind: "salary" as const, cents });
const H = (cents: number) => ({ kind: "hourly" as const, cents });

/** Employee roster in employee-number order: index i is EMP-000(i+1) and wrk_000(i+1). */
export const ROSTER: readonly RosterEntry[] = [
  // CA (22)
  { key: "dana", first: "Dana", last: "Whitfield", state: "CA", workplace: "wkp_oakland", dept: "dpt_people", title: "Head of People", pay: S(18_500_000), start: "2023-03-01", filing: "mfj", lead: true, step3: 400_000 },
  { key: "theo", first: "Theo", last: "Marsh", state: "CA", workplace: "wkp_oakland", dept: "dpt_finance", title: "Payroll Lead", pay: S(14_200_000), start: "2023-06-12", filing: "single" },
  { key: "priya", first: "Priya", last: "Raman", state: "CA", workplace: "wkp_oakland", dept: "dpt_engineering", title: "VP Engineering", pay: S(24_500_000), start: "2023-03-01", filing: "mfj", lead: true },
  { key: "imani", first: "Imani", last: "Ferreira", state: "CA", workplace: "wkp_oakland", dept: "dpt_hardware", title: "Hardware Lead", pay: S(23_200_000), start: "2023-04-03", filing: "single", lead: true },
  { key: "mateo", first: "Mateo", last: "Alvarez", state: "CA", workplace: "wkp_oakland", dept: "dpt_engineering", title: "Senior Software Engineer", pay: S(17_600_000), start: "2023-09-05", filing: "single" },
  { key: "hana", first: "Hana", last: "Kobayashi", state: "CA", workplace: "wkp_oakland", dept: "dpt_engineering", title: "Software Engineer", pay: S(14_800_000), start: "2024-01-08", filing: "single", step2: true },
  { key: "felix", first: "Felix", last: "Wainwright", state: "CA", workplace: "wkp_oakland", dept: "dpt_engineering", title: "Staff Software Engineer", pay: S(19_800_000), start: "2023-07-17", filing: "mfj", step4: { c: 15_000 } },
  { key: "grace", first: "Grace", last: "Adeyemi", state: "CA", workplace: "wkp_oakland", dept: "dpt_hardware", title: "Robotics Engineer", pay: S(16_200_000), start: "2024-03-11", filing: "hoh", step3: 200_000 },
  { key: "oscar", first: "Oscar", last: "Lindqvist", state: "CA", workplace: "wkp_oakland", dept: "dpt_hardware", title: "Mechanical Engineer", pay: S(15_400_000), start: "2024-05-20", filing: "mfj", pre2020: { allowances: 3 } },
  { key: "ruth", first: "Ruth", last: "Okoro", state: "CA", workplace: "wkp_oakland", dept: "dpt_hardware", title: "Firmware Engineer", pay: S(15_800_000), start: "2024-08-12", filing: "single" },
  { key: "samir", first: "Samir", last: "Haddad", state: "CA", workplace: "wkp_oakland", dept: "dpt_hardware", title: "Controls Engineer", pay: S(14_400_000), start: "2025-02-03", filing: "single" },
  { key: "lucia", first: "Lucia", last: "Benton", state: "CA", workplace: "wkp_remote", dept: "dpt_engineering", title: "Product Designer", pay: S(13_600_000), start: "2024-10-14", filing: "single" },
  { key: "nadia", first: "Nadia", last: "Petrova", state: "CA", workplace: "wkp_remote", dept: "dpt_engineering", title: "Data Engineer", pay: S(15_200_000), start: "2025-01-13", filing: "mfj" },
  { key: "caleb", first: "Caleb", last: "Whitaker", state: "CA", workplace: "wkp_oakland", dept: "dpt_finance", title: "Accountant", pay: S(9_800_000), start: "2024-06-03", filing: "single" },
  { key: "ivy", first: "Ivy", last: "Moreau", state: "CA", workplace: "wkp_oakland", dept: "dpt_people", title: "Recruiter", pay: S(10_400_000), start: "2024-09-09", filing: "single" },
  { key: "jonah", first: "Jonah", last: "Pell", state: "CA", workplace: "wkp_oakland", dept: "dpt_engineering", title: "QA Engineer", pay: S(11_800_000), start: "2025-03-17", filing: "single" },
  { key: "elise", first: "Elise", last: "Navarro", state: "CA", workplace: "wkp_oakland", dept: "dpt_operations", title: "Supply Chain Manager", pay: S(12_600_000), start: "2024-04-22", filing: "hoh", step3: 200_000 },
  { key: "kofi", first: "Kofi", last: "Mensah", state: "CA", workplace: "wkp_oakland", dept: "dpt_hardware", title: "Hardware Test Engineer", pay: S(12_200_000), start: "2025-05-05", filing: "single" },
  { key: "wren", first: "Wren", last: "Calloway", state: "CA", workplace: "wkp_remote", dept: "dpt_gtm", title: "Solutions Engineer", pay: S(13_800_000), start: "2024-11-04", filing: "single" },
  { key: "ana", first: "Ana", last: "Sousa", state: "CA", workplace: "wkp_oakland", dept: "dpt_engineering", title: "Software Engineer", pay: S(9_600_000), start: "2026-10-01", filing: "single" },
  { key: "ben", first: "Ben", last: "Ashdown", state: "CA", workplace: "wkp_oakland", dept: "dpt_hardware", title: "Hardware Technician", pay: S(8_800_000), start: "2026-10-01", filing: "single" },
  { key: "mira", first: "Mira", last: "Delgado", state: "CA", workplace: "wkp_oakland", dept: "dpt_hardware", title: "Robotics Engineer", pay: S(10_400_000), start: "2026-10-19", filing: "single", noBank: true },
  // NY (14)
  { key: "elena", first: "Elena", last: "Vasquez", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_finance", title: "Finance Lead", pay: S(19_000_000), start: "2023-05-01", filing: "mfj", lead: true, step4: { a: 1_200_000 } },
  { key: "jordan", first: "Jordan", last: "Pike", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_gtm", title: "Head of Go-to-market", pay: S(19_500_000), start: "2023-08-14", filing: "single", lead: true },
  { key: "sam", first: "Sam", last: "Okafor", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_people", title: "HR Generalist", pay: S(9_200_000), start: "2024-02-05", filing: "single" },
  { key: "lena", first: "Lena", last: "Brooks", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_gtm", title: "Account Executive", pay: S(11_800_000), start: "2024-03-04", filing: "single" },
  { key: "owen", first: "Owen", last: "Mercer", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_gtm", title: "Customer Success Manager", pay: S(9_600_000), start: "2024-07-08", filing: "single", end: "2026-10-23" },
  { key: "talia", first: "Talia", last: "Brennan", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_gtm", title: "Marketing Manager", pay: S(12_400_000), start: "2024-05-13", filing: "hoh", step3: 400_000 },
  { key: "desmond", first: "Desmond", last: "Clarke", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_gtm", title: "Account Executive", pay: S(11_200_000), start: "2024-09-16", filing: "single", step2: true },
  { key: "yara", first: "Yara", last: "Haddon", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_finance", title: "Financial Analyst", pay: S(10_200_000), start: "2025-01-06", filing: "single" },
  { key: "rhea", first: "Rhea", last: "Kapoor", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_gtm", title: "Sales Development Representative", pay: S(7_400_000), start: "2025-03-03", filing: "single" },
  { key: "tomasz", first: "Tomasz", last: "Nowak", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_gtm", title: "Partnerships Manager", pay: S(13_200_000), start: "2024-06-10", filing: "mfj", profile: { preferredName: "Tom" } },
  { key: "abigail", first: "Abigail", last: "Ford", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_finance", title: "Payroll Specialist", pay: S(8_600_000), start: "2025-02-18", filing: "single" },
  { key: "kenji", first: "Kenji", last: "Watanabe", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_gtm", title: "Solutions Architect", pay: S(15_600_000), start: "2023-11-06", filing: "mfj", step3: 200_000 },
  { key: "sofia", first: "Sofia", last: "Marchetti", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_gtm", title: "Content Lead", pay: S(10_800_000), start: "2024-10-21", filing: "single", profile: { personalEmail: "sofia.m@mail.example" } },
  { key: "noah", first: "Noah", last: "Fairbanks", state: "NY", workplace: "wkp_brooklyn", dept: "dpt_operations", title: "Office Manager", pay: S(6_800_000), start: "2025-04-14", filing: "single" },
  // TX (12): 6 salaried, 6 hourly operations techs
  { key: "marcus", first: "Marcus", last: "Bell", state: "TX", workplace: "wkp_austin", dept: "dpt_operations", title: "Head of Operations", pay: S(16_800_000), start: "2023-06-05", filing: "mfj", lead: true, step3: 600_000 },
  { key: "lucy", first: "Lucy", last: "Harrow", state: "TX", workplace: "wkp_austin", dept: "dpt_operations", title: "Operations Manager", pay: S(11_400_000), start: "2024-02-12", filing: "single", step2: true },
  { key: "diego", first: "Diego", last: "Ramos", state: "TX", workplace: "wkp_austin", dept: "dpt_operations", title: "Logistics Coordinator", pay: S(6_200_000), start: "2024-08-05", filing: "single" },
  { key: "priscilla", first: "Priscilla", last: "Grant", state: "TX", workplace: "wkp_austin", dept: "dpt_operations", title: "Field Service Engineer", pay: S(9_800_000), start: "2024-11-11", filing: "hoh" },
  { key: "victor", first: "Victor", last: "Huang", state: "TX", workplace: "wkp_austin", dept: "dpt_engineering", title: "Fleet Software Engineer", pay: S(15_000_000), start: "2025-01-20", filing: "mfj" },
  { key: "hollis", first: "Hollis", last: "Grey", state: "TX", workplace: "wkp_austin", dept: "dpt_operations", title: "Facilities Lead", pay: S(7_600_000), start: "2025-03-10", filing: "single", profile: { homeAddress: { line1: "100 Example Row", city: "Austin", state: "TX", postalCode: "00000" } } },
  { key: "arturo", first: "Arturo", last: "Silva", state: "TX", workplace: "wkp_austin", dept: "dpt_operations", title: "Operations Technician", pay: H(2_800), start: "2024-04-01", filing: "single" },
  { key: "bethany", first: "Bethany", last: "Cole", state: "TX", workplace: "wkp_austin", dept: "dpt_operations", title: "Operations Technician", pay: H(3_000), start: "2024-06-17", filing: "mfj" },
  { key: "curtis", first: "Curtis", last: "Doyle", state: "TX", workplace: "wkp_austin", dept: "dpt_operations", title: "Operations Technician", pay: H(3_200), start: "2024-09-03", filing: "single" },
  { key: "dalia", first: "Dalia", last: "Farouk", state: "TX", workplace: "wkp_austin", dept: "dpt_operations", title: "Operations Technician", pay: H(3_400), start: "2025-01-13", filing: "single" },
  { key: "emmett", first: "Emmett", last: "Shaw", state: "TX", workplace: "wkp_austin", dept: "dpt_operations", title: "Senior Operations Technician", pay: H(3_600), start: "2025-02-24", filing: "hoh" },
  { key: "flora", first: "Flora", last: "Quinn", state: "TX", workplace: "wkp_austin", dept: "dpt_operations", title: "Operations Technician", pay: H(3_100), start: "2025-04-07", filing: "single" },
];

export interface ContractorEntry { key: string; first: string; last: string; city: string; country: string; currency: "EUR" | "INR" | "CAD"; timezone: string; dept: DepartmentId; title: string; monthlyMinor: number; start: string }
export const CONTRACTORS: readonly ContractorEntry[] = [
  { key: "ines", first: "Ines", last: "Carvalho", city: "Lisbon", country: "PT", currency: "EUR", timezone: "Europe/Lisbon", dept: "dpt_engineering", title: "Product Design Contractor", monthlyMinor: 650_000, start: "2025-06-02" },
  { key: "arjun", first: "Arjun", last: "Kulkarni", city: "Pune", country: "IN", currency: "INR", timezone: "Asia/Kolkata", dept: "dpt_hardware", title: "Firmware Contractor", monthlyMinor: 41_000_000, start: "2025-08-04" },
  { key: "claire", first: "Claire", last: "Tremblay", city: "Toronto", country: "CA", currency: "CAD", timezone: "America/Toronto", dept: "dpt_engineering", title: "Data Engineering Contractor", monthlyMinor: 980_000, start: "2025-09-15" },
];

/** Noor's HR-entered offer (SPEC 5.2). */
export const NOOR_OFFER = {
  id: "offr_0001", candidateFirst: "Noor", candidateLast: "Castellanos", candidateEmail: "noor.castellanos@candidate.example",
  title: "Senior Firmware Engineer", departmentId: "dpt_hardware", workplaceId: "wkp_remote", workState: "CO",
  baseCents: 16_800_000, payKind: "salary", startDate: "2026-11-02", status: "sent",
} as const;

/** The 4 semi-monthly periods with time entries: 3 processed runs and the Oct 16 to 31 draft. */
export const TECH_PERIODS = [["2026-09-01", "2026-09-15"], ["2026-09-16", "2026-09-30"], ["2026-10-01", "2026-10-15"], ["2026-10-16", "2026-10-31"]] as const;
export const STEADY_HOURS_X100 = 8_667;
export const SPIKE_HOURS_X100 = 12_000;
export const SPIKE_TECH_KEY = "flora";

export const TIMEZONE: Record<State, string> = { CA: "America/Los_Angeles", NY: "America/New_York", TX: "America/Chicago" };
const STATE_ALLOWANCES: Record<Filing, number> = { single: 1, mfj: 2, hoh: 1 };
const STATE_FILING: Record<Filing, string> = { single: "single", mfj: "married", hoh: "head_of_household" };

/** wrk id for a roster key, by roster order (employees first, then contractors). */
export function seedWorkerId(key: string): string {
  const i = ROSTER.findIndex((r) => r.key === key);
  const j = CONTRACTORS.findIndex((c) => c.key === key);
  const n = i >= 0 ? i + 1 : j >= 0 ? ROSTER.length + j + 1 : -1;
  if (n < 0) throw new Error(`seedWorkerId: unknown key ${key}`);
  return `wrk_${String(n).padStart(4, "0")}`;
}

export async function seedPeople(ctx: SeedContext): Promise<void> {
  const { db, faker, companyId } = ctx;
  const now = ctx.clock.now();
  const ids = new Map<string, string>();
  for (const r of ROSTER) ids.set(r.key, await newId(db, "wrk_"));
  for (const c of CONTRACTORS) ids.set(c.key, await newId(db, "wrk_"));
  const leadOf = new Map<DepartmentId, string>();
  for (const r of ROSTER) if (r.lead) leadOf.set(r.dept, ids.get(r.key)!);
  const managerFor = (key: string, dept: DepartmentId, isLead: boolean) => {
    if (key === "theo" || key === "abigail") return leadOf.get("dpt_finance")!;
    return isLead ? null : leadOf.get(dept) ?? null;
  };

  for (const [i, r] of ROSTER.entries()) {
    const id = ids.get(r.key)!;
    await db.insert(workers).values({
      id, companyId, employeeNumber: `EMP-${String(i + 1).padStart(4, "0")}`, type: "employee", workerType: "us_w2", status: "active",
      firstName: r.first, lastName: r.last,
      preferredName: r.profile?.preferredName ?? null, personalEmail: r.profile?.personalEmail ?? null,
      homeAddressJson: r.profile?.homeAddress ? JSON.stringify(r.profile.homeAddress) : null,
      workEmail: workEmail(r.first, r.last), title: r.title, departmentId: r.dept, managerId: managerFor(r.key, r.dept, !!r.lead),
      workplaceId: r.workplace, workState: r.state, country: "US", currency: "USD", timezone: TIMEZONE[r.state],
      startDate: r.start, endDate: r.end ?? null, ssnLast4: faker.string.numeric(4), payScheduleId: "ps_us_semimonthly",
      createdAt: now, updatedAt: now,
    });
    await db.insert(payRates).values({ id: await newId(db, "prt_"), workerId: id, kind: r.pay.kind, amountCents: r.pay.cents, currency: "USD", effectiveFrom: r.start, effectiveTo: null, createdActionSeq: null });
    const filing = r.pre2020 ? "mfj" : r.filing;
    await db.insert(taxProfiles).values({
      workerId: id, w4Version: r.pre2020 ? "pre2020" : "2020", filingStatus: filing, step2Checkbox: !!r.step2, step3Cents: r.step3 ?? 0,
      step4aCents: r.step4?.a ?? 0, step4bCents: r.step4?.b ?? 0, step4cCents: r.step4?.c ?? 0, allowances: r.pre2020?.allowances ?? 0,
      stateFilingStatus: r.state === "TX" ? null : STATE_FILING[filing], stateAllowances: r.state === "TX" ? 0 : r.pre2020?.allowances ?? STATE_ALLOWANCES[filing],
      exempt: false, source: "seed",
    });
    if (!r.noBank) {
      const bid = await newId(db, "bnk_");
      await db.insert(bankAccounts).values({ id: bid, workerId: id, bankName: "Sim Federal Credit Union", accountLast4: faker.string.numeric(4), routingLast4: faker.string.numeric(4), credentialRef: `vault:bank-${id}`, status: "active", source: "seed" });
    }
    if (r.pay.kind === "hourly") {
      for (const [k, [start, end]] of TECH_PERIODS.entries()) {
        const spike = r.key === SPIKE_TECH_KEY && k === TECH_PERIODS.length - 1;
        await db.insert(timeEntries).values({
          id: await newId(db, "tim_"), workerId: id, periodStart: start, periodEnd: end,
          regularHoursX100: STEADY_HOURS_X100, overtimeHoursX100: spike ? SPIKE_HOURS_X100 - STEADY_HOURS_X100 : 0, source: "seed",
        });
      }
    }
  }

  for (const c of CONTRACTORS) {
    const id = ids.get(c.key)!;
    await db.insert(workers).values({
      id, companyId, employeeNumber: null, type: "contractor", workerType: "global_contractor", status: "active",
      firstName: c.first, lastName: c.last, preferredName: null, personalEmail: null, homeAddressJson: null,
      workEmail: workEmail(c.first, c.last), title: c.title, departmentId: c.dept, managerId: leadOf.get(c.dept) ?? null,
      workplaceId: null, workState: null, country: c.country, currency: c.currency, timezone: c.timezone,
      startDate: c.start, endDate: null, ssnLast4: null, payScheduleId: "ps_global_monthly", createdAt: now, updatedAt: now,
    });
    await db.insert(payRates).values({ id: await newId(db, "prt_"), workerId: id, kind: "contract_monthly", amountCents: c.monthlyMinor, currency: c.currency, effectiveFrom: c.start, effectiveTo: null, createdActionSeq: null });
  }

  for (const [dept, lead] of leadOf) await db.update(departments).set({ leadWorkerId: lead }).where(eq(departments.id, dept));

  const offerId = await newId(db, "offr_");
  if (offerId !== NOOR_OFFER.id) throw new Error(`seedPeople: expected ${NOOR_OFFER.id}, got ${offerId}`);
  await db.insert(offers).values({ ...NOOR_OFFER, companyId, managerId: leadOf.get("dpt_hardware")!, acceptedAt: null, workerId: null });
}
