// Proposals, not effects (harness 5.5). A gated call stores the parsed args, the canonical preview and the
// provenance; the card headline comes from structured fields only, free text goes to "Content to be sent".
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { ApprovalCardW3, PolicyDecision, Preview, Proposal, ProposalKind, ProposalStatus, RiskClass, ToolOutcome } from "@weft/contracts";
import { emitEvent, newId, payroll, type WeftCommand } from "@weft/core";
import { payrollRuns, principals, proposals, routineRuns, routines, type Db, type DbTx } from "@weft/db";
import { digestOf } from "./digest";
import type { Engine } from "./engine";
import { appendAudit } from "./chain";
import type { CallScope } from "./scope";
import { idShapedValues } from "./references";
import { DUPLICATE_PROPOSAL_CODE, type ExistingProposalOutcome } from "../../contracts/src/ext/fx-duplicate-proposal";

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

/** How long a decided proposal still stops an equivalent one from being filed (sim clock, from decided_at). */
export const EQUIVALENT_DECIDED_WINDOW_MS = 24 * 3600_000;
/** Decisions a repeat must not reopen: the change happened (or is happening), or a person turned it down. */
const DECIDED_EQUIVALENT = new Set(["approved", "executed", "denied", "dismissed"]);

/**
 * The equivalent-proposal check (fix group duplicate-proposal). A gated call matches an existing proposal of the same
 * company, kind, command and subject_ref with the same canonical arguments (args_hash over the parsed input):
 * - still pending, unexpired and on the same subject state (subject_hash): the caller gets that proposal back;
 * - approved, executed, denied or dismissed within EQUIVALENT_DECIDED_WINDOW_MS: the caller is told it was decided.
 * A pending match on a changed subject is not a duplicate: the new call supersedes it as before (harness 5.4). A
 * denial or dismissal on a changed subject is not one either. An untainted call never takes over a tainted proposal,
 * so a clean run can still replace a proposal an injected run filed. Expired, failed and superseded rows never match.
 */
export async function findEquivalentProposal(tx: DbTx, p: { companyId: string; kind: ProposalKind; command: string; input: unknown; preview: Preview; tainted: boolean; now: string }): Promise<ProposalRow | null> {
  const argsHash = digestOf(p.input);
  const since = new Date(Date.parse(p.now) - EQUIVALENT_DECIDED_WINDOW_MS).toISOString();
  const rows = await tx.select().from(proposals).where(and(eq(proposals.companyId, p.companyId), eq(proposals.kind, p.kind), eq(proposals.command, p.command),
    eq(proposals.subjectRef, p.preview.subjectRef), eq(proposals.argsHash, argsHash))).orderBy(desc(proposals.createdAt), desc(proposals.id));
  for (const r of rows) {
    if (r.taintedBy && !p.tainted) continue;
    if (r.status === "pending") {
      if (r.expiresAt > p.now && r.subjectHash === p.preview.subjectHash) return r;
      continue;
    }
    if (!DECIDED_EQUIVALENT.has(r.status) || !r.decidedAt || r.decidedAt < since) continue;
    if ((r.status === "denied" || r.status === "dismissed") && r.subjectHash !== p.preview.subjectHash) continue;
    return r;
  }
  return null;
}

