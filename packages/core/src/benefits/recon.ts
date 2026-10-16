// Carrier reconciliation (wave 2, GP11). Owner: w2-benefits-contractors. Compares a carrier's monthly invoice with the
// enrollments on file and the month's paycheck deductions, and keeps benefit_recon_findings idempotent per month and
// carrier. Coverage policy (simulated): coverage starts on the enrollment's effective date and ends with the last
// semi-monthly period the worker is employed through in full; each covered period bills the tier's per-period price.
// "Dependents on file" means an active enrollment of the worker at a tier that covers dependents (there is no
// dependents table in the schema yet).
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { formatCents, type ReconFinding, type ReconFindingKind, type ReconFindingStatus } from "@weft/contracts";
import { benefitEnrollments, benefitPlans, benefitReconFindings, paychecks, payrollRuns, simCarrierInvoices, workers, type DbTx } from "@weft/db";

export const RECON_CARRIER = "Juniper Mutual (sim)";
export const RECON_BILLED_TYPES: readonly string[] = ["medical", "dental", "vision"];
export const RECON_DEPENDENT_TIERS: readonly string[] = ["ee_spouse", "ee_children", "family"];
const EXCLUDED_RUN_STATUSES = ["failed", "void", "voided", "canceled", "cancelled"];

export type ReconFindingRow = typeof benefitReconFindings.$inferSelect;
export interface ReconLine { workerId: string; planId: string; amountCents: number; tier?: string; periods?: number }
export interface ReconInvoice { id?: string; month: string; carrier: string; lines: ReconLine[]; totalCents: number }

export function reconPeriods(month: string): { start: string; end: string }[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`recon: month must be YYYY-MM, got ${month}`);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [{ start: `${month}-01`, end: `${month}-15` }, { start: `${month}-16`, end: `${month}-${String(last).padStart(2, "0")}` }];
}

export function toFindingDto(r: ReconFindingRow): ReconFinding {
  return {
    id: r.id, month: r.month, carrier: r.carrier, kind: r.kind as ReconFindingKind, workerId: r.workerId, planId: r.planId,
    billedCents: r.billedCents, expectedCents: r.expectedCents, deductedCents: r.deductedCents, status: r.status as ReconFindingStatus, detail: r.detail,
  };
}

export async function listFindings(tx: DbTx, companyId: string, opts: { month?: string; status?: string } = {}): Promise<ReconFindingRow[]> {
  const conds = [eq(benefitReconFindings.companyId, companyId)];
  if (opts.month) conds.push(eq(benefitReconFindings.month, opts.month));
  if (opts.status) conds.push(eq(benefitReconFindings.status, opts.status));
  return tx.select().from(benefitReconFindings).where(and(...conds)).orderBy(asc(benefitReconFindings.id));
}

export async function getFinding(tx: DbTx, companyId: string, id: string): Promise<ReconFindingRow | null> {
  return (await tx.select().from(benefitReconFindings).where(and(eq(benefitReconFindings.companyId, companyId), eq(benefitReconFindings.id, id))))[0] ?? null;
}

export async function hasStoredInvoice(tx: DbTx, month: string, carrier = RECON_CARRIER): Promise<boolean> {
  return (await tx.select({ id: simCarrierInvoices.id }).from(simCarrierInvoices).where(and(eq(simCarrierInvoices.month, month), eq(simCarrierInvoices.carrier, carrier)))).length > 0;
}

/** A computed finding before it is stored. */
export interface DraftFinding { kind: ReconFindingKind; workerId: string | null; planId: string | null; billedCents: number; expectedCents: number; deductedCents: number; detail: string }

const price = (pricesJson: string, tier: string): number => { const v = (JSON.parse(pricesJson) as Record<string, unknown>)[tier]; return typeof v === "number" ? v : 0; };
const tierOfLine = (l: ReconLine, pricesJson: string): string => {
  if (l.tier) return l.tier;
  const per = l.periods && l.periods > 0 ? l.amountCents / l.periods : l.amountCents / 2;
  return RECON_DEPENDENT_TIERS.concat(["ee"]).find((t) => price(pricesJson, t) === per) ?? "unknown";
};

