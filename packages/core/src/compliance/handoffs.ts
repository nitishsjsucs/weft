// Hand-offs to a person (wave 4 rank 2, research/wave3/agent-parity.md G11, T3, T9). Owner: w4-parity-compliance.
// One table for three kinds (tax specialist, HR person, vendor specialist) with a reason code, so notices the agent
// cannot handle, low-confidence extractions and the portal's human-only topics share one Inbox section. A notice
// hand-off reuses the wave 3 evidence pack (notice, tax account, filings, parser extract), sets the notice to
// escalated and emails the simulated specialist, like notices.escalate.
import { and, asc, eq } from "drizzle-orm";
import type { HandoffCase, HandoffKind, HandoffReason, HandoffStatus } from "@weft/contracts";
import { handoffCases, notices, type DbTx } from "@weft/db";
import { evidencePack, SPECIALIST } from "../parity/escalation";

export type HandoffRow = typeof handoffCases.$inferSelect;

export const HANDOFF_ASSIGNEE: Record<HandoffKind, { principal: string; name: string; email: string }> = {
  tax_specialist: { principal: SPECIALIST.principal, name: SPECIALIST.name, email: SPECIALIST.email },
  hr_person: { principal: "usr_dana", name: "People team", email: "people@larkspur.example" },
  vendor_specialist: { principal: "sim_vendor_specialist", name: "Vendor specialist (simulated)", email: "vendor-specialist@weft-sim.example" },
};

export const HANDOFF_REASON_LABEL: Record<HandoffReason, string> = {
  judgment_needed: "it needs a person's judgment",
  power_of_attorney: "it needs someone with power of attorney to act for the company",
  medical_leave: "it is about medical leave",
  accommodation: "it is about a workplace accommodation",
  workplace_concern: "it raises a workplace concern",
  unknown_notice_kind: "the notice is a kind Weft does not handle",
  low_confidence_extract: "the fields read from the uploaded notice are not certain",
  employee_asked: "the employee asked for a person",
  other: "it needs a person",
};

export function toHandoffDto(r: HandoffRow): HandoffCase & { resolutionNote: string | null; assigneeName: string } {
  let evidence: { label: string; ref: string }[] = [];
  try { const v = JSON.parse(r.evidenceJson as string); if (Array.isArray(v)) evidence = v; } catch { /* empty */ }
  return {
    id: r.id as `hnd_${string}`, kind: r.kind as HandoffKind, reason: r.reason as HandoffReason, subjectRef: r.subjectRef, workerId: (r.workerId as `wrk_${string}` | null) ?? null,
    summary: r.summary, evidence, status: r.status as HandoffStatus, assigneePrincipalId: r.assigneePrincipalId, openedBy: r.openedBy,
    runId: (r.runId as `run_${string}` | null) ?? null, createdAt: r.createdAt, resolvedAt: r.resolvedAt, resolutionNote: r.resolutionNote,
    assigneeName: HANDOFF_ASSIGNEE[r.kind as HandoffKind]?.name ?? r.kind,
  };
}

export async function listHandoffs(tx: DbTx, companyId: string, f: { kind?: string; status?: string } = {}): Promise<HandoffRow[]> {
  const rows = await tx.select().from(handoffCases).where(eq(handoffCases.companyId, companyId)).orderBy(asc(handoffCases.id));
  return rows.filter((r) => (!f.kind || r.kind === f.kind) && (!f.status || r.status === f.status));
}

export async function getHandoff(tx: DbTx, companyId: string, id: string): Promise<HandoffRow | null> {
  const [r] = await tx.select().from(handoffCases).where(and(eq(handoffCases.companyId, companyId), eq(handoffCases.id, id))).limit(1);
  return r ?? null;
}

/** An open case for the same subject, so a second routine run does not open a duplicate. */
export async function openCaseFor(tx: DbTx, companyId: string, subjectRef: string): Promise<HandoffRow | null> {
  const rows = await tx.select().from(handoffCases).where(and(eq(handoffCases.companyId, companyId), eq(handoffCases.subjectRef, subjectRef)));
  return rows.find((r) => r.status === "open" || r.status === "acknowledged") ?? null;
}

/** The evidence pack for a subject: a notice gets the wave 3 pack; anything else gets the subject itself. */
export async function evidenceFor(tx: DbTx, companyId: string, subjectRef: string | null): Promise<{ notice: typeof notices.$inferSelect | null; evidence: { label: string; ref: string }[] }> {
  if (subjectRef?.startsWith("ntc_")) {
    const [n] = await tx.select().from(notices).where(and(eq(notices.companyId, companyId), eq(notices.id, subjectRef))).limit(1);
    if (n) {
      const pack = await evidencePack(tx, n);
      if (n.uploadId) pack.push({ label: "uploaded file", ref: n.uploadId });
      return { notice: n, evidence: pack };
    }
  }
  return { notice: null, evidence: subjectRef ? [{ label: "subject", ref: subjectRef }] : [] };
}

export function handoffEmail(c: { id: string; kind: HandoffKind; reason: HandoffReason; summary: string; subjectRef: string | null; evidence: { label: string; ref: string }[] }): { subject: string; body: string } {
  return {
    subject: `Hand-off ${c.id}${c.subjectRef ? ` for ${c.subjectRef}` : ""}`,
    body: [`Larkspur Robotics (demo) is handing this to ${HANDOFF_ASSIGNEE[c.kind].name.toLowerCase()} because ${HANDOFF_REASON_LABEL[c.reason]}.`, "", c.summary, "", "Evidence pack:",
      ...c.evidence.map((x) => `- ${x.label}: ${x.ref}`), "", "(sent by Weft; this recipient is simulated)"].join("\n"),
  };
}
