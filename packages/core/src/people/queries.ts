// People reads shared by the people.* commands and the /v1/workers and /v1/offers routes.
import { and, asc, desc, eq, inArray, isNull, lte, or, gte, type SQL } from "drizzle-orm";
import { money, type Offer, type PayRate, type Worker } from "@weft/contracts";
import { bankAccounts, departments, offers, payRates, taxProfiles, workers, workplaces, type DbTx } from "@weft/db";
import { displayName, nameRef } from "./names";

export type WorkerRow = typeof workers.$inferSelect;

export function toWorkerDto(w: WorkerRow): Worker {
  return {
    id: w.id, employeeNumber: w.employeeNumber, type: w.type as Worker["type"], workerType: w.workerType as Worker["workerType"], status: w.status as Worker["status"],
    firstName: w.firstName, lastName: w.lastName, displayName: displayName(w.firstName, w.lastName), workEmail: w.workEmail, title: w.title,
    departmentId: w.departmentId, managerId: w.managerId, workplaceId: w.workplaceId, workState: w.workState, country: w.country,
    currency: w.currency as Worker["currency"], timezone: w.timezone, startDate: w.startDate, endDate: w.endDate,
    ssnMasked: w.ssnLast4 ? `***-**-${w.ssnLast4}` : null, payScheduleId: w.payScheduleId,
  };
}

export function toPayRateDto(r: typeof payRates.$inferSelect): PayRate {
  return { id: r.id, workerId: r.workerId, kind: r.kind as PayRate["kind"], amount: money(r.amountCents, r.currency as "USD"), effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, createdActionSeq: r.createdActionSeq };
}

export function toOfferDto(o: typeof offers.$inferSelect): Offer {
  return {
    id: o.id, candidateFirst: o.candidateFirst, candidateLast: o.candidateLast, candidateEmail: o.candidateEmail, title: o.title,
    departmentId: o.departmentId, workplaceId: o.workplaceId, workState: o.workState, managerId: o.managerId, base: money(o.baseCents),
    payKind: o.payKind as Offer["payKind"], startDate: o.startDate, status: o.status as Offer["status"], acceptedAt: o.acceptedAt, workerId: o.workerId,
  };
}

export interface WorkerFilter { status?: string; state?: string; type?: string; departmentId?: string; ids?: string[] }

export function workerWhere(companyId: string, f: WorkerFilter): SQL {
  const conds: SQL[] = [eq(workers.companyId, companyId)];
  if (f.status) conds.push(eq(workers.status, f.status));
  if (f.state) conds.push(eq(workers.workState, f.state));
  if (f.type) conds.push(eq(workers.type, f.type));
  if (f.departmentId) conds.push(eq(workers.departmentId, f.departmentId));
  if (f.ids) conds.push(inArray(workers.id, f.ids.length ? f.ids : ["__none__"]));
  return and(...conds)!;
}

export async function getWorker(tx: DbTx, companyId: string, id: string): Promise<WorkerRow | null> {
  const [w] = await tx.select().from(workers).where(and(eq(workers.companyId, companyId), eq(workers.id, id))).limit(1);
  return w ?? null;
}

/** The pay rate in effect on `date` (YYYY-MM-DD), latest effective_from first. */
export async function currentPayRate(tx: DbTx, workerId: string, date: string): Promise<typeof payRates.$inferSelect | null> {
  const [r] = await tx.select().from(payRates)
    .where(and(eq(payRates.workerId, workerId), lte(payRates.effectiveFrom, date), or(isNull(payRates.effectiveTo), gte(payRates.effectiveTo, date))))
    .orderBy(desc(payRates.effectiveFrom), desc(payRates.id)).limit(1);
  return r ?? null;
}

export async function payRateHistory(tx: DbTx, workerId: string) {
  return tx.select().from(payRates).where(eq(payRates.workerId, workerId)).orderBy(asc(payRates.effectiveFrom), asc(payRates.id));
}

export async function lookups(tx: DbTx, companyId: string) {
  const depts = await tx.select().from(departments).where(eq(departments.companyId, companyId));
  const places = await tx.select().from(workplaces).where(eq(workplaces.companyId, companyId));
  const people = await tx.select({ id: workers.id, first: workers.firstName, last: workers.lastName }).from(workers).where(eq(workers.companyId, companyId));
  const dept = new Map(depts.map((d) => [d.id, d.name]));
  const place = new Map(places.map((p) => [p.id, p.name]));
  const person = new Map(people.map((p) => [p.id, nameRef(p.first, p.last, p.id)]));
  return { dept: (id: string | null) => (id ? dept.get(id) ?? id : null), place: (id: string | null) => (id ? place.get(id) ?? id : null), person: (id: string | null) => (id ? person.get(id) ?? id : null) };
}

export async function bankSummary(tx: DbTx, workerId: string) {
  const rows = await tx.select().from(bankAccounts).where(eq(bankAccounts.workerId, workerId)).orderBy(asc(bankAccounts.id));
  const active = rows.find((b) => b.status === "active") ?? null;
  return { rows, active };
}

export async function taxProfile(tx: DbTx, workerId: string) {
  const [p] = await tx.select().from(taxProfiles).where(eq(taxProfiles.workerId, workerId)).limit(1);
  return p ?? null;
}

/** Parses home_address_json leniently; it is employee-entered and untrusted, so it is returned as text only. */
export function homeAddressText(json: string | null): string | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    return Object.values(v).filter((x) => typeof x === "string" && x.length > 0).join(", ") || null;
  } catch { return null; }
}