/** Pure comparison: invoice lines against enrollments, worker end dates and deductions. Deterministic order. */
export async function computeFindings(tx: DbTx, companyId: string, invoice: ReconInvoice): Promise<DraftFinding[]> {
  const periods = reconPeriods(invoice.month);
  const plans = (await tx.select().from(benefitPlans).where(and(eq(benefitPlans.companyId, companyId), eq(benefitPlans.carrier, invoice.carrier)))).filter((p) => RECON_BILLED_TYPES.includes(p.type));
  const planById = new Map(plans.map((p) => [p.id, p]));
  const people = await tx.select({ id: workers.id, first: workers.firstName, last: workers.lastName, endDate: workers.endDate }).from(workers).where(eq(workers.companyId, companyId));
  const personById = new Map(people.map((p) => [p.id, p]));
  const ids = people.map((p) => p.id);
  const enr = ids.length ? (await tx.select().from(benefitEnrollments).where(inArray(benefitEnrollments.workerId, ids)).orderBy(asc(benefitEnrollments.id))).filter((e) => planById.has(e.planId)) : [];
  const dependentsOnFile = new Set(enr.filter((e) => e.status === "active" && e.tier && RECON_DEPENDENT_TIERS.includes(e.tier)).map((e) => e.workerId));

  // Deductions from the month's paychecks (processed and draft runs with a payday in the month).
  const runs = (await tx.select({ id: payrollRuns.id, status: payrollRuns.status }).from(payrollRuns).where(and(eq(payrollRuns.companyId, companyId), like(payrollRuns.payday, `${invoice.month}-%`))))
    .filter((r) => !EXCLUDED_RUN_STATUSES.includes(r.status)).map((r) => r.id);
  const deducted = new Map<string, number>();
  if (runs.length) {
    for (const pc of await tx.select({ workerId: paychecks.workerId, benefits: paychecks.benefitsJson }).from(paychecks).where(inArray(paychecks.payrollRunId, runs))) {
      for (const b of JSON.parse(pc.benefits || "[]") as { planId: string; employeeCents: number }[]) {
        if (!planById.has(b.planId)) continue;
        const k = `${pc.workerId}|${b.planId}`;
        deducted.set(k, (deducted.get(k) ?? 0) + (b.employeeCents ?? 0));
      }
    }
  }

  // Expected coverage per worker and plan.
  const expected = new Map<string, { tier: string; periods: number; cents: number }>();
  for (const e of enr) {
    if (e.status !== "active" && e.status !== "terminated") continue;
    const end = personById.get(e.workerId)?.endDate ?? null;
    const n = periods.filter((p) => e.effectiveFrom <= p.end && (e.effectiveTo === null || e.effectiveTo >= p.start) && !(e.status === "terminated" && e.effectiveTo === null) && (end === null || end >= p.end)).length;
    if (n === 0) continue;
    const tier = e.tier ?? "ee";
    const k = `${e.workerId}|${e.planId}`;
    const prev = expected.get(k);
    expected.set(k, { tier, periods: (prev?.periods ?? 0) + n, cents: (prev?.cents ?? 0) + price(planById.get(e.planId)!.pricesJson, tier) * n });
  }

  const nameOf = (id: string) => { const p = personById.get(id); return p ? `${p.first} ${p.last} (demo)` : id; };
  const planName = (id: string) => planById.get(id)?.name ?? id;
  const out: DraftFinding[] = [];
  const terminated = new Map<string, { billed: number; expected: number; deducted: number; plans: string[] }>();
  const seen = new Set<string>();
  const lines = [...invoice.lines].sort((a, b) => (a.workerId === b.workerId ? (a.planId < b.planId ? -1 : 1) : a.workerId < b.workerId ? -1 : 1));
  for (const l of lines) {
    const plan = planById.get(l.planId);
    if (!plan) continue;
    const k = `${l.workerId}|${l.planId}`;
    seen.add(k);
    const exp = expected.get(k);
    const ded = deducted.get(k) ?? 0;
    const person = personById.get(l.workerId);
    const billedTier = tierOfLine(l, plan.pricesJson);
    if (person?.endDate && l.amountCents > (exp?.cents ?? 0)) {
      const t = terminated.get(l.workerId) ?? { billed: 0, expected: 0, deducted: 0, plans: [] };
      t.billed += l.amountCents; t.expected += exp?.cents ?? 0; t.deducted += ded; t.plans.push(plan.name);
      terminated.set(l.workerId, t);
      continue;
    }
    if (!exp) {
      out.push({ kind: "billed_not_enrolled", workerId: l.workerId, planId: l.planId, billedCents: l.amountCents, expectedCents: 0, deductedCents: ded,
        detail: `${nameOf(l.workerId)} is billed ${formatCents(l.amountCents)} for ${plan.name} in ${invoice.month} with no enrollment on file.` });
      continue;
    }
    if (billedTier !== exp.tier) {
      const addsDependents = RECON_DEPENDENT_TIERS.includes(billedTier) && !dependentsOnFile.has(l.workerId);
      out.push({ kind: addsDependents ? "missing_dependent" : "wrong_tier", workerId: l.workerId, planId: l.planId, billedCents: l.amountCents, expectedCents: exp.cents, deductedCents: ded,
        detail: addsDependents
          ? `${nameOf(l.workerId)} is billed the ${billedTier} tier for ${plan.name} (${formatCents(l.amountCents)}) but has no dependent on file; the ${exp.tier} enrollment expects ${formatCents(exp.cents)} and paychecks deducted ${formatCents(ded)}.`
          : `${nameOf(l.workerId)} is billed the ${billedTier} tier for ${plan.name} (${formatCents(l.amountCents)}) but is enrolled at ${exp.tier}; expected ${formatCents(exp.cents)}, paychecks deducted ${formatCents(ded)}.` });
      continue;
    }
    if (l.amountCents !== exp.cents) {
      out.push({ kind: "amount_mismatch", workerId: l.workerId, planId: l.planId, billedCents: l.amountCents, expectedCents: exp.cents, deductedCents: ded,
        detail: `${nameOf(l.workerId)} is billed ${formatCents(l.amountCents)} for ${plan.name}; the ${exp.tier} enrollment expects ${formatCents(exp.cents)}.` });
    }
  }
  for (const [workerId, t] of terminated) {
    const end = personById.get(workerId)?.endDate ?? "";
    out.push({ kind: "terminated_but_billed", workerId, planId: null, billedCents: t.billed, expectedCents: t.expected, deductedCents: t.deducted,
      detail: `${nameOf(workerId)} left on ${end} but is billed ${formatCents(t.billed)} for ${invoice.month} (${t.plans.join(", ")}); coverage through the last full period worked is ${formatCents(t.expected)} and paychecks deducted ${formatCents(t.deducted)}.` });
  }
  for (const [k, exp] of expected) {
    if (seen.has(k)) continue;
    const [workerId, planId] = k.split("|") as [string, string];
    out.push({ kind: "enrolled_not_billed", workerId, planId, billedCents: 0, expectedCents: exp.cents, deductedCents: deducted.get(k) ?? 0,
      detail: `${nameOf(workerId)} is enrolled in ${planName(planId)} at ${exp.tier} (${formatCents(exp.cents)}) but the ${invoice.month} invoice has no line.` });
  }
  const order: ReconFindingKind[] = ["terminated_but_billed", "missing_dependent", "wrong_tier", "billed_not_enrolled", "enrolled_not_billed", "amount_mismatch"];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || String(a.workerId).localeCompare(String(b.workerId)) || String(a.planId).localeCompare(String(b.planId)));
}

