// Wave 2 routines, prechecks and checklist predicates for the open enrollment chase and carrier reconciliation routines. Owner: w2-benefits-contractors (docs/wave2.md).
// prebuilt.ts, prechecks.ts and checks.ts spread these maps in; add entries here only. Routine ids must be new (rt_ prefix).
//
// rt_open_enrollment (GP11): on weekday mornings, while 2027 open enrollment is open, post one reminder in #general
// naming every employee who has not elected or waived. Disabled by default. The precheck builds the message from
// benefits.list_open_enrollment (names only, no digits, so comms.send_message grounding passes) and skips when everyone
// has chosen, when the deadline has passed, or when everyone left was already reminded today. The cron slot
// dedupes repeat runs on the same day.
import type { Precheck, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

export const OPEN_ENROLLMENT_CLOSES = "2026-11-13";
const TZ = "America/Los_Angeles";
const ptDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.parse(iso)));

export const RT_OPEN_ENROLLMENT: RoutineDef = {
  id: "rt_open_enrollment", name: "Open enrollment chase",
  description: "On weekday mornings during open enrollment, remind everyone who has not elected or waived next year's benefits in #general.",
  ownerPrincipalId: "usr_dana", enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 10 * * 1-5", tz: TZ }, filter: null,
  instructions: "Post the reminder text from the derived arguments to #general with comms.send_message, unchanged. Then write a one-line final message naming how many people were reminded.",
  tools: ["benefits.list_open_enrollment", "comms.send_message"],
  precheck: "open_enrollment",
  checklist: [{ id: "posted", label: "post the reminder in #general", check: "posted:#general:{slot}" }],
  budget: { steps: 4, usd: 0.05, minutes: 5 }, surface: { worthSurfacing: false, channel: "#general" }, source: "prebuilt", taintedBy: null,
};

type OeRow = { worker: string; status: string; last_nudged_at: string | null };

/** The reminder text: names only (the worker refs carry ids with digits, so they are stripped). */
export function openEnrollmentReminder(names: string[]): string {
  return `Open enrollment reminder: ${names.join(", ")} still need to elect or waive next year's benefits. Please choose in Weft Benefits before enrollment closes.`;
}

export const openEnrollmentPrecheck: Precheck = async (ctx, exec) => {
  const today = ptDate(ctx.now);
  if (today > OPEN_ENROLLMENT_CLOSES) return { action: "skip", reason: `Open enrollment closed on ${OPEN_ENROLLMENT_CLOSES}.` };
  const out = await exec.exec(ctx.companyId, "benefits.list_open_enrollment", {});
  if (!out.ok || out.status !== "done") return { action: "skip", reason: "Could not read open enrollment." };
  const people = ((out.data as { people?: OeRow[] }).people ?? []).filter((r) => r.status === "not_started" || r.status === "in_progress");
  if (people.length === 0) return { action: "skip", reason: "Everyone has elected or waived." };
  if (people.every((r) => r.last_nudged_at !== null && ptDate(r.last_nudged_at) === today)) return { action: "skip", reason: "Everyone left was already reminded today." };
  const names = people.map((r) => r.worker.replace(/\s*\(wrk_[A-Za-z0-9_]+\)\s*$/, ""));
  const slot = (typeof (ctx.payload as { slot?: unknown } | null)?.slot === "string" ? (ctx.payload as { slot: string }).slot : null) ?? ctx.triggerRef;
  const text = openEnrollmentReminder(names);
  return { action: "run", severity: "digest", subjectRefs: [], findings: { pending: names.length, slot }, derivedArgs: { slot, "comms.send_message": { channel: "#general", text } } };
};

// RT_OPEN_ENROLLMENT is defined and its precheck registered, but it joins PREBUILT only once
// packages/routines/test/engine.test.ts stops asserting the exact four wave 1 ids (integrator, see
// .scratch/contract-requests/w2-benefits-contractors.md): then this line becomes [RT_OPEN_ENROLLMENT].
export const routines: RoutineDef[] = [];
export const prechecks: Record<string, Precheck> = { open_enrollment: openEnrollmentPrecheck };
export const predicates: Record<string, Predicate> = {};
