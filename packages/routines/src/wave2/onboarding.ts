// Wave 2 routines, prechecks and checklist predicates for the onboarding straggler nudge routine. Owner: w2-onboarding (docs/wave2.md).
// prebuilt.ts, prechecks.ts and checks.ts spread these maps in; add entries here only. Routine ids must be new (rt_ prefix).
// rt_onboarding_nudge: on weekday mornings, a deterministic precheck finds hires whose employee-owned onboarding tasks
// are past due and not yet nudged today; the model posts one nudge per hire in #new-hires naming the open tasks.
// It ships disabled (GP8 is a scenario test that triggers it); enable it in Routines to run it on schedule.
import type { Precheck, ReadOnlyExecutor, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

const TZ = "America/Los_Angeles";
const CHANNEL = "#new-hires";

export const RT_ONBOARDING_NUDGE: RoutineDef = {
  id: "rt_onboarding_nudge", name: "New-hire checklist nudge",
  description: "Weekday mornings, nudge new hires in #new-hires whose onboarding tasks are past due, once a day, until their checklist is complete.",
  ownerPrincipalId: "usr_dana", enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 10 * * 1-5", tz: TZ }, filter: null,
  instructions: "Post every nudge in the derived nudges list to #new-hires with comms.send_message, one call per nudge, using the derived text as is. Then write a one-line final message.",
  tools: ["documents.list_stragglers", "onboarding.get_checklist", "comms.send_message"],
  precheck: "onboarding_nudge",
  checklist: [{ id: "nudged", label: "nudge stragglers in #new-hires", check: `posted:${CHANNEL}` }],
  budget: { steps: 6, usd: 0.05, minutes: 10 }, surface: { worthSurfacing: false, channel: CHANNEL }, source: "prebuilt", taintedBy: null,
};

interface Straggler { worker_id: string; name: string; open_titles: string[]; due_on: string; nudged_today: boolean }

async function stragglers(exec: ReadOnlyExecutor, companyId: string): Promise<{ as_of: string; stragglers: Straggler[] } | null> {
  const o = await exec.exec(companyId, "documents.list_stragglers", {});
  return o.ok && o.status === "done" ? (o.data as { as_of: string; stragglers: Straggler[] }) : null;
}

/** The nudge text names the hire and the open tasks, with no numbers (comms.send_message grounds numbers). */
export const nudgeText = (s: Straggler) => `Friendly reminder for ${s.name}: please finish ${s.open_titles.join(", ")} in your new-hire portal so payroll can pay you on time. Reply here if anything is unclear.`;

export const onboardingNudge: Precheck = async (ctx, exec) => {
  const data = await stragglers(exec, ctx.companyId);
  if (!data) return { action: "skip", reason: "The onboarding checklists could not be read." };
  if (data.stragglers.length === 0) return { action: "skip", reason: `No hire has an overdue onboarding task as of ${data.as_of}.` };
  const due = data.stragglers.filter((s) => !s.nudged_today);
  if (due.length === 0) return { action: "skip", reason: `Every overdue hire was already nudged on ${data.as_of}.` };
  const nudges = due.map((s) => ({ channel: CHANNEL, text: nudgeText(s) }));
  return {
    action: "run", severity: "digest", subjectRefs: due.map((s) => s.worker_id),
    findings: { as_of: data.as_of, stragglers: due.map((s) => ({ worker_id: s.worker_id, name: s.name, open: s.open_titles, due_on: s.due_on })) },
    derivedArgs: { slot: data.as_of, nudges, "comms.send_message": nudges[0] },
  };
};

export const routines: RoutineDef[] = [RT_ONBOARDING_NUDGE];
export const prechecks: Record<string, Precheck> = { onboarding_nudge: onboardingNudge };
export const predicates: Record<string, Predicate> = {};