const keyOf = (f: { kind: string; workerId: string | null; planId: string | null }) => `${f.kind}|${f.workerId ?? ""}|${f.planId ?? ""}`;

/** Stores findings idempotently: same key keeps its id and status (amounts refreshed); open findings that no longer
 * apply turn resolved. Returns the month's findings and counts. */
export async function storeFindings(tx: DbTx, companyId: string, month: string, carrier: string, drafts: DraftFinding[], now: string, newId: (p: "rcf_") => Promise<string>) {
  const existing = (await tx.select().from(benefitReconFindings).where(and(eq(benefitReconFindings.companyId, companyId), eq(benefitReconFindings.month, month), eq(benefitReconFindings.carrier, carrier))));
  const byKey = new Map(existing.map((r) => [keyOf(r), r]));
  let created = 0, unchanged = 0, resolved = 0;
  const keep = new Set<string>();
  for (const d of drafts) {
    const k = keyOf(d);
    keep.add(k);
    const row = byKey.get(k);
    if (!row) {
      await tx.insert(benefitReconFindings).values({ id: await newId("rcf_"), companyId, month, carrier, kind: d.kind, workerId: d.workerId, planId: d.planId, billedCents: d.billedCents, expectedCents: d.expectedCents, deductedCents: d.deductedCents, status: "open", detail: d.detail, createdAt: now });
      created++;
      continue;
    }
    const reopen = row.status === "resolved";
    if (row.billedCents !== d.billedCents || row.expectedCents !== d.expectedCents || row.deductedCents !== d.deductedCents || row.detail !== d.detail || reopen) {
      await tx.update(benefitReconFindings).set({ billedCents: d.billedCents, expectedCents: d.expectedCents, deductedCents: d.deductedCents, detail: d.detail, ...(reopen ? { status: "open" } : {}) }).where(eq(benefitReconFindings.id, row.id));
    } else unchanged++;
  }
  for (const r of existing) {
    if (!keep.has(keyOf(r)) && r.status === "open") { await tx.update(benefitReconFindings).set({ status: "resolved" }).where(eq(benefitReconFindings.id, r.id)); resolved++; }
  }
  const rows = (await listFindings(tx, companyId, { month })).filter((r) => r.carrier === carrier && keep.has(keyOf(r)));
  return { rows, created, unchanged, resolved };
}

