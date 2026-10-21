// Notice escalation to a tax specialist (wave 3 rank 10, research/wave3/agent-parity.md 5.10 T3). Owner:
// w3-parity-routines. Some notices need a person with judgment and power of attorney (a phone call with the agency,
// a penalty dispute, a notice the parser does not recognize). notices.escalate sets the notice to escalated and
// hands a simulated tax specialist an evidence pack: the notice, its tax account, the account's filings and the
// parser's extract. The case lives on notices.resolution_json; the specialist inbox is the email simulator.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { filings, notices, type DbTx } from "@weft/db";
import { parserExtractOf } from "../notices/queries";

export const EscalationReason = z.enum(["agency_call_needed", "penalty_dispute", "unrecognized_notice", "missing_filing", "amount_mismatch"]);
export type EscalationReason = z.infer<typeof EscalationReason>;
export const REASON_LABEL: Record<EscalationReason, string> = {
  agency_call_needed: "the agency needs a call from someone with power of attorney",
  penalty_dispute: "a penalty or interest charge to dispute",
  unrecognized_notice: "a notice kind the parser does not recognize",
  missing_filing: "the agency says a filing is missing and none is on record",
  amount_mismatch: "the agency's amount does not match the ledger",
};
export const SPECIALIST = { principal: "sim_tax_specialist", name: "Tax specialist (simulated)", email: "tax-specialist@weft-sim.example" } as const;

export interface Escalation {
  outcome: "escalated"; reason_code: EscalationReason; reason: string; specialist: string; specialist_principal: string;
  escalated_at: string; escalated_by: string; previous_status: string; evidence: { label: string; ref: string }[];
  /** The knowledge/procedures/ note the escalation follows (wave 4 round 2), checked by the executor before the run. */
  procedure_ref?: string;
}

export async function evidencePack(tx: DbTx, n: typeof notices.$inferSelect): Promise<{ label: string; ref: string }[]> {
  const out = [{ label: "notice", ref: n.id }];
  if (n.taxAccountId) {
    out.push({ label: "tax account", ref: n.taxAccountId });
    for (const f of (await tx.select().from(filings).where(eq(filings.taxAccountId, n.taxAccountId))).sort((a, b) => (a.period < b.period ? -1 : 1))) out.push({ label: `filing ${f.form} ${f.period}`, ref: f.id });
  }
  if (parserExtractOf(n.extractedJson) !== null) out.push({ label: "parser extract", ref: `${n.id}#extract` });
  return out;
}

export function specialistEmail(n: typeof notices.$inferSelect, e: Escalation): { subject: string; body: string } {
  return {
    subject: `Escalated notice ${n.id}: ${n.formCode}`,
    body: [`A Larkspur Robotics notice needs a specialist: ${e.reason}.`, "", `Notice ${n.id} (${n.agency}, form ${n.formCode}), received ${n.receivedAt.slice(0, 10)}${n.respondBy ? `, respond by ${n.respondBy}` : ""}.`, "", "Evidence pack:", ...e.evidence.map((x) => `- ${x.label}: ${x.ref}`), "", ...(e.procedure_ref ? [`Procedure followed: ${e.procedure_ref}`, ""] : []), "(sent by the Weft agent; this specialist is simulated)"].join("\n"),
  };
}
