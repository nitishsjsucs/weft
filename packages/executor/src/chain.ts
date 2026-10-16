// Action log integrity (harness 6.5). Every state change appends one hash-chained actions row in the same SQLite
// transaction. Preimage: canonical JSON of { seq, prev_hash, ts, actor, command, args_hash, proposal_id, result_digest }.
import { asc, desc, inArray, isNotNull, sql } from "drizzle-orm";
import type { ChainStatus } from "@weft/contracts";
import { canonicalJson, newId, sha256Hex } from "@weft/core";
import { actions, approvalAudit, documents, proposals, signatures, type DbTx } from "@weft/db";

export const GENESIS_HASH = "0".repeat(64);

export interface ActionInput {
  ts: string;
  actorKind: "human" | "agent" | "routine" | "system";
  actorId: string;
  onBehalfOf: string | null;
  agentRunId: string | null;
  routineRunId: string | null;
  proposalId: string | null;
  command: string;
  argsJson: string;          // redacted
  argsHash: string;          // over the unredacted args
  resultId: string | null;
  resultDigest: string | null;
  summary: string;           // structured fields only
  reversible: "yes" | "no" | "na";
  reverseJson: string | null;
  reversesSeq: number | null;
}

export function actorOf(a: { actorKind: string; actorId: string }): string { return `${a.actorKind}:${a.actorId}`; }

export function actionHash(r: { seq: number; prevHash: string; ts: string; actorKind: string; actorId: string; command: string; argsHash: string; proposalId: string | null; resultDigest: string | null }): string {
  return sha256Hex(canonicalJson({
    seq: r.seq, prev_hash: r.prevHash, ts: r.ts, actor: actorOf(r), command: r.command, args_hash: r.argsHash,
    proposal_id: r.proposalId, result_digest: r.resultDigest,
  }));
}

export async function chainHead(tx: DbTx): Promise<{ seq: number; hash: string } | null> {
  const [row] = await tx.select({ seq: actions.seq, hash: actions.hash }).from(actions).orderBy(desc(actions.seq)).limit(1);
  return row ?? null;
}

export async function appendAction(tx: DbTx, a: ActionInput): Promise<{ seq: number; hash: string; actionId: string }> {
  const head = await chainHead(tx);
  const seq = (head?.seq ?? 0) + 1;
  const prevHash = head?.hash ?? GENESIS_HASH;
  const actionId = await newId(tx, "act_");
  const hash = actionHash({ ...a, seq, prevHash });
  await tx.insert(actions).values({ ...a, seq, actionId, prevHash, hash });
  return { seq, hash, actionId };
}

export async function appendAudit(tx: DbTx, a: { proposalId: string; principalId: string; attempt: string; outcome: string; ts: string }): Promise<void> {
  const [head] = await tx.select({ seq: approvalAudit.seq, hash: approvalAudit.hash }).from(approvalAudit).orderBy(desc(approvalAudit.seq)).limit(1);
  const seq = (head?.seq ?? 0) + 1;
  const prevHash = head?.hash ?? GENESIS_HASH;
  const hash = sha256Hex(canonicalJson({ seq, prev_hash: prevHash, ts: a.ts, proposal_id: a.proposalId, principal: a.principalId, attempt: a.attempt, outcome: a.outcome }));
  await tx.insert(approvalAudit).values({ ...a, seq, prevHash, hash });
}

/**
 * The signature pass: every signature's document still hashes to the sha256 it was signed at, the document row and
 * the signature agree, and the action row at the signature's seq carries that sha256 (so the hash chain covers it).
 */
export async function verifySignatures(tx: DbTx): Promise<string[]> {
  const problems: string[] = [];
  const sigs = await tx.select().from(signatures);
  if (!sigs.length) return problems;
  const docs = new Map((await tx.select({ id: documents.id, bodyText: documents.bodyText, sha256: documents.sha256 }).from(documents).where(inArray(documents.id, sigs.map((s) => s.documentId)))).map((d) => [d.id, d]));
  const seqs = sigs.map((s) => s.actionSeq).filter((n): n is number => n !== null);
  const acts = new Map((seqs.length ? await tx.select({ seq: actions.seq, summary: actions.summary, argsJson: actions.argsJson }).from(actions).where(inArray(actions.seq, seqs)) : []).map((a) => [a.seq, a]));
  for (const s of sigs) {
    const d = docs.get(s.documentId);
    if (!d) { problems.push(`${s.id}: document ${s.documentId} missing`); continue; }
    if (sha256Hex(d.bodyText) !== d.sha256 || d.sha256 !== s.documentSha256) { problems.push(`${s.id}: ${d.id} text does not match its signed sha256`); continue; }
    const a = s.actionSeq === null ? undefined : acts.get(s.actionSeq);
    if (!a || !`${a.summary} ${typeof a.argsJson === "string" ? a.argsJson : JSON.stringify(a.argsJson)}`.includes(s.documentSha256)) problems.push(`${s.id}: action ${s.actionSeq ?? "none"} does not carry the signed sha256`);
  }
  return problems;
}

/** Recomputes the chain, checks seq has no gaps, checks every executed proposal has exactly one action row. */
export async function verifyActions(tx: DbTx, gitHeadSeq: number | null): Promise<ChainStatus & { proposalProblems: string[]; signatureProblems: string[] }> {
  const rows = await tx.select().from(actions).orderBy(asc(actions.seq));
  const gaps: number[] = [];
  let badSeq: number | null = null;
  let prev = GENESIS_HASH;
  let expect = 1;
  for (const r of rows) {
    while (expect < r.seq) gaps.push(expect++);
    expect = r.seq + 1;
    const h = actionHash(r);
    if (badSeq === null && (r.prevHash !== prev || r.hash !== h)) badSeq = r.seq;
    prev = r.hash;
  }
  const proposalProblems: string[] = [];
  const byProposal = new Map<string, number[]>();
  for (const r of rows) if (r.proposalId) byProposal.set(r.proposalId, [...(byProposal.get(r.proposalId) ?? []), r.seq]);
  const executed = await tx.select({ id: proposals.id, seq: proposals.executedActionSeq }).from(proposals).where(isNotNull(proposals.executedActionSeq));
  for (const p of executed) {
    const seqs = byProposal.get(p.id) ?? [];
    if (seqs.length !== 1 || seqs[0] !== p.seq) proposalProblems.push(`${p.id}: ${seqs.length} action rows`);
  }
  for (const [pid, seqs] of byProposal) if (seqs.length > 1 && !executed.some((p) => p.id === pid)) proposalProblems.push(`${pid}: ${seqs.length} action rows`);
  const last = rows.at(-1);
  const head = last ? { seq: last.seq, hash: last.hash } : null;
  const gitLag = head && gitHeadSeq !== null ? Math.max(0, head.seq - gitHeadSeq) : 0;
  const signatureProblems = await verifySignatures(tx);
  return { ok: gaps.length === 0 && badSeq === null && proposalProblems.length === 0 && signatureProblems.length === 0 && gitLag <= 1, head, gaps, badSeq, gitLag, proposalProblems, signatureProblems };
}

/** Count of rows, for tests. */
export async function actionCount(tx: DbTx): Promise<number> {
  const [r] = await tx.all<{ n: number }>(sql`SELECT count(*) AS n FROM actions`);
  return r?.n ?? 0;
}
