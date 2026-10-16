// Wave 3 routines, prechecks and checklist predicates (docs/wave3.md). Owner: w3-timeoff. Planned: rt_time_off_requests (and the out-this-week line for rt_people_digest through its own precheck helper).
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
//
// rt_time_off_requests (GP14, research/wave3/expenses-timeoff.md 6.6): when a request is created, the zero-token
// precheck reads the request (its checks and routing were computed at submit), the balance before and after and the
// team calendar, and derives one time_off.decide proposal (approve when nothing blocks, else deny naming the rule)
// with a grounded note, plus a #people-ops post without digits (comms.send_message grounding). The model files the
// proposal and the post; the routed approver decides. Ships disabled; a manual run picks the oldest pending request.
import { CHAT_ACT_TOOLS, W3_PLANNED_COMMANDS, type Precheck, type RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

const TZ = "America/Los_Angeles";
/** The time-off decision tool, named from the contracts list (the brain never spells the executor's decision verb). */
/** (The only time_off R2 command that chat may also propose.) */
export const TIME_OFF_DECISION_TOOL: string = (() => {
  const act = new Set<string>(CHAT_ACT_TOOLS);
  const found = W3_PLANNED_COMMANDS.filter((c) => c.owner === "w3-timeoff" && c.risk === "R2" && c.access === "all" && act.has(c.name)).map((c) => c.name);
  if (found.length !== 1) throw new Error(`rt_time_off_requests: expected one time-off decision tool, found ${found.join(", ")}`);
  return found[0]!;
})();
const h = (m: number) => `${(m / 60).toFixed(2)} h`;

export const RT_TIME_OFF_REQUESTS: RoutineDef = {
  id: "rt_time_off_requests", name: "Time-off request review",
  description: "When someone requests time off, check the balance and team coverage, then propose a decision for the person who approves it.",
  ownerPrincipalId: "usr_dana", enabled: false, autonomy: "approve", trigger: { type: "event", event: "time_off.request.created" }, filter: null,
  instructions: "Use the derived arguments unchanged. First post the notice to #people-ops with comms.send_message, then propose the approval or denial with the time-off tool (it waits for the routed approver). Never approve or deny anything else. Then write a one-line final message naming the request and the proposed decision.",
  tools: ["time_off.get_balance", "time_off.list_requests", "time_off.team_calendar", "time_off.check_request", TIME_OFF_DECISION_TOOL, "people.get", "comms.send_message"],
  precheck: "time_off_requests",
  checklist: [
    { id: "proposed", label: "propose a decision for the approver", check: `proposal_exists:${TIME_OFF_DECISION_TOOL}:{request_id}` },
    { id: "notified", label: "tell #people-ops who decides", check: "posted:#people-ops" },
  ],
  budget: { steps: 4, usd: 0.05, minutes: 5 }, surface: { worthSurfacing: true, channel: "#people-ops" }, source: "prebuilt", taintedBy: null,
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
interface ReqView { id: string; workerId: string; workerName: string; departmentId: string | null; policyId: string; policyName: string; typeKind: string | null; status: string; startAt: string; endAt: string; requestedMinutes: number; approverPrincipalId: string | null; days: { date: string; minutes: number; holiday: boolean }[]; checks: { rule: string; severity: string; message: string }[] }

/** The proposal note: balance before and after, the review checks and the holidays inside the range. */
export function decisionNote(r: ReqView, availableBefore: number | null): string {
  const parts: string[] = [];
  if (availableBefore !== null) parts.push(`${r.policyName} available ${h(availableBefore + r.requestedMinutes)} before this request, ${h(availableBefore)} after`);
  for (const c of r.checks.filter((x) => x.severity !== "info")) parts.push(`${c.rule}: ${c.message}`);
  const hol = r.days.filter((d) => d.holiday).map((d) => d.date);
  if (hol.length) parts.push(`company holidays ${hol.join(", ")} are charged 0 h`);
  return parts.join(". ").slice(0, 400);
}

export const timeOffRequestsPrecheck: Precheck = async (ctx, exec) => {
  const payload = obj(ctx.payload);
  const wanted = typeof payload.request_id === "string" ? payload.request_id : null;
  const out = await exec.exec(ctx.companyId, "time_off.list_requests", wanted ? { request_id: wanted } : { status: "pending" });
  if (!out.ok || out.status !== "done") return { action: "skip", reason: "Could not read the time-off request." };
  const list = ((obj(out.data).requests as ReqView[] | undefined) ?? []).filter((r) => r.status === "pending");
  const r = list.sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  if (!r) return { action: "skip", reason: wanted ? `${wanted} is no longer pending.` : "No pending time-off requests." };
  const bal = await exec.exec(ctx.companyId, "time_off.get_balance", { worker_id: r.workerId, policy_id: r.policyId });
  const b = bal.ok && bal.status === "done" ? ((obj(bal.data).balances as { availableMinutes: number }[] | undefined) ?? [])[0] : undefined;
  const blocking = r.checks.filter((c) => c.severity === "block").map((c) => c.rule);
  const decision = blocking.length ? "deny" : "approve";
  const note = blocking.length ? `Blocked by ${blocking.join(", ")}. ${decisionNote(r, b?.availableMinutes ?? null)}`.slice(0, 400) : decisionNote(r, b?.availableMinutes ?? null);
  const review = r.checks.filter((c) => c.severity === "review").map((c) => c.rule.toLowerCase().replace(/_/g, " "));
  const text = `A time-off request from ${r.workerName} is ready for a decision in Time Off. Weft is proposing to ${decision} it${review.length ? `; please look at the ${review.join(" and ")} first` : ""}.`;
  return {
    action: "run", severity: blocking.length || review.length ? "interrupt" : "digest", subjectRefs: [r.id, r.workerId],
    findings: { request_id: r.id, worker: r.workerName, approver: r.approverPrincipalId, decision, checks: r.checks.map((c) => `${c.rule} (${c.severity})`), tz: TZ },
    derivedArgs: { request_id: r.id, approver: r.approverPrincipalId ?? "usr_dana", [TIME_OFF_DECISION_TOOL]: { request_id: r.id, decision, note }, "comms.send_message": { channel: "#people-ops", text } },
  };
};

export const routines: RoutineDef[] = [RT_TIME_OFF_REQUESTS];
export const prechecks: Record<string, Precheck> = { time_off_requests: timeOffRequestsPrecheck };
export const predicates: Record<string, Predicate> = {};
