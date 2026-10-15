// Code-owned checklist predicates (harness 4.3, SPEC 9.7). `isDone` is the conjunction of a routine's items. Each
// item is "<predicate>:<args>" with `{field}` templates over the trigger payload and the precheck's derived values.
// Predicates read the run's observed facts: its own tool outcomes (run_steps) and the proposal decisions the engine
// has seen. When the executor's actions.get_run exposes proposal status, `facts` can be built from it instead.
import type { ChecklistItem, ReadOnlyExecutor, RoutineDef } from "@weft/contracts";

export interface RunCall { command: string; args: unknown; status: "done" | "pending_approval" | "refused"; proposalId: string | null; data: unknown }
export interface RunFacts { calls: RunCall[]; proposalStatus: (proposalId: string) => string | null }

export type Predicate = (args: string[], facts: RunFacts, ctx: { companyId: string; agentRunId: string; read: ReadOnlyExecutor }) => Promise<boolean> | boolean;

const json = (v: unknown) => JSON.stringify(v ?? null);
const mentions = (v: unknown, needle: string) => needle === "" || json(v).includes(needle);
const live = (facts: RunFacts, c: RunCall) => {
  if (c.status !== "pending_approval" || !c.proposalId) return c.status === "done";
  const s = facts.proposalStatus(c.proposalId) ?? "pending";
  return !["denied", "expired", "failed", "superseded", "dismissed"].includes(s);
};
const wireToName = (s: string) => s.replace("__", ".");
const callsTo = (facts: RunFacts, command: string) => facts.calls.filter((c) => wireToName(c.command) === command);

export const PREDICATES: Record<string, Predicate> = {
  draft_exists: ([noticeId = ""], f) => callsTo(f, "notices.draft_response").some((c) => c.status === "done" && mentions(c.args, noticeId)),
  proposal_exists: ([command = "", subject = ""], f) => callsTo(f, command).some((c) => c.status === "pending_approval" && live(f, c) && mentions(c.args, subject)),
  // payroll.explain_flags (t1-payroll) returns counts: refused and unexplained_flagged.
  explanations_complete: ([runId = ""], f) => callsTo(f, "payroll.explain_flags").some((c) => {
    if (c.status !== "done" || !mentions(c.args, runId)) return false;
    const d = (c.data ?? {}) as { unexplained_flagged?: number; refused?: number };
    return d.unexplained_flagged !== undefined ? d.unexplained_flagged === 0 : !(Number(d.refused) > 0);
  }),
  accounts_created: ([workerId = ""], f) => callsTo(f, "it.create_account").filter((c) => (c.status === "done" || live(f, c)) && mentions(c.args, workerId)).length >= 3,
  posted: ([channel = ""], f) => callsTo(f, "comms.send_message").some((c) => live(f, c) && mentions(c.args, channel)),
  registrations_proposed: ([workerId = ""], f) => callsTo(f, "tax.register_state_account").filter((c) => c.status === "pending_approval" && live(f, c) && mentions(c.args, workerId)).length >= 2,
  device_proposed: ([workerId = ""], f) => callsTo(f, "it.order_device").some((c) => c.status === "pending_approval" && live(f, c) && mentions(c.args, workerId)),
};

/** Expand `{field}` from the scope (trigger payload first, then derived values). Unknown fields expand to "". */
export function expand(template: string, scope: Record<string, unknown>): string {
  return template.replace(/\{([A-Za-z0-9_.]+)\}/g, (_m, k: string) => {
    const v = scope[k];
    return v === undefined || v === null ? "" : String(v);
  });
}

export function parseCheck(check: string, scope: Record<string, unknown>): { name: string; args: string[] } {
  const expanded = expand(check, scope);
  const [name, ...rest] = expanded.split(":");
  // Channel names and cron slot refs contain ':' only in the last argument; rejoin the tail.
  if (name === "posted" && rest.length > 2) return { name, args: [rest[0]!, rest.slice(1).join(":")] };
  return { name: name!, args: rest };
}

export async function evaluateChecklist(
  routine: Pick<RoutineDef, "checklist">, scope: Record<string, unknown>, facts: RunFacts, ctx: { companyId: string; agentRunId: string; read: ReadOnlyExecutor },
): Promise<{ id: string; label: string; passed: boolean }[]> {
  const out: { id: string; label: string; passed: boolean }[] = [];
  for (const item of routine.checklist as ChecklistItem[]) {
    const { name, args } = parseCheck(item.check, scope);
    const p = PREDICATES[name];
    out.push({ id: item.id, label: item.label, passed: p ? Boolean(await p(args, facts, ctx)) : false });
  }
  return out;
}
