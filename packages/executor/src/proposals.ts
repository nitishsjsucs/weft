// Proposals, not effects (harness 5.5). A gated call stores the parsed args, the canonical preview and the
// provenance; the card headline comes from structured fields only, free text goes to "Content to be sent".
import { and, eq, lte, sql } from "drizzle-orm";
import type { PolicyDecision, Preview, Proposal, ProposalKind, ProposalStatus, RiskClass, ToolOutcome } from "@weft/contracts";
import { emitEvent, newId, type WeftCommand } from "@weft/core";
import { payrollRuns, proposals, type DbTx } from "@weft/db";
import { digestOf } from "./digest";
import type { Engine } from "./engine";
import { appendAudit } from "./chain";
import type { CallScope } from "./scope";
import { idShapedValues } from "./references";

export type ProposalRow = typeof proposals.$inferSelect;
export const PROPOSAL_TTL_MS = 72 * 3600_000;
export const PAYROLL_DEADLINE_MARGIN_MS = 3600_000;
export const AGENT_NOTE_MAX = 600;

/** Plain text only: no HTML, markdown links become "text (url)", images are dropped, whitespace collapsed. */
export function plainText(s: string, max = AGENT_NOTE_MAX): string {
  const t = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max) : t;
}

function headlineOf(title: string): string { return plainText(title, 200).replace(/\s+/g, " "); }

export function agentNoteOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  for (const k of ["agent_note", "reason", "note"]) if (typeof o[k] === "string" && (o[k] as string).trim()) return plainText(o[k] as string);
  return null;
}

/** Used when a command has no preview of its own: subject is the first id in the args, content is every free-text arg. */
export function genericPreview(def: WeftCommand, input: unknown, amount: number | null): Preview {
  const ids = [...idShapedValues(input)];
  const content: Preview["content"] = [];
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) if (typeof v === "string" && !ids.includes(v) && v.length > 0) content.push({ label: k, text: v });
  }
  return { title: `${def.summary}${ids[0] ? ` (${ids[0]})` : ""}`, diff: [], content, moneyCents: amount, subjectRef: ids[0] ?? def.name, subjectHash: digestOf(input), evidence: [] };
}

async function expiryFor(tx: DbTx, def: WeftCommand, input: unknown, subjectRef: string, now: string): Promise<string> {
  let ms = Date.parse(now) + PROPOSAL_TTL_MS;
  if (def.domain === "payroll") {
    const ids = [subjectRef, ...idShapedValues(input)].filter((x) => x.startsWith("pay_"));
    if (ids[0]) {
      const [run] = await tx.select({ d: payrollRuns.approvalDeadline }).from(payrollRuns).where(eq(payrollRuns.id, ids[0])).limit(1);
      if (run) ms = Math.min(ms, Date.parse(run.d) - PAYROLL_DEADLINE_MARGIN_MS);
    }
  }
  return new Date(ms).toISOString();
}

export interface NewProposal {
  kind: ProposalKind; def: WeftCommand | null; command: string | null; input: unknown; preview: Preview; risk: RiskClass | null;
  reason: string; domain: string; reversible: boolean; agentNote: string | null; taintedBy: string | null;
  proposerRunId: string | null; routineRunId: string | null; onBehalfOf: string | null; companyId: string;
  stamp: { attended: boolean; requestedBy: string | null };
}

export async function insertProposal(e: Engine, tx: DbTx, p: NewProposal): Promise<ProposalRow> {
  const now = e.clock.now();
  let supersedes: string | null = null;
  if (p.command) {
    const prior = await tx.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.companyId, p.companyId), eq(proposals.command, p.command),
      eq(proposals.subjectRef, p.preview.subjectRef), eq(proposals.status, "pending")));
    for (const old of prior) {
      await tx.update(proposals).set({ status: "superseded", decidedAt: now, decisionCode: "SUPERSEDED" }).where(and(eq(proposals.id, old.id), eq(proposals.status, "pending")));
      supersedes = old.id;
    }
  }
  const id = await newId(tx, "prp_");
  const expiresAt = p.def ? await expiryFor(tx, p.def, p.input, p.preview.subjectRef, now) : new Date(Date.parse(now) + PROPOSAL_TTL_MS).toISOString();
  const row: ProposalRow = {
    id, companyId: p.companyId, kind: p.kind, command: p.command, argsJson: p.input === undefined ? null : JSON.stringify(p.input),
    argsHash: p.input === undefined ? null : digestOf(p.input), subjectRef: p.preview.subjectRef, subjectHash: p.preview.subjectHash, risk: p.risk,
    headline: headlineOf(p.preview.title), diffJson: JSON.stringify(p.preview.diff), contentJson: JSON.stringify(p.preview.content),
    evidenceJson: JSON.stringify(p.preview.evidence), agentNote: p.agentNote, taintedBy: p.taintedBy, proposerRunId: p.proposerRunId,
    routineRunId: p.routineRunId, onBehalfOf: p.onBehalfOf, domain: p.domain, moneyCents: p.preview.moneyCents, reversible: p.reversible,
    supersedes, createdAt: now, expiresAt, status: "pending", decidedBy: null, decidedAt: null, decisionCode: null, decisionNote: null, executedActionSeq: null,
  };
  await tx.insert(proposals).values(row);
  await emitEvent(tx, e.clock, { body: { type: "proposal.created", payload: { proposal_id: id } }, subjectRef: id, attended: p.stamp.attended, requestedBy: p.stamp.requestedBy });
  await postCard(e, tx, row);
  return row;
}

