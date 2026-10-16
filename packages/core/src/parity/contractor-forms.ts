// Contractor tax forms (wave 3 rank 15, research/wave3/agent-parity.md 5.14 T10). Owner: w3-parity-routines.
// A US contractor needs a W-9 (no expiry). A contractor abroad needs a W-8BEN (a person) or a W-8BEN-E (an entity),
// which stays in effect until the last day of the third calendar year after the year it was signed. The weekly
// routine asks for a new form when one is missing, expired, or expires within 60 days.
//
// contractor_tax_forms.status: "active" (the form on file), "renewal_requested" (on file, a new one was asked for),
// "superseded" (replaced). Only rows that are not superseded count; the newest signed_on wins.
import { and, eq, inArray } from "drizzle-orm";
import type { ContractorTaxForm } from "@weft/contracts";
import { contractorTaxForms, workers, type DbTx } from "@weft/db";
import { displayName } from "../people/names";

export type TaxFormState = "valid" | "expiring" | "expired" | "missing" | "requested";
export interface ContractorFormRow {
  worker_id: string; name: string; country: string;
  needed: "w9" | "w8";
  form: ContractorTaxForm | null; form_id: string | null; signed_on: string | null; expires_on: string | null;
  days_left: number | null; state: TaxFormState;
}
export interface TaxFormsResult { as_of: string; within_days: number; contractors: ContractorFormRow[]; needs_request: string[] }

export const FORM_LABEL: Record<ContractorTaxForm, string> = { w9: "W-9", w8ben: "W-8BEN", w8bene: "W-8BEN-E" };

/** A W-8 form signed in year Y stays in effect through December 31 of year Y + 3; a W-9 does not expire. */
export function taxFormExpiresOn(form: ContractorTaxForm, signedOn: string): string | null {
  return form === "w9" ? null : `${Number(signedOn.slice(0, 4)) + 3}-12-31`;
}

const dayNum = (d: string) => Math.round(Date.parse(`${d}T12:00:00.000Z`) / 86_400_000);

export async function listTaxForms(tx: DbTx, companyId: string, asOf: string, opts: { withinDays?: number; workerIds?: string[] } = {}): Promise<TaxFormsResult> {
  const withinDays = opts.withinDays ?? 60;
  const people = (await tx.select().from(workers).where(and(eq(workers.companyId, companyId), eq(workers.type, "contractor"))))
    .filter((w) => w.status === "active" && (!opts.workerIds || opts.workerIds.includes(w.id)))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const forms = people.length ? await tx.select().from(contractorTaxForms).where(inArray(contractorTaxForms.workerId, people.map((p) => p.id))) : [];
  const out: ContractorFormRow[] = people.map((w) => {
    const needed = w.country === "US" ? "w9" : "w8";
    const mine = forms.filter((f) => f.workerId === w.id && f.status !== "superseded" && (needed === "w9" ? f.form === "w9" : f.form !== "w9"))
      .sort((a, b) => (a.signedOn === b.signedOn ? (a.id < b.id ? 1 : -1) : a.signedOn < b.signedOn ? 1 : -1));
    const f = mine[0];
    const base = { worker_id: w.id, name: displayName(w.firstName, w.lastName), country: w.country, needed } as const;
    if (!f) return { ...base, form: null, form_id: null, signed_on: null, expires_on: null, days_left: null, state: "missing" };
    const expiresOn = f.expiresOn ?? taxFormExpiresOn(f.form as ContractorTaxForm, f.signedOn);
    const daysLeft = expiresOn ? dayNum(expiresOn) - dayNum(asOf) : null;
    const state: TaxFormState = daysLeft !== null && daysLeft < 0 ? "expired"
      : f.status === "renewal_requested" ? "requested"
      : daysLeft !== null && daysLeft <= withinDays ? "expiring" : "valid";
    return { ...base, form: f.form as ContractorTaxForm, form_id: f.id, signed_on: f.signedOn, expires_on: expiresOn, days_left: daysLeft, state };
  });
  return { as_of: asOf, within_days: withinDays, contractors: out, needs_request: out.filter((r) => r.state === "missing" || r.state === "expiring" || r.state === "expired").map((r) => r.worker_id) };
}

/** What to ask for: a W-9 at home; abroad, the same W-8 kind as before, or either kind when none is on file. */
export function requestedForm(r: ContractorFormRow): string {
  if (r.needed === "w9") return "W-9";
  return r.form ? FORM_LABEL[r.form] : "W-8BEN (individual) or W-8BEN-E (entity)";
}

export function requestEmail(r: ContractorFormRow): { subject: string; body: string } {
  const form = requestedForm(r);
  const why = r.state === "missing" ? `We do not have a ${form} on file for you yet.`
    : r.state === "expired" ? `The ${FORM_LABEL[r.form!]} on file lapsed on ${r.expires_on}.`
    : `The ${FORM_LABEL[r.form!]} on file stays in effect through ${r.expires_on}.`;
  return {
    subject: r.state === "missing" ? `Please send your ${form}` : `Please renew your ${form}`,
    body: `Hi ${r.name},\n\n${why} Please sign a new ${form} in the contractor portal so your tax status stays current and payouts are not held.\n\nThank you,\nLarkspur Robotics people team (sent by the Weft agent)`,
  };
}
