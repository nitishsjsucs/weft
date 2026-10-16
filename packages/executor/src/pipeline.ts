// The executor pipeline (SPEC 9.3, harness 4.6, 5.4, 5.5, 6). One call, one transaction under withWriteLock:
// command, tier, null mapping and Zod, references, grants, amount and ceilings, batch rules and policy(), lease,
// then a proposal or the run (state change, simulator write, hash-chained action row, stamped events), then
// untrusted wrapping, taint, redaction. The envelope is ToolOutcome; every variant carries tainted.
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { Preview, ToolOutcome } from "@weft/contracts";
import { emitEvent, idMinter, newId, type CommandDeps, type WeftCommand } from "@weft/core";
import { execCalls, leases, proposals, type DbTx } from "@weft/db";
import { appendAction } from "./chain";
import { digestOf } from "./digest";
import type { Engine } from "./engine";
import { codeOfError, hintsOfError, refusal } from "./outcome";
import { policy, RISK_RANK, riskOf } from "./policy";
import { genericPreview, insertProposal, proposeCall, type ProposalRow } from "./proposals";
import { findUnknownReference } from "./references";
import { tierFor } from "./registry";
import type { CallScope } from "./scope";
import { GRANT_RANK, loadLimits } from "./store";
import { nullToUndefined } from "./strict-schema";
import { markTainted } from "./taint";
import { applyUntrusted } from "./untrusted";
import { offloadIfLarge } from "./workspace";

export const LEASE_MS = 10 * 60_000;
export const MAX_ISSUES = 5;

/** Command deps bound to the executor's transaction. Simulators are built on first use (reads never need them). */
export function makeDeps(e: Engine, tx: DbTx): CommandDeps {
  let sims: CommandDeps["sims"] | null = null;
  return {
    tx,
    get sims() { return (sims ??= e.simulators({ db: tx, clock: e.clock })); },
    resolveCredential: (ref) => e.vault.resolve(tx, ref),
    clock: e.clock,
    newId: idMinter(tx),
  };
}

export interface CallOptions {
  /** decide(): the proposal row, already CAS-approved in this transaction. Only the approval step is skipped. */
  approved?: ProposalRow | null;
  reversesSeq?: number | null;
}

const NOUN: Record<string, string> = { ntc_: "notice", wrk_: "worker", offr_: "offer", art_: "artifact", run_: "run", prp_: "proposal" };
function sourceOf(def: WeftCommand, data: unknown, input: unknown): string {
  const pick = (o: unknown) => (o && typeof o === "object" && typeof (o as { id?: unknown }).id === "string" ? (o as { id: string }).id : null);
  // The result's own id, or the id of a single wrapped record ({ notice: { id } }), or the first id-shaped arg.
  const nested = data && typeof data === "object" && !Array.isArray(data) ? Object.values(data).map(pick).filter((x): x is string => x !== null) : [];
  const id = pick(data) ?? (nested.length === 1 ? nested[0]! : null)
    ?? Object.values((input ?? {}) as Record<string, unknown>).find((v): v is string => typeof v === "string" && /^[a-z]{2,5}_/.test(v)) ?? null;
  if (!id) return def.name;
  const p = Object.keys(NOUN).find((k) => id.startsWith(k));
  return p ? `${NOUN[p]}:${id}` : `${def.namespace}:${id}`;
}

async function daySpent(tx: DbTx, e: Engine, companyId: string, key: string, now: string, excludeId: string | null): Promise<number> {
  const names = e.registry.all().filter((d) => d.ceilingKey === key).map((d) => d.name);
  if (names.length === 0) return 0;
  const day = now.slice(0, 10);
  const rows = await tx.select({ id: proposals.id, cents: proposals.moneyCents }).from(proposals)
    .where(and(eq(proposals.companyId, companyId), inArray(proposals.command, names), inArray(proposals.status, ["pending", "approved", "executed"]),
      sql`substr(${proposals.createdAt}, 1, 10) = ${day}`));
  return rows.filter((r) => r.id !== excludeId).reduce((s, r) => s + (r.cents ?? 0), 0);
}

