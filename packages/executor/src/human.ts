// HumanExecutor (harness 5.5, 6.1): exec, decide and rollback. Imported only by apps/api routes.
// decide(approve) is a CAS on status='pending', then the full pipeline re-run on the stored args inside the same
// transaction (only the approval step is skipped), a unique executed_action_seq and the money check.
import { and, eq, sql } from "drizzle-orm";
import type { DecisionInput, DecisionResult, DecisionRefusal, HumanExecutor, HumanSession, ProposalDecided, ProposalStatus, ToolOutcome } from "@weft/contracts";
import { emitEvent } from "@weft/core";
import { actions, execRuns, proposals, type DbTx } from "@weft/db";
import { appendAudit } from "./chain";
import type { Engine } from "./engine";
import { refusal, Rollback } from "./outcome";
import { runInTx } from "./pipeline";
import { riskOf } from "./policy";
import { toProposal, type ProposalRow } from "./proposals";
import { humanScope, runGrants, type CallScope } from "./scope";
import { GRANT_RANK, intersect, loadPrincipal, readSetting, type PrincipalRow } from "./store";
import { readTaint } from "./taint";
import { afterCommit } from "./timeline";
import { writeLocked } from "./write";

class NotPending extends Error {}

async function approvedScope(e: Engine, tx: DbTx, row: ProposalRow, approver: PrincipalRow): Promise<CallScope | null> {
  const now = e.clock.now();
  if (row.proposerRunId) {
    const [run] = await tx.select().from(execRuns).where(eq(execRuns.id, row.proposerRunId)).limit(1);
    if (!run) return null;
    const taint = await readTaint(tx, run.id);
    return {
      caller: "approved",
      ctx: {
        companyId: run.companyId, principal: { id: run.principalId, kind: "agent", role: null }, onBehalfOf: run.onBehalfOf, surface: run.surface as CallScope["ctx"]["surface"],
        agentKind: run.agentKind as CallScope["ctx"]["agentKind"], run: { id: run.id, stepN: 0, parentStepN: null, attended: run.attended }, tainted: taint.tainted,
        routineRunId: run.routineRunId, approvedProposalId: row.id, now,
      },
      grants: intersect(await runGrants(tx, run), approver.grants),
      taintedBy: taint.taintedBy, nonce: null, actor: { kind: run.routineRunId ? "routine" : "agent", id: run.principalId },
      stamp: { attended: true, requestedBy: approver.id }, run, batch: null, callId: null, systemAllowed: false,
    };
  }
  const proposer = row.onBehalfOf ? await loadPrincipal(tx, row.onBehalfOf) : null;
  if (!proposer) return null;
  return {
    caller: "approved",
    ctx: {
      companyId: row.companyId, principal: { id: proposer.id, kind: proposer.kind, role: proposer.role }, onBehalfOf: null, surface: "mcp", agentKind: null,
      run: null, tainted: true, routineRunId: null, approvedProposalId: row.id, now,
    },
    grants: intersect(proposer.grants, approver.grants), taintedBy: row.taintedBy, nonce: null, actor: { kind: "human", id: proposer.id },
    stamp: { attended: true, requestedBy: approver.id }, run: null, batch: null, callId: null, systemAllowed: false,
  };
}

const no = (code: DecisionRefusal, message: string): DecisionResult => ({ ok: false, code, message });

