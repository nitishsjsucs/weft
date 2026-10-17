// Code-owned checklist predicates (harness 4.3, SPEC 9.7). `isDone` is the conjunction of a routine's items. Each
// item is "<predicate>:<args>" with `{field}` templates over the trigger payload and the precheck's derived values.
// Predicates read the run's observed facts: its own tool outcomes (run_steps) and the proposal decisions the engine
// has seen. When the executor's actions.get_run exposes proposal status, `facts` can be built from it instead.
import type { ChecklistItem, ReadOnlyExecutor, RoutineDef } from "@weft/contracts";
import { predicates as w2Onboarding } from "./wave2/onboarding";
import { predicates as w2Benefits } from "./wave2/benefits";
import { predicates as w2Memory } from "./wave2/memory";
import { predicates as w3Expenses } from "./wave3/expenses";
import { predicates as w3TimeOff } from "./wave3/time-off";
import { predicates as w3Parity } from "./wave3/parity";
import { predicates as w3IntegrationsHr } from "./wave3/integrations-hr";
import { predicates as w3Screening } from "./wave3/screening";
import { predicates as w4Compliance } from "./wave4/compliance";
import { predicates as w4People } from "./wave4/people";
import { predicates as w4Agent } from "./wave4/agent";
import { predicates as w4Admin } from "./wave4/admin";
import { predicates as agencyNotice } from "./agency-notice";

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
  // Registration args name the tax account, not the worker, so the count comes from the precheck (register_count).
  registrations_proposed: ([, count = ""], f) => {
    const want = count === "" || !Number.isFinite(Number(count)) ? 1 : Number(count);
    return callsTo(f, "tax.register_state_account").filter((c) => c.status === "pending_approval" && live(f, c)).length >= want;
  },
  device_proposed: ([workerId = ""], f) => callsTo(f, "it.order_device").some((c) => c.status === "pending_approval" && live(f, c) && mentions(c.args, workerId)),
  ...w2Onboarding, ...w2Benefits, ...w2Memory,   // wave 2
  ...w3Expenses, ...w3TimeOff, ...w3Parity, ...w3IntegrationsHr, ...w3Screening,   // wave 3
  ...w4Compliance, ...w4People, ...w4Agent, ...w4Admin,   // wave 4
  ...agencyNotice,   // wave 4 round 1: rt_agency_notice per-plan items
};

/**
 * Plan gating (wave 4 round 1): an item whose check starts with "@plan=a|b " applies only when the precheck derived
 * one of those plans; it is left out of the run's checklist otherwise. Items without the prefix always apply.
 */
const PLAN_GATE = /^@plan=([A-Za-z0-9_|]+)\s+/;
export function appliesTo(item: Pick<ChecklistItem, "check">, scope: Record<string, unknown>): boolean {
  const g = PLAN_GATE.exec(item.check);
  return !g || g[1]!.split("|").includes(String(scope.plan ?? ""));
}
export function ungated(check: string): string {
  return check.replace(PLAN_GATE, "");
}
/** The items of a checklist that apply to this run's derived plan. */
export function checklistFor<T extends Pick<ChecklistItem, "check">>(items: readonly T[], scope: Record<string, unknown>): T[] {
  return items.filter((i) => appliesTo(i, scope));
}

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
  for (const item of checklistFor(routine.checklist as ChecklistItem[], scope)) {
    const { name, args } = parseCheck(ungated(item.check), scope);
    const p = PREDICATES[name];
    out.push({ id: item.id, label: item.label, passed: p ? Boolean(await p(args, facts, ctx)) : false });
  }
  return out;
}
