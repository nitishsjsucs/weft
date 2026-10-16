// The host side of weft.call (harness 3.4). Each inner call is an ordinary executor call on the code.run's own run:
// same transaction (the outer call already holds the write lock, so re-entering exec() would deadlock), the run's
// frozen allowlist, the tier check against its agent kind, its grants, null mapping and Zod, references, policy,
// untrusted wrapping, taint and redaction, all through runInTx with surface "sandbox". Only commands whose
// `sandbox` field is "read" may be called; anything else, drafts and proposals included, is refused as data with
// SANDBOX_NOT_ALLOWED before it reaches the pipeline. The box never names a principal: the scope is rebuilt from
// the exec_runs row on every call, with taint read fresh, so a tainted read taints the rest of the script's calls.
import { eq } from "drizzle-orm";
import type { ExecContext, ToolOutcome } from "@weft/contracts";
import { execRuns, type DbTx } from "@weft/db";
import type { Engine } from "../engine";
import { refusal } from "../outcome";
import { runInTx } from "../pipeline";
import { runGrants, type CallScope } from "../scope";
import { readTaint } from "../taint";
import { randomNonce } from "../untrusted";

/** What the script sees for one call: plain JSON, ToolOutcome-shaped, carrying the taint flag the engine ORs. */
export type GuestOutcome =
  | { ok: true; status: string; result_id: string | null; data: unknown; summary: string; artifact_ref: string | null; tainted: boolean }
  | { ok: false; refusal: { code: string; message: string; hint: string | null }; tainted: boolean };

export function toGuest(o: ToolOutcome): GuestOutcome {
  if (!o.ok) return { ok: false, refusal: { code: o.refusal.code, message: o.refusal.message, hint: o.refusal.hint ?? null }, tainted: o.tainted };
  if (o.status === "done") return { ok: true, status: o.status, result_id: o.resultId, data: o.data, summary: o.summary, artifact_ref: o.artifactRef, tainted: o.tainted };
  return { ok: true, status: o.status, result_id: null, data: null, summary: "", artifact_ref: null, tainted: o.tainted };
}

async function sandboxScope(tx: DbTx, outer: ExecContext, callId: string): Promise<CallScope | null> {
  if (!outer.run) return null;
  const [row] = await tx.select().from(execRuns).where(eq(execRuns.id, outer.run.id)).limit(1);
  if (!row) return null;
  const taint = await readTaint(tx, row.id);
  return {
    caller: "agent",
    ctx: {
      ...outer,
      surface: "sandbox",
      run: { ...outer.run, parentStepN: outer.run.stepN },
      tainted: taint.tainted,
      approvedProposalId: null,
    },
    grants: await runGrants(tx, row),
    taintedBy: taint.taintedBy,
    // A fresh nonce for inner wrapping; the code.run result itself is wrapped again with the run nonce when tainted.
    nonce: randomNonce(),
    actor: { kind: row.routineRunId ? "routine" : "agent", id: row.principalId },
    stamp: { attended: row.attended, requestedBy: row.onBehalfOf },
    run: row,
    // No batch state: inner reads never block or pend a batch, and touching it would reset the outer turn's state.
    batch: null,
    callId,
    systemAllowed: false,
  };
}

/** weft.call for one code.run: (name, args) to a GuestOutcome, inside the caller's transaction. */
export function sandboxCall(e: Engine, tx: DbTx, outer: ExecContext): (name: string, args: unknown) => Promise<GuestOutcome> {
  let n = 0;
  return async (name, args) => {
    n++;
    const def = e.registry.def(name) ?? null;
    const tainted = async () => (outer.run ? (await readTaint(tx, outer.run.id)).tainted : false);
    if (!def) return toGuest(refusal("UNKNOWN_COMMAND", `No command named ${name}`, await tainted()));
    if (def.sandbox !== "read") {
      return toGuest(refusal("SANDBOX_NOT_ALLOWED", `${def.name} cannot be called from code.run: only read commands can. Call it as a tool instead.`, await tainted()));
    }
    const scope = await sandboxScope(tx, outer, `sandbox:${outer.run?.stepN ?? 0}:${n}`);
    if (!scope) return toGuest(refusal("NOT_PERMITTED", "code.run runs inside agent runs", false));
    const { outcome } = await runInTx(e, tx, scope, def.name, args);
    return toGuest(outcome);
  };
}