/** The human's decision note goes to knowledge/decisions/DEC-<proposal>.md as an untrusted field (best-effort). */
async function decisionNote(e: Engine, row: ProposalRow, who: PrincipalRow, decision: string, note: string | null): Promise<void> {
  if (!note) return;
  const id = row.id.replace(/^prp_/, "");
  try {
    await e.memory.write({
      path: `knowledge/decisions/DEC-${id}.md`, message: `decision: ${decision} ${row.id}`,
      author: { name: who.display, email: `${who.id}@larkspur.example` },
      frontmatter: { id: `DEC-${id}`, type: "decision", aliases: [], links: [row.id], sources: [`proposal:${row.id}`], status: decision, updated: e.clock.now().slice(0, 10), taintedBy: `decision_note:${row.id}` },
      body: `# ${decision} ${row.id}\n\nCommand: ${row.command ?? row.kind}\n\n## Note (entered by a person, untrusted)\n\n${note}\n`,
    });
  } catch (err) {
    e.log(`decision note for ${row.id} not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createHumanExecutor(e: Engine): HumanExecutor {
  const apiKeyGated = (command: string, args: unknown): boolean => {
    const def = e.registry.def(command);
    if (!def || def.approval !== "always" || def.effect !== "external" || def.mcp === "hidden") return false;
    try { return riskOf(def, args) === "R4"; } catch { return false; }
  };
  const fire = async (p: ProposalDecided) => {
    for (const cb of e.decided) {
      try { await cb(p); } catch (err) { e.log(e.redactor.redact(`onProposalDecided failed: ${err instanceof Error ? err.message : String(err)}`)); }
    }
  };

  async function finishRefused(row: ProposalRow, by: string, code: string, outcomeStatus: ProposalStatus): Promise<ProposalRow> {
    return writeLocked(() => e.db.transaction(async (tx) => {
      const now = e.clock.now();
      await tx.run(sql`UPDATE proposals SET status = ${outcomeStatus}, decided_by = ${by}, decided_at = ${now}, decision_code = ${code} WHERE id = ${row.id} AND status = 'pending'`);
      await appendAudit(tx, { proposalId: row.id, principalId: by, attempt: "approve", outcome: `refused:${code}`, ts: now });
      await emitEvent(tx, e.clock, { body: { type: "proposal.decided", payload: { proposal_id: row.id, status: outcomeStatus } }, subjectRef: row.id, attended: true, requestedBy: by });
      const [r] = await tx.select().from(proposals).where(eq(proposals.id, row.id)).limit(1);
      return r!;
    }));
  }

  return {
    async exec(session: HumanSession, command: string, args: unknown): Promise<ToolOutcome> {
      const outcome = await writeLocked(() => e.db.transaction(async (tx) => {
        const scope = await humanScope(e, tx, session);
        if (!scope) return refusal("NOT_PERMITTED", "The session principal is not a human of this company", false);
        // A cli or admin API key moving money (R4, external, approval always) gets a proposal, never a direct run:
        // a script holding a key is not a person looking at each earning line. UI sessions execute (SPEC 10).
        if (session.via === "api_key" && apiKeyGated(command, args)) return (await runInTx(e, tx, { ...scope, caller: "mcp" }, command, args)).outcome;
        return (await runInTx(e, tx, scope, command, args)).outcome;
      }));
      await afterCommit(e, outcome);
      return outcome;
    },

    /**
     * A person's own gated call (wave 2, w2-offboarding): the proposal path of an MCP call, with the session's own
     * surface and no taint, so a step the person starts (for example an offboarding final pay) waits for approval.
     */
    async propose(session: HumanSession, command: string, args: unknown): Promise<ToolOutcome> {
      const outcome = await writeLocked(() => e.db.transaction(async (tx) => {
        const scope = await humanScope(e, tx, session);
        if (!scope) return refusal("NOT_PERMITTED", "The session principal is not a human of this company", false);
        return (await runInTx(e, tx, { ...scope, caller: "mcp" }, command, args)).outcome;
      }));
      await afterCommit(e, outcome);
      return outcome;
    },

    async decide(input: DecisionInput): Promise<DecisionResult> {
      const s = input.session;
      if (s.via !== "ui") return no("UI_SESSION_REQUIRED", "Decisions accept only the UI session");
      const who = await loadPrincipal(e.db, s.principalId);
      if (!who) return no("WRONG_ROLE", "Unknown principal");
      if (who.kind !== "human") return no("AGENT_PRINCIPAL", "Only a human can decide a proposal");
      if (who.companyId !== s.companyId) return no("WRONG_ROLE", "The principal belongs to another company");
      const [row] = await e.db.select().from(proposals).where(and(eq(proposals.id, input.proposalId), eq(proposals.companyId, s.companyId))).limit(1);
      if (!row) return no("NOT_PENDING", `No proposal ${input.proposalId}`);
      if (row.status !== "pending") return no("NOT_PENDING", `${row.id} is ${row.status}`);
      const now = e.clock.now();
      if (row.expiresAt <= now) {
        await writeLocked(() => e.db.transaction(async (tx) => {
          const res = await tx.run(sql`UPDATE proposals SET status = 'expired', decided_at = ${now}, decision_code = 'EXPIRED' WHERE id = ${row.id} AND status = 'pending'`);
          if (res.rowsAffected === 1) {
            await appendAudit(tx, { proposalId: row.id, principalId: who.id, attempt: input.decision, outcome: "refused:EXPIRED", ts: now });
            await emitEvent(tx, e.clock, { body: { type: "proposal.decided", payload: { proposal_id: row.id, status: "expired" } }, subjectRef: row.id, attended: false, requestedBy: null });
            return true;
          }
          return false;
        })).then(async (changed) => { if (changed) await fire({ proposalId: row.id, runId: row.proposerRunId, status: "expired", actionSeq: null, deciderRole: "system", reasonCode: "EXPIRED" }); });
        return no("EXPIRED", `${row.id} expired at ${row.expiresAt}`);
      }
      const suggestion = row.kind === "suggestion";
      if (suggestion !== (input.decision === "dismiss" || input.decision === "start")) {
        return no("WRONG_ROLE", suggestion ? "Suggestions are dismissed or started" : "Proposals are approved or denied");
      }
      const needs = suggestion ? GRANT_RANK.view : GRANT_RANK.approve;
      const domain = (row.domain ?? "company") as keyof PrincipalRow["grants"];
      if (GRANT_RANK[who.grants[domain] ?? "none"] < needs) return no("WRONG_ROLE", `${who.display} cannot ${input.decision} ${domain} proposals`);
      if (input.decision === "approve" && row.onBehalfOf === who.id && (await readSetting(e.db, "require_second_approver", false)) === true) {
        return no("SELF_APPROVAL", "A second approver is required for proposals made on your behalf");
      }
      // A person may paste a credential into a note; it is redacted before it is stored, audited or written to memory.
      const note = input.note ? e.redactor.redact(input.note.slice(0, 2000)) : null;

      // Deny, dismiss and start: CAS, audit, event.
      if (input.decision !== "approve") {
        const status: ProposalStatus = input.decision === "deny" ? "denied" : input.decision === "dismiss" ? "dismissed" : "approved";
        const done = await writeLocked(() => e.db.transaction(async (tx) => {
          const res = await tx.run(sql`UPDATE proposals SET status = ${status}, decided_by = ${who.id}, decided_at = ${now}, decision_code = ${input.reasonCode ?? (input.decision === "start" ? "STARTED" : null)}, decision_note = ${note} WHERE id = ${row.id} AND status = 'pending'`);
          if (res.rowsAffected !== 1) return null;
          await appendAudit(tx, { proposalId: row.id, principalId: who.id, attempt: input.decision, outcome: "ok", ts: now });
          await emitEvent(tx, e.clock, { body: { type: "proposal.decided", payload: { proposal_id: row.id, status } }, subjectRef: row.id, attended: true, requestedBy: who.id });
          const [r] = await tx.select().from(proposals).where(eq(proposals.id, row.id)).limit(1);
          return r!;
        }));
        if (!done) return no("NOT_PENDING", `${row.id} was decided already`);
        await decisionNote(e, done, who, input.decision, note);
        await fire({ proposalId: row.id, runId: row.proposerRunId, status, actionSeq: null, deciderRole: who.role ?? "human", reasonCode: input.reasonCode });
        return { ok: true, proposal: toProposal(done), outcome: null };
      }

      // Approve.
      let outcome: ToolOutcome | null = null;
      let final: ProposalRow;
      try {
        final = await writeLocked(() => e.db.transaction(async (tx) => {
          const res = await tx.run(sql`UPDATE proposals SET status = 'approved', decided_by = ${who.id}, decided_at = ${now}, decision_code = ${input.reasonCode}, decision_note = ${note} WHERE id = ${row.id} AND status = 'pending'`);
          if (res.rowsAffected !== 1) throw new NotPending();
          const [p] = await tx.select().from(proposals).where(eq(proposals.id, row.id)).limit(1);
          if (!p || p.status !== "approved" || p.executedActionSeq !== null || p.command !== row.command || p.argsHash !== row.argsHash) throw new NotPending();
          if (p.kind === "action" || p.kind === "routine_enable") {
            const scope = p.kind === "action" ? await approvedScope(e, tx, p, who) : await humanScope(e, tx, s);
            if (!scope) throw new Rollback(refusal("NOT_PERMITTED", "The proposer of this proposal no longer exists", false));
            scope.ctx.approvedProposalId = p.id;
            const r = await runInTx(e, tx, scope, p.command!, p.argsJson ? JSON.parse(p.argsJson) : {}, { approved: p });
            if (!(r.outcome.ok === true && r.outcome.status === "done")) throw new Rollback(r.outcome);
            outcome = r.outcome;
            if (r.outcome.actionSeq === null) {
              await tx.run(sql`UPDATE proposals SET status = 'executed' WHERE id = ${p.id} AND status = 'approved'`);
            }
          }
          await appendAudit(tx, { proposalId: p.id, principalId: who.id, attempt: "approve", outcome: "ok", ts: now });
          const [after] = await tx.select().from(proposals).where(eq(proposals.id, p.id)).limit(1);
          await emitEvent(tx, e.clock, { body: { type: "proposal.decided", payload: { proposal_id: p.id, status: after!.status } }, subjectRef: p.id, attended: true, requestedBy: who.id });
          return after!;
        }));
      } catch (err) {
        if (err instanceof NotPending) return no("NOT_PENDING", `${row.id} was decided already`);
        if (err instanceof Rollback) {
          const o = err.outcome;
          const code = o.ok === false ? o.refusal.code : "INTERNAL";
          const failed = await finishRefused(row, who.id, code, "failed");
          await fire({ proposalId: row.id, runId: row.proposerRunId, status: "failed", actionSeq: null, deciderRole: who.role ?? "human", reasonCode: code });
          if (code === "STALE_SUBJECT") return no("STALE_SUBJECT", o.ok === false ? o.refusal.message : "The subject changed");
          return { ok: true, proposal: toProposal(failed), outcome: o };
        }
        throw err;
      }
      await afterCommit(e, outcome);
      await decisionNote(e, final, who, "approve", note);
      await fire({ proposalId: final.id, runId: final.proposerRunId, status: final.status as ProposalStatus, actionSeq: final.executedActionSeq, deciderRole: who.role ?? "human", reasonCode: input.reasonCode });
      return { ok: true, proposal: toProposal(final), outcome };
    },

    async rollback(session, input) {
      if (session.via !== "ui") return refusal("NOT_PERMITTED", "UI_SESSION_REQUIRED: rollback accepts only the UI session", false);
      const outcome = await writeLocked(() => e.db.transaction(async (tx) => {
        const scope = await humanScope(e, tx, session);
        if (!scope) return refusal("NOT_PERMITTED", "The session principal is not a human of this company", false);
        const [a] = await tx.select().from(actions).where(eq(actions.seq, input.seq)).limit(1);
        if (!a) return refusal("UNKNOWN_REFERENCE", `No action #${input.seq}`, false);
        const def = e.registry.def(a.command);
        if (a.reversible !== "yes" || !def || def.reversible === false || a.reverseJson === null) {
          return refusal("DOMAIN_IRREVERSIBLE", notReversibleReason(a.command), false);
        }
        const [already] = await tx.select({ seq: actions.seq }).from(actions).where(eq(actions.reversesSeq, a.seq)).limit(1);
        if (already) return refusal("NOT_PERMITTED", `Action #${a.seq} was already reversed by #${already.seq}`, false);
        const r = await runInTx(e, tx, scope, def.reversible.reverse, JSON.parse(a.reverseJson), { reversesSeq: a.seq });
        return r.outcome;
      }));
      await afterCommit(e, outcome);
      return outcome;
    },

    onProposalDecided(cb) { e.decided.push(cb); },
  };
}

export function notReversibleReason(command: string): string {
  if (command.startsWith("payroll.submit")) return "A funded payroll cannot be undone; run an off-cycle correction instead.";
  if (command.startsWith("notices.send") || command.startsWith("tax.register")) return "filed with the agency";
  if (command.startsWith("comms.")) return "A sent message cannot be unsent.";
  return `${command} is not reversible.`;
}
