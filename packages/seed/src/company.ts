// Seed step "company" (SPEC 5.1). Owner: t2-world. Company, 4 workplaces, 6 departments (leads set by the
// people step) and the pay schedules. Every domain is *.example.
import { companies, departments, paySchedules, workplaces } from "@weft/db";
import type { SeedContext } from "./context";

export const COMPANY = {
  id: "cmp_larkspur", legalName: "Larkspur Robotics, Inc.", domain: "larkspur.example", ein: "00-4817265", hqState: "CA", foundedOn: "2023-03-01",
} as const;

export const WORKPLACES = [
  { id: "wkp_oakland", name: "Oakland HQ", kind: "office", city: "Oakland", state: "CA", country: "US" },
  { id: "wkp_brooklyn", name: "Brooklyn Studio", kind: "office", city: "Brooklyn", state: "NY", country: "US" },
  { id: "wkp_austin", name: "Austin Yard", kind: "office", city: "Austin", state: "TX", country: "US" },
  { id: "wkp_remote", name: "Remote US", kind: "remote", city: null, state: null, country: "US" },
] as const;

export const DEPARTMENTS = [
  { id: "dpt_engineering", name: "Engineering", slug: "engineering" },
  { id: "dpt_hardware", name: "Hardware", slug: "hardware" },
  { id: "dpt_operations", name: "Operations", slug: "operations" },
  { id: "dpt_people", name: "People", slug: "people" },
  { id: "dpt_finance", name: "Finance", slug: "finance" },
  { id: "dpt_gtm", name: "Go-to-market", slug: "gtm" },
] as const;
export type DepartmentId = (typeof DEPARTMENTS)[number]["id"];

export const PAY_SCHEDULES = [
  { id: "ps_us_semimonthly", name: "US semi-monthly", frequency: "semimonthly", region: "us", autopay: false },
  { id: "ps_global_monthly", name: "Global contractors monthly", frequency: "monthly", region: "global", autopay: false },
] as const;

export async function seedCompany(ctx: SeedContext): Promise<void> {
  const db = ctx.db;
  await db.insert(companies).values({ ...COMPANY, createdAt: ctx.clock.now() });
  await db.insert(workplaces).values(WORKPLACES.map((w) => ({ ...w, companyId: ctx.companyId })));
  await db.insert(departments).values(DEPARTMENTS.map((d) => ({ id: d.id, name: d.name, companyId: ctx.companyId, leadWorkerId: null })));
  await db.insert(paySchedules).values(PAY_SCHEDULES.map((p) => ({ ...p, companyId: ctx.companyId })));
}