/** The carrier's billing address in the simulator (fictional). */
export const CARRIER_BILLING_EMAIL = "billing@juniper-mutual.example";

/** Template text of a dispute message for one finding (ids, enums, cents and DB names only). */
export function disputeMessage(f: ReconFindingRow, workerName: string | null, planName: string | null): { subject: string; body: string } {
  const what: Record<string, string> = {
    terminated_but_billed: "coverage billed after the employee's last day",
    missing_dependent: "a dependent tier billed for an employee with no dependent on file",
    wrong_tier: "a coverage tier that does not match the enrollment on file",
    billed_not_enrolled: "a charge for an employee with no enrollment on file",
    enrolled_not_billed: "an enrollment missing from the invoice",
    amount_mismatch: "an amount that does not match the enrolled tier",
  };
  const subject = `Invoice ${f.month} dispute: ${f.kind.replace(/_/g, " ")} (${f.id})`;
  const body = [
    `Hello Juniper Mutual billing team,`,
    ``,
    `Larkspur Robotics (demo) disputes one line of the ${f.month} invoice: ${what[f.kind] ?? f.kind}.`,
    `Employee: ${workerName ?? "not applicable"}${f.workerId ? ` (${f.workerId})` : ""}`,
    `Plan: ${planName ?? "all plans on the line"}`,
    `Billed: ${formatCents(f.billedCents)}. Expected from our enrollment records: ${formatCents(f.expectedCents)}. Deducted from paychecks: ${formatCents(f.deductedCents)}.`,
    f.billedCents > f.expectedCents
      ? `Please correct the invoice and send a credit for ${formatCents(f.billedCents - f.expectedCents)}.`
      : `Please reissue the line at the enrolled coverage (${formatCents(f.expectedCents)}) so our records match.`,
    ``,
    `Reference: ${f.id}`,
  ].join("\n");
  return { subject, body };
}