/** What the caller reads when its call matched `row`: the open proposal itself, or a refusal naming the decision. */
export function equivalentOutcome(row: ProposalRow, tainted: boolean): ToolOutcome {
  if (row.status === "pending") {
    const out: ExistingProposalOutcome = {
      ok: true, status: "pending_approval", proposalId: row.id, title: row.headline, expiresAt: row.expiresAt, tainted, existing: true,
      note: `${row.id} already proposes this (same command, subject and arguments) and is waiting for approval; no new proposal was filed. Do not propose it again.`,
    };
    return out;
  }
  const what = row.status === "executed" || row.status === "approved" ? "approved and carried out" : row.status === "denied" ? "denied by a person" : "dismissed by a person";
  const hint = row.status === "executed" || row.status === "approved"
    ? `It is already done: report ${row.id} instead of proposing it again.`
    : `A person turned it down: say so instead of proposing it again, or propose different arguments if something has changed.`;
  return {
    ok: false, tainted,
    refusal: {
      code: DUPLICATE_PROPOSAL_CODE, message: `An equivalent ${row.command ?? "proposal"} (${row.id}, same subject and arguments) was ${what} at ${row.decidedAt}; nothing new was filed.`,
      hint, example: { proposal_id: row.id, status: row.status, decided_at: row.decidedAt, executed_action_seq: row.executedActionSeq },
    },
  };
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

export const CARD_MAX_FIELDS = 12;
const EMPTY_BEFORE = new Set(["", "$0.00", "none", "None", "-"]);
const CARD_STATUS: Record<string, ApprovalCardW3["status"]> = {
  pending: "pending", approved: "approved", executed: "approved", failed: "approved", denied: "denied", dismissed: "denied", expired: "expired", superseded: "superseded",
};

/**
 * The approval card (wave 3, ApprovalCardW3): every value comes from the proposal row the executor stored (its
 * preview: headline, diff, money, subject and evidence) or from DB names, never from model text. Free-text content and
 * the agent's note stay on the proposal page, where decide() re-renders the full preview.
 */
export async function approvalCardOf(db: Db | DbTx, row: ProposalRow): Promise<ApprovalCardW3> {
  const diff = parse<Preview["diff"]>(row.diffJson, []);
  const evidence = parse<Preview["evidence"]>(row.evidenceJson, []);
  const lines = diff.map((d) => ({ label: plainText(d.label, 120), value: plainText(EMPTY_BEFORE.has(d.before.trim()) || d.before === d.after ? d.after : `${d.before} to ${d.after}`, 120) }));
  const fields = lines.length > CARD_MAX_FIELDS ? [...lines.slice(0, CARD_MAX_FIELDS - 1), { label: "More", value: `${lines.length - (CARD_MAX_FIELDS - 1)} more lines on the proposal page` }] : lines;
  const workerIds = [...new Set([...((row.subjectRef ?? "").match(/wrk_[A-Za-z0-9]+/g) ?? []), ...evidence.map((x) => x.ref).filter((r) => r.startsWith("wrk_"))])];
  const names = await payroll.workerNames(db as DbTx, workerIds);
  const demo = (n: string) => (n.endsWith(" (demo)") ? n : `${n} (demo)`);   // seeded people are fictional and say so
  const one = workerIds.length === 1 ? names.get(workerIds[0]!)?.name : undefined;
  const subjectName = one ? demo(one) : workerIds.length > 1 ? `${workerIds.length} workers` : null;
  let routineName: string | null = null;
  if (row.routineRunId) {
    const [r] = await db.select({ name: routines.name }).from(routineRuns).innerJoin(routines, eq(routines.id, routineRuns.routineId)).where(eq(routineRuns.id, row.routineRunId)).limit(1);
    routineName = r?.name ?? null;
  }
  const approverId = row.decidedBy ?? row.onBehalfOf;
  const [approver] = approverId ? await db.select({ display: principals.display }).from(principals).where(inArray(principals.id, [approverId])).limit(1) : [];
  return {
    proposalId: row.id, headline: row.headline, risk: row.risk ?? "R1", moneyCents: row.moneyCents, routineName, subjectName,
    approverName: approver?.display ?? null, fields, status: CARD_STATUS[row.status] ?? "pending",
  };
}

/**
 * The proposal notifier's approval card (harness 6.9): the only writer of chat cards. Headline from structured
 * fields; the card opens the proposal page, where decide() re-renders it from the DB. Best-effort: a missing chat
 * simulator never blocks a proposal. Wave 3: the card JSON is the full ApprovalCardW3 built from the stored preview.
 */
async function postCard(e: Engine, tx: DbTx, row: ProposalRow): Promise<void> {
  if (row.kind === "suggestion") return;
  try {
    const chat = (e.simulators({ db: tx, clock: e.clock }) as Partial<ReturnType<Engine["simulators"]>> | undefined)?.chat;
    if (!chat || typeof chat.post !== "function") return;
    const card = await approvalCardOf(tx, row).catch(() => ({ proposalId: row.id, headline: row.headline, risk: row.risk ?? "R1", moneyCents: row.moneyCents }));
    await chat.post({ channel: row.domain === "payroll" || row.domain === "tax" ? "#payroll" : "#people-ops", author: "Weft agent",
      text: `Approval needed: ${row.headline}`, card });
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

/** Marks pending proposals past expires_at as expired (scheduler step 2). Returns the rows this call expired. */
export async function expireProposals(e: Engine, tx: DbTx, now: string): Promise<{ id: string; proposerRunId: string | null }[]> {
  const due = await tx.select({ id: proposals.id, proposerRunId: proposals.proposerRunId }).from(proposals).where(and(eq(proposals.status, "pending"), lte(proposals.expiresAt, now)));
  const expired: { id: string; proposerRunId: string | null }[] = [];
  for (const p of due) {
    const res = await tx.run(sql`UPDATE proposals SET status = 'expired', decided_at = ${now}, decision_code = 'EXPIRED' WHERE id = ${p.id} AND status = 'pending'`);
    if (res.rowsAffected === 1) {
      await appendAudit(tx, { proposalId: p.id, principalId: "svc_scheduler", attempt: "expire", outcome: "ok", ts: now });
      await emitEvent(tx, e.clock, { body: { type: "proposal.decided", payload: { proposal_id: p.id, status: "expired" } }, subjectRef: p.id, attended: false, requestedBy: null });
      expired.push(p);
    }
  }
  return expired;
}

/** Tells the decided callbacks (agent wake, routine finalize) about each proposal that expired, after the commit. */
export async function fireExpired(e: Engine, rows: { id: string; proposerRunId: string | null }[]): Promise<void> {
  for (const r of rows) {
    for (const cb of e.decided) {
      try {
        await cb({ proposalId: r.id, runId: r.proposerRunId, status: "expired", actionSeq: null, deciderRole: "system", reasonCode: "EXPIRED" });
      } catch (err) {
        e.log(e.redactor.redact(`onProposalDecided failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }
}
