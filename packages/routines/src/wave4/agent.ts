// Wave 4 routines, prechecks and checklist predicates (docs/wave4.md). Owner: w4-parity-agent. Planned: rt_laptop_hand_delivery (the R14 example with a wait step), rt_portal_question_followup.
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
//
// rt_laptop_hand_delivery (R14, the worked example of wait and resume): when a new hire in the Austin office gets a
// worker record, ask in #new-hires for their laptop to be hand-delivered, then wait for the device to arrive
// (sim.device_delivered for that worker). While it waits the engine follows up every two days with a fresh segment
// that posts a reminder; when the delivery arrives it resumes once and posts a thank-you; after 14 days it stops and
// leaves the check to a person. The model only posts the derived text; code decides when to wait, resume and stop.
import type { ChecklistItemW4, Precheck, ReadOnlyExecutor, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

const OFFICE = { workplace: "Austin Yard", channel: "#new-hires" } as const;

const LAPTOP_CHECKLIST: ChecklistItemW4[] = [
  { id: "asked", label: "ask in the channel for the laptop to be hand-delivered", check: "posted:{channel}" },
  {
    id: "delivered", label: "the laptop reached the new hire", check: "device_delivered:{worker_id}",
    wait: { kind: "event", event: "sim.device_delivered", subjectRefTemplate: "{worker_id}", timeoutDays: 14, followUpEveryDays: 2 },
  },
];

export const RT_LAPTOP_HAND_DELIVERY: RoutineDef = {
  id: "rt_laptop_hand_delivery", name: "Laptop hand delivery (Austin office)",
  description: "When a new hire in the Austin office gets a worker record, ask in #new-hires for their laptop to be hand-delivered, wait for the delivery, follow up every two days and stop after two weeks.",
  ownerPrincipalId: "usr_dana", enabled: false, autonomy: "approve", trigger: { type: "event", event: "worker.created" }, filter: null,
  instructions: "Post the derived text to the derived channel with comms.send_message, exactly once in this run, then write a one-line summary. Do not order devices and do not message anyone else. Waiting for the delivery is done by Weft, not by you.",
  tools: ["comms.send_message", "people.get", "it.list_devices"],
  precheck: "laptop_hand_delivery",
  checklist: LAPTOP_CHECKLIST,
  budget: { steps: 4, usd: 0.02, minutes: 5 }, surface: { worthSurfacing: false, channel: OFFICE.channel }, source: "prebuilt", taintedBy: null,
};

async function read<T>(exec: ReadOnlyExecutor, companyId: string, command: string, args: unknown): Promise<T | null> {
  const o = await exec.exec(companyId, command, args).catch(() => null);
  return o && o.ok && o.status === "done" ? (o.data as T) : null;
}

interface Person { worker: { id: string; name: string; status: string; workplace: string | null; manager: string | null; start_date: string } }

/** Runs only for a worker in the office, and derives every line the segments post (code-owned text, ids and names from the DB). */
const laptopHandDelivery: Precheck = async (ctx, exec) => {
  const workerId = (ctx.payload as { worker_id?: unknown } | null)?.worker_id;
  if (typeof workerId !== "string" || !workerId.startsWith("wrk_")) return { action: "skip", reason: "No worker in the trigger." };
  const p = await read<Person>(exec, ctx.companyId, "people.get", { worker_id: workerId });
  if (!p) return { action: "skip", reason: `No worker ${workerId}.` };
  if (!(p.worker.workplace ?? "").startsWith(OFFICE.workplace)) return { action: "skip", reason: `${p.worker.name} is not in the ${OFFICE.workplace} office.` };
  const who = p.worker.manager ?? "Austin office lead";
  return {
    action: "run", severity: "interrupt", subjectRefs: [workerId],
    findings: { worker_id: workerId, name: p.worker.name, start_date: p.worker.start_date, office: OFFICE.workplace },
    derivedArgs: {
      worker_id: workerId, channel: OFFICE.channel,
      // No dates or counts in the text: comms.send_message grounds every number, and these lines need none.
      text: `${who}: ${p.worker.name} is joining us at ${OFFICE.workplace}. Please hand-deliver their laptop when it arrives and confirm here.`,
      follow_up_text: `Reminder for ${who}: the laptop for ${p.worker.name} has not been delivered yet. Is anything blocking it?`,
      resumed_text: `The laptop for ${p.worker.name} was delivered. Thank you, ${who}.`,
    },
  };
};

/** A device for the worker reached them: a delivered order (an assigned seed laptop without an order does not count). */
const deviceDelivered: Predicate = async ([workerId = ""], _facts, ctx) => {
  if (!workerId) return false;
  const d = await read<{ devices: { status: string; order_ref: string | null }[] }>(ctx.read, ctx.companyId, "it.list_devices", { worker_id: workerId });
  return (d?.devices ?? []).some((x) => x.order_ref !== null && (x.status === "delivered" || x.status === "assigned"));
};

export const routines: RoutineDef[] = [RT_LAPTOP_HAND_DELIVERY];
export const prechecks: Record<string, Precheck> = { laptop_hand_delivery: laptopHandDelivery };
export const predicates: Record<string, Predicate> = { device_delivered: deviceDelivered };
