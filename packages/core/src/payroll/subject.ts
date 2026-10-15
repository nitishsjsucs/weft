// Subject hash for payroll.submit_run (SPEC 7.4, harness 5.5): sha256 of canonical JSON over the included paycheck ids
// after exclude_blocked, each net_cents, each paycheck's status and its worker's active bank account (id and status,
// plus the masked last4 and the credential_ref the bank batch pays to, so an in-place edit also counts), and the totals. Any change after a proposal, including a
// direct-deposit change, yields STALE_SUBJECT.
import { eq, inArray } from "drizzle-orm";
import { bankAccounts, paychecks, type DbTx } from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import { computeTotals, type TotalsCents } from "./totals";
import type { BenefitJson, DeductionJson } from "./compute";

export type PaycheckRow = typeof paychecks.$inferSelect;
export type BankAccountRow = typeof bankAccounts.$inferSelect;

export interface SubjectMaterial {
  runId: string;
  paychecks: { id: string; worker_id: string; status: string; net_cents: number; reimbursements_cents: number; bank: { id: string; status: string; account_last4: string; routing_last4: string; credential_ref: string } | null }[];
  totals: TotalsCents;
}

export function activeBankOf(rows: BankAccountRow[], workerId: string): BankAccountRow | null {
  return rows.filter((b) => b.workerId === workerId && b.status === "active").sort((a, b) => (a.id < b.id ? 1 : -1))[0] ?? null;
}

/** Paychecks a submission would include: everything but excluded, and with exclude_blocked also not blocked. */
export function includedPaychecks(rows: PaycheckRow[], excludeBlocked: boolean): PaycheckRow[] {
  return rows.filter((p) => p.status !== "excluded" && !(excludeBlocked && p.status === "blocked")).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function rowAmounts(p: PaycheckRow) {
  return {
    status: p.status, grossCents: p.grossCents, netCents: p.netCents, reimbursementsCents: p.reimbursementsCents,
    taxes: JSON.parse(p.taxesJson) as { payer: "employee" | "employer"; amount_cents: number }[],
    deductions: JSON.parse(p.deductionsJson) as DeductionJson[], benefits: JSON.parse(p.benefitsJson) as BenefitJson[],
  };
}

export async function subjectMaterial(tx: DbTx, runId: string, excludeBlocked: boolean): Promise<SubjectMaterial> {
  const rows = await tx.select().from(paychecks).where(eq(paychecks.payrollRunId, runId));
  const included = includedPaychecks(rows, excludeBlocked);
  const ids = included.map((p) => p.workerId);
  const banks = ids.length ? await tx.select().from(bankAccounts).where(inArray(bankAccounts.workerId, ids)) : [];
  return {
    runId,
    paychecks: included.map((p) => {
      const b = activeBankOf(banks, p.workerId);
      return { id: p.id, worker_id: p.workerId, status: p.status, net_cents: p.netCents, reimbursements_cents: p.reimbursementsCents, bank: b ? { id: b.id, status: b.status, account_last4: b.accountLast4, routing_last4: b.routingLast4, credential_ref: b.credentialRef } : null };
    }),
    totals: computeTotals(included.map(rowAmounts)),
  };
}

export const hashSubject = (m: SubjectMaterial) => sha256Hex(canonicalJson({ run_id: m.runId, paychecks: m.paychecks, totals: m.totals }));

export async function runSubjectHash(tx: DbTx, runId: string, excludeBlocked: boolean): Promise<{ hash: string; material: SubjectMaterial }> {
  const material = await subjectMaterial(tx, runId, excludeBlocked);
  return { hash: hashSubject(material), material };
}