/** Runs one call inside the caller's transaction. Never opens a transaction or takes the write lock itself. */
export async function runInTx(e: Engine, tx: DbTx, scope: CallScope, command: string, rawArgs: unknown, opts: CallOptions = {}): Promise<{ outcome: ToolOutcome; def: WeftCommand | null }> {
  const ctx = scope.ctx;
  const t = () => ctx.tainted;
  const def = e.registry.def(command) ?? null;
  if (!def) return { def, outcome: refusal("UNKNOWN_COMMAND", `No command named ${command}`, t()) };
  const done = (outcome: ToolOutcome) => ({ outcome, def });
  const refuse = (code: Parameters<typeof refusal>[0], message: string, err?: unknown) => {
    const d = hintsOfError(err);
    return done(refusal(code, message, t(), def, d ? { hint: d.hint ? e.redactor.redact(d.hint) : null, example: d.example == null ? null : e.redactor.value(d.example) } : null));
  };

  // Tier and access.
  if (scope.caller === "agent") {
    const tier = tierFor(def, ctx.agentKind ?? "main");
    if (tier === "unavailable") return refuse("UNAVAILABLE", `${def.name} is not available to this agent`);
    if (tier === "delegated") return refuse("DELEGATED_ONLY", `${def.name} is only available to task agents`);
  } else if (scope.caller === "system") {
    if (def.access === "human_only") return refuse("NOT_PERMITTED", `${def.name} is human only`);
  } else if (def.access === "system_only") {
    return refuse("UNAVAILABLE", `${def.name} is recorded by the system only`);
  } else if (scope.caller === "mcp" && def.access === "human_only") {
    return refuse("UNAVAILABLE", `${def.name} is not exposed over MCP`);
  }

  // Null mapping and Zod.
  const parsed = def.input.safeParse(nullToUndefined(rawArgs ?? {}));
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, MAX_ISSUES).map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`);
    return refuse("INVALID_INPUT", `Invalid input for ${def.name}: ${issues.join("; ")}`);
  }
  let input = parsed.data;
  // Model-originated args never legitimately carry a secret: redact them before hashing, storing or running.
  if (scope.caller === "agent" || scope.caller === "mcp") {
    const red = e.redactor.value(input);
    if (JSON.stringify(red) !== JSON.stringify(input)) {
      const again = def.input.safeParse(red);
      if (!again.success) return refuse("INVALID_INPUT", `Input for ${def.name} contained a secret or a full identifier and was redacted`);
      input = again.data;
    }
  }

  // Ids must exist in this company, in grant-visible domains.
  const unknown = await findUnknownReference(tx, ctx.companyId, input, scope.grants);
  if (unknown) {
    const out = refusal("UNKNOWN_REFERENCE", `${unknown.id} does not exist in this company`, t(), def);
    if (out.ok === false && unknown.closest.length) out.refusal.hint = `Closest ids: ${unknown.closest.join(", ")}`;
    return done(out);
  }

  // Grants (the approver's grant was intersected into scope.grants by decide()).
  if (scope.caller !== "system" && GRANT_RANK[scope.grants[def.domain]] < GRANT_RANK[def.needs]) {
    return refuse("NOT_PERMITTED", `${def.name} needs ${def.needs} on ${def.domain}; the effective grant is ${scope.grants[def.domain]}`);
  }

  const readDeps = makeDeps(e, tx);
  let amount: number | null = null;
  try { amount = def.amountCents ? await def.amountCents(input, ctx, readDeps) : null; } catch (err) {
    return refuse(codeOfError(err) ?? "INTERNAL", e.redactor.redact(err instanceof Error ? err.message : String(err)), err);
  }
  const gated = scope.caller === "agent" || scope.caller === "mcp" || scope.caller === "approved";
  let ceiling = null as null | { key: string; perCall: number | null; day: number | null; daySpent: number };
  if (gated && def.ceilingKey) {
    const lim = await loadLimits(tx, ctx.companyId);
    ceiling = { key: def.ceilingKey, perCall: lim.get(def.ceilingKey) ?? null, day: lim.get(`${def.ceilingKey}_day`) ?? lim.get(def.ceilingKey.replace(/_cents$/, "_day_cents")) ?? null,
      daySpent: await daySpent(tx, e, ctx.companyId, def.ceilingKey, ctx.now, opts.approved?.id ?? null) };
  }

  // The preview gives the subject (supersede, R4 count, STALE_SUBJECT).
  let preview: Preview | null = null;
  const wantsPreview = def.effect !== "read" && (scope.caller === "agent" || scope.caller === "mcp" || scope.caller === "approved");
  if (wantsPreview) {
    try { preview = def.preview ? await def.preview(input, ctx, readDeps) : genericPreview(def, input, amount); } catch (err) {
      return refuse(codeOfError(err) ?? "INTERNAL", e.redactor.redact(err instanceof Error ? err.message : String(err)), err);
    }
    if (preview.moneyCents === null && amount !== null) preview = { ...preview, moneyCents: amount };
  }
  let openR4 = 0;
  if (scope.run && RISK_RANK[riskOf(def, input)] === 4) {
    const rows = await tx.select({ id: proposals.id, command: proposals.command, subjectRef: proposals.subjectRef }).from(proposals)
      .where(and(eq(proposals.proposerRunId, scope.run.id), eq(proposals.status, "pending"), eq(proposals.risk, "R4")));
    openR4 = rows.filter((r) => !(r.command === def.name && r.subjectRef === preview?.subjectRef)).length;
  }

  const decision = policy(def, input, {
    caller: scope.caller, agentKind: ctx.agentKind, tainted: scope.caller === "approved" ? false : ctx.tainted, taintedBy: scope.taintedBy,
    blockedInBatch: scope.batch?.blocked ?? false, pendingInBatch: scope.batch?.pending ?? false, amountCents: amount, ceiling, openR4,
    systemAllowed: scope.systemAllowed,
  });
  if (decision.decision === "refuse") return refuse(decision.code ?? "NOT_PERMITTED", decision.reason);

  if (opts.approved && preview && opts.approved.subjectHash && preview.subjectHash !== opts.approved.subjectHash) {
    return refuse("STALE_SUBJECT", `The subject of ${opts.approved.id} changed after it was proposed`);
  }

  // Lease: one holder per resource; the proposer run of an approved proposal counts as the holder.
  const holder = scope.run?.id ?? opts.approved?.proposerRunId ?? `principal:${scope.actor.id}`;
  let leaseKey: string | null = null;
  if (def.lease && decision.decision === "execute") {
    leaseKey = def.lease(input);
    const [l] = await tx.select().from(leases).where(and(eq(leases.resource, leaseKey), ne(leases.holderRunId, holder), gt(leases.expiresAt, ctx.now))).limit(1);
    if (l) return refuse("LEASE_HELD", `${leaseKey} is held by another run until ${l.expiresAt}`);
  }

  if (decision.decision === "propose") {
    return done(await proposeCall(e, tx, scope, def, input, preview ?? genericPreview(def, input, amount), decision));
  }

  if (opts.approved && digestOf(input) !== opts.approved.argsHash) {
    return refuse("STALE_SUBJECT", `The stored args of ${opts.approved.id} no longer parse to the approved args`);
  }

  // Prechecks and checklist predicates: a plain read with no transaction, no writes, no lock.
  if (scope.caller === "readonly") {
    try {
      const out = await def.run(input, ctx, readDeps);
      return done({ ok: true, status: "done", resultId: "res_readonly", data: e.redactor.value(out.data), summary: e.redactor.redact(out.summary),
        actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" });
    } catch (err) {
      return refuse(codeOfError(err) ?? "INTERNAL", e.redactor.redact(err instanceof Error ? err.message : String(err)), err);
    }
  }

  // Execute inside a savepoint so a failing command leaves nothing behind but its refusal.
  try {
    const result = await tx.transaction(async (sp) => {
      const deps = makeDeps(e, sp);
      const out = await def.run(input, ctx, deps);
      if (opts.approved && (out.moneyCents ?? null) !== (opts.approved.moneyCents ?? null)) {
        throw Object.assign(new Error(`money check failed for ${opts.approved.id}: moved ${out.moneyCents ?? "none"}, approved ${opts.approved.moneyCents ?? "none"}`), { code: "INTERNAL" });
      }
      const resultId = await newId(sp, "res_");
      let actionSeq: number | null = null;
      if (def.effect !== "read") {
        const reversible = def.reversible !== false && out.reverseArgs !== undefined;
        const a = await appendAction(sp, {
          ts: ctx.now, actorKind: scope.actor.kind, actorId: scope.actor.id, onBehalfOf: ctx.onBehalfOf, agentRunId: scope.run?.id ?? opts.approved?.proposerRunId ?? null,
          routineRunId: ctx.routineRunId ?? opts.approved?.routineRunId ?? null, proposalId: opts.approved?.id ?? null, command: def.name,
          argsJson: JSON.stringify(e.redactor.value(input ?? {})), argsHash: digestOf(input), resultId, resultDigest: digestOf(out.data),
          summary: e.redactor.redact(out.summary), reversible: reversible ? "yes" : "no", reverseJson: reversible ? JSON.stringify(out.reverseArgs) : null,
          reversesSeq: opts.reversesSeq ?? null,
        });
        actionSeq = a.seq;
        if (opts.approved) {
          const res = await sp.run(sql`UPDATE proposals SET status = 'executed', executed_action_seq = ${a.seq} WHERE id = ${opts.approved.id} AND status = 'approved' AND executed_action_seq IS NULL`);
          if (res.rowsAffected !== 1) throw Object.assign(new Error(`proposal ${opts.approved.id} was executed already`), { code: "NOT_PERMITTED" });
        }
      }
      for (const ev of out.events ?? []) {
        const evt = await emitEvent(sp, e.clock, { body: { type: ev.type, payload: e.redactor.value(ev.payload) } as never, subjectRef: ev.subjectRef, attended: scope.stamp.attended, requestedBy: scope.stamp.requestedBy });
        await notify(e, sp, scope, evt.type, evt.payload);
      }
      if (leaseKey) {
        await sp.insert(leases).values({ resource: leaseKey, holderRunId: holder, acquiredAt: ctx.now, expiresAt: new Date(Date.parse(ctx.now) + LEASE_MS).toISOString() })
          .onConflictDoUpdate({ target: leases.resource, set: { holderRunId: holder, acquiredAt: ctx.now, expiresAt: new Date(Date.parse(ctx.now) + LEASE_MS).toISOString() } });
      }
      // Untrusted fields: wrap with the run nonce and taint the run.
      let data: unknown = out.data;
      const hinted = (out as { taintedBy?: string | null }).taintedBy ?? null;
      const paths = [...def.untrustedFields, ...((out as { untrusted?: string[] }).untrusted ?? [])];
      if (paths.length > 0 || hinted) {
        const src = hinted ?? sourceOf(def, out.data, input);
        const w = scope.nonce ? applyUntrusted(out.data, paths, scope.nonce, src) : { data: out.data, found: false };
        data = w.data;
        if ((w.found || hinted) && scope.run && scope.caller === "agent") {
          await markTainted(sp, scope.run.id, src, ctx.run?.stepN ?? 0);
          if (!ctx.tainted) { ctx.tainted = true; scope.taintedBy = src; }
        }
      }
      data = e.redactor.value(data);
      const summary = e.redactor.redact(out.summary);
      const off = scope.run ? await offloadIfLarge(e, sp, scope, def, data, summary) : null;
      const outcome: ToolOutcome = {
        ok: true, status: "done", resultId, data: off ? off.data : data, summary, actionSeq, artifactRef: off?.ref ?? null, tainted: ctx.tainted, label: "synthetic",
      };
      return outcome;
    });
    return done(result);
  } catch (err) {
    const code = codeOfError(err) ?? "INTERNAL";
    const msg = e.redactor.redact(err instanceof Error ? err.message : String(err));
    if (code === "INTERNAL") e.log(e.redactor.redact(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    return refuse(code, code === "INTERNAL" ? `Internal error in ${def.name}: ${msg}` : msg, err);
  }
}

/**
 * The proposal notifier (SPEC 9.2): routine.drafted becomes a routine_enable proposal in the same transaction.
 * The card headline and provenance come from the routines row only.
 */
export async function notify(e: Engine, tx: DbTx, scope: CallScope, type: string, payload: Record<string, string>): Promise<void> {
  if (type !== "routine.drafted") return;
  const routineId = payload.routine_id!;
  const [r] = await tx.all<{ id: string; name: string; company_id: string; tainted_by: string | null; owner_principal_id: string }>(
    sql`SELECT id, name, company_id, tainted_by, owner_principal_id FROM routines WHERE id = ${routineId}`);
  if (!r) return;
  const input = { routine_id: r.id };
  await insertProposal(e, tx, {
    kind: "routine_enable", def: null, command: "routines.enable", input, risk: "R1", reason: "a drafted routine needs a human to enable it",
    preview: { title: `Enable routine ${r.name} (${r.id})`, diff: [{ label: "enabled", before: "false", after: "true" }], content: [], moneyCents: null,
      subjectRef: r.id, subjectHash: digestOf(input), evidence: [{ label: "routine", ref: r.id }] },
    domain: "company", reversible: true, agentNote: null, taintedBy: r.tainted_by ?? (scope.ctx.tainted ? scope.taintedBy : null),
    proposerRunId: scope.run?.id ?? null, routineRunId: scope.ctx.routineRunId, onBehalfOf: r.owner_principal_id, companyId: r.company_id, stamp: scope.stamp,
  });
}

/** Stores the outcome for dedupe on (run_id, call_id). */
export async function recordCall(tx: DbTx, runId: string, callId: string, command: string, outcome: ToolOutcome, now: string): Promise<void> {
  await tx.insert(execCalls).values({ runId, callId, command, outcomeJson: JSON.stringify(outcome), createdAt: now }).onConflictDoNothing();
}

export async function priorCall(tx: DbTx, runId: string, callId: string): Promise<ToolOutcome | null> {
  const [row] = await tx.select().from(execCalls).where(and(eq(execCalls.runId, runId), eq(execCalls.callId, callId))).limit(1);
  return row ? (JSON.parse(row.outcomeJson) as ToolOutcome) : null;
}