/**
 * The proposal notifier's approval card (harness 6.9): the only writer of chat cards. Headline from structured
 * fields; the card opens the proposal page, where decide() re-renders it from the DB. Best-effort: a missing chat
 * simulator never blocks a proposal.
 */
async function postCard(e: Engine, tx: DbTx, row: ProposalRow): Promise<void> {
  if (row.kind === "suggestion") return;
  try {
    const chat = (e.simulators({ db: tx, clock: e.clock }) as Partial<ReturnType<Engine["simulators"]>> | undefined)?.chat;
    if (!chat || typeof chat.post !== "function") return;
    await chat.post({ channel: row.domain === "payroll" || row.domain === "tax" ? "#payroll" : "#people-ops", author: "Weft agent",
      text: `Approval needed: ${row.headline}`, card: { proposalId: row.id, headline: row.headline, risk: row.risk ?? "R1", moneyCents: row.moneyCents } });
  } catch { /* the chat simulator is optional here */ }
}

export async function proposeCall(e: Engine, tx: DbTx, scope: CallScope, def: WeftCommand, input: unknown, preview: Preview, decision: PolicyDecision): Promise<ToolOutcome> {
  const taintedBy = scope.ctx.tainted ? (scope.taintedBy ?? "external") : null;
  const row = await insertProposal(e, tx, {
    kind: def.name === "vault.request" ? "secret_request" : "action", def, command: def.name, input, preview, risk: decision.risk, reason: decision.reason, domain: def.domain,
    reversible: def.reversible !== false, agentNote: agentNoteOf(input), taintedBy,
    proposerRunId: scope.run?.id ?? null, routineRunId: scope.ctx.routineRunId, onBehalfOf: scope.ctx.onBehalfOf ?? (scope.actor.kind === "human" ? scope.actor.id : null),
    companyId: scope.ctx.companyId, stamp: scope.stamp,
  });
  return { ok: true, status: "pending_approval", proposalId: row.id, title: row.headline, expiresAt: row.expiresAt, tainted: scope.ctx.tainted };
}

const parse = <T>(s: string | null, d: T): T => { if (s === null) return d; try { return JSON.parse(s) as T; } catch { return d; } };

export function toProposal(r: ProposalRow): Proposal {
  return {
    id: r.id, companyId: r.companyId, kind: r.kind as ProposalKind, command: r.command, args: parse(r.argsJson, null), argsHash: r.argsHash,
    subjectRef: r.subjectRef, subjectHash: r.subjectHash, risk: r.risk as RiskClass | null, moneyCents: r.moneyCents, reversible: r.reversible,
    headline: r.headline, diff: parse(r.diffJson, []), content: parse(r.contentJson, []), evidence: parse(r.evidenceJson, []),
    agentNote: r.agentNote, taintedBy: r.taintedBy, proposerRunId: r.proposerRunId, routineRunId: r.routineRunId, onBehalfOf: r.onBehalfOf,
    supersedes: r.supersedes, createdAt: r.createdAt, expiresAt: r.expiresAt, status: r.status as ProposalStatus, decidedBy: r.decidedBy,
    decidedAt: r.decidedAt, decisionCode: r.decisionCode, decisionNote: r.decisionNote, executedActionSeq: r.executedActionSeq,
  };
}

/** Marks pending proposals past expires_at as expired (scheduler step 2). */
export async function expireProposals(e: Engine, tx: DbTx, now: string): Promise<number> {
  const due = await tx.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.status, "pending"), lte(proposals.expiresAt, now)));
  for (const p of due) {
    const res = await tx.run(sql`UPDATE proposals SET status = 'expired', decided_at = ${now}, decision_code = 'EXPIRED' WHERE id = ${p.id} AND status = 'pending'`);
    if (res.rowsAffected === 1) {
      await appendAudit(tx, { proposalId: p.id, principalId: "svc_scheduler", attempt: "expire", outcome: "ok", ts: now });
      await emitEvent(tx, e.clock, { body: { type: "proposal.decided", payload: { proposal_id: p.id, status: "expired" } }, subjectRef: p.id, attended: false, requestedBy: null });
    }
  }
  return due.length;
}
