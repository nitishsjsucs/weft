// Drivers: turn a task's input into a run in the trial world (research/wave4/evals.md 4.1). Owner: w4-eval-suite.
// chat posts the request as the task's principal; routine starts the routine the way its trigger does in the product:
//   event null                       -> POST /v1/routines/<id>/trigger (a person's manual trigger)
//   { type: "notice.deliver", scenario } -> the agency notice simulator delivers that scenario
//   { type: "offer.sign", ... }      -> a person drafts and sends an offer and the candidate signs it (GP18)
//   any other { type, ...payload }   -> that domain event is emitted with the payload
//   times: "2" on a routine event    -> the start repeats, each after the previous routine run settles: a second
//                                      notice.deliver is a second copy of the same letter, a second domain event is
//                                      a redelivery of the same payload (fix group duplicate-proposal); 1 to 3
//   { portal: text }                -> the asker's portal question (POST /v1/portal/agent/runs); a human-only topic is
//                                      handed off in code and starts no run
//   { mention: text, channel }      -> the task principal tags the agent in a chat channel (POST /v1/sim/chat/inbound);
//                                      the trial waits for the tainted read-only run and its answer in the thread
import type { EvalTask } from "../../packages/contracts/src/evals";
import type { TrialWorld } from "./worlds/index";

export interface DriveResult { mainRunId: string | null; routineRunId: string | null; chatMode: string | null; error: string | null }

export const KNOWN_EVENT_DRIVERS = new Set(["notice.deliver", "offer.sign"]);
/** The driver key on a routine event that repeats its start (never part of the emitted payload). */
export const EVENT_TIMES_KEY = "times";
export const MAX_EVENT_TIMES = 3;
export function eventTimes(event: Record<string, string> | null): number | null {
  const v = event?.[EVENT_TIMES_KEY];
  if (v === undefined) return 1;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_EVENT_TIMES ? n : null;
}

/** Repeats a routine start; the trial's main run is the first one that started an agent run. */
async function repeated(times: number, once: () => Promise<DriveResult>): Promise<DriveResult> {
  const all: DriveResult[] = [];
  for (let i = 0; i < times; i++) {
    const r = await once();
    if (r.error) return r;
    all.push(r);
  }
  return all.find((r) => r.mainRunId) ?? all.at(-1)!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Settled = { id: string; status: string; stepsUsed: number; summary: string | null; tainted: boolean };
const settled = (w: TrialWorld, runId: string) => (w.weft.agent as unknown as { settled(id: string): Promise<Settled> }).settled(runId);
const post = (w: TrialWorld, path: string, body: unknown, who: string) => w.weft.app.request(path, { method: "POST", headers: w.headers(who), body: JSON.stringify(body) });

async function waitForAgentRun(w: TrialWorld, find: () => Promise<string | null>, ticks = 40): Promise<string | null> {
  for (let i = 0; i < ticks; i++) {
    await w.weft.scheduler.tick();
    const id = await find();
    if (id) return id;
    await sleep(150);
  }
  return null;
}
const routineAgentRun = async (w: TrialWorld, routineId: string, after: Set<string>) =>
  (await w.q("SELECT id, agent_run_id FROM routine_runs WHERE routine_id = ? AND agent_run_id IS NOT NULL ORDER BY id", [routineId])).map((r) => ({ id: String(r.id), run: String(r.agent_run_id) })).find((r) => !after.has(r.id)) ?? null;

/** Every routine run leaves queued and running before the world closes (its finalization writes after the agent run settles). */
export async function drainRoutines(w: TrialWorld): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const open = await w.q("SELECT id FROM routine_runs WHERE status IN ('queued', 'running')");
    if (!open.length) break;
    await sleep(150);
  }
  await sleep(100);
}

/** A routine run that finished without an agent run (a precheck or template path handled it): not an error. */
async function finishedWithoutAgent(w: TrialWorld, routineId: string, before: Set<string>, routineRunId: string | null): Promise<{ id: string; status: string } | null> {
  const rows = (await w.q("SELECT id, status, agent_run_id FROM routine_runs WHERE routine_id = ? ORDER BY id", [routineId])).filter((r) => (routineRunId ? String(r.id) === routineRunId : !before.has(String(r.id))));
  const r = rows.find((x) => !x.agent_run_id && x.status !== "queued" && x.status !== "running");
  return r ? { id: String(r.id), status: String(r.status) } : null;
}

async function routineByEvent(w: TrialWorld, routineId: string, start: () => Promise<string | null>): Promise<DriveResult> {
  const before = new Set((await w.q("SELECT id FROM routine_runs WHERE routine_id = ?", [routineId])).map((r) => String(r.id)));
  const err = await start();
  if (err) return { mainRunId: null, routineRunId: null, chatMode: null, error: err };
  let rr: { id: string; run: string } | null = null;
  let done: { id: string; status: string } | null = null;
  await waitForAgentRun(w, async () => {
    rr = await routineAgentRun(w, routineId, before);
    if (rr) return rr.run;
    done = await finishedWithoutAgent(w, routineId, before, null);
    return done ? "none" : null;
  });
  const found = rr as { id: string; run: string } | null;
  const handled = done as { id: string; status: string } | null;
  if (!found && handled) return { mainRunId: null, routineRunId: handled.id, chatMode: null, error: null };
  if (!found) return { mainRunId: null, routineRunId: null, chatMode: null, error: `NO_RUN: ${routineId} started no routine run` };
  await settled(w, found.run);
  return { mainRunId: found.run, routineRunId: found.id, chatMode: null, error: null };
}

export async function drive(w: TrialWorld, task: EvalTask): Promise<DriveResult> {
  const input = task.input as Record<string, unknown>;
  if ("chat" in input) {
    const res = await post(w, "/v1/agent/runs", { text: input.chat, pageContext: null }, task.principal);
    if (res.status !== 202) return { mainRunId: null, routineRunId: null, chatMode: null, error: `START_REFUSED: chat start answered ${res.status} ${(await res.text()).slice(0, 200)}` };
    const { runId, chatMode } = (await res.json()) as { runId: string; chatMode: string };
    await settled(w, runId);
    return { mainRunId: runId, routineRunId: null, chatMode, error: null };
  }
  if ("routine" in input) {
    const routineId = String(input.routine);
    const event = (input.event ?? null) as Record<string, string> | null;
    if (!event) {
      const res = await post(w, `/v1/routines/${routineId}/trigger`, {}, task.principal);
      if (res.status !== 200) return { mainRunId: null, routineRunId: null, chatMode: null, error: `START_REFUSED: trigger answered ${res.status} ${(await res.text()).slice(0, 200)}` };
      const { routineRunId } = (await res.json()) as { routineRunId: string };
      const runId = await waitForAgentRun(w, async () => {
        const r = await w.q("SELECT agent_run_id, status FROM routine_runs WHERE id = ?", [routineRunId]);
        if (r[0]?.agent_run_id) return String(r[0].agent_run_id);
        return r[0] && r[0].status !== "queued" && r[0].status !== "running" ? "none" : null;
      });
      if (runId === "none") return { mainRunId: null, routineRunId, chatMode: null, error: null };
      if (!runId) return { mainRunId: null, routineRunId, chatMode: null, error: `NO_RUN: ${routineId} run ${routineRunId} never left queued` };
      await settled(w, runId);
      return { mainRunId: runId, routineRunId, chatMode: null, error: null };
    }
    const { type: rawType, [EVENT_TIMES_KEY]: _times, ...payload } = event;
    const type = String(rawType ?? "");
    const times = eventTimes(event);
    if (times === null) return { mainRunId: null, routineRunId: null, chatMode: null, error: `START_REFUSED: times must be 1 to ${MAX_EVENT_TIMES}` };
    if (type === "notice.deliver") {
      return repeated(times, () => routineByEvent(w, routineId, async () => {
        const res = await post(w, "/v1/sim/notices/deliver", { scenario: payload.scenario }, task.principal);
        return res.status === 200 ? null : `START_REFUSED: deliver answered ${res.status}`;
      }));
    }
    if (type === "offer.sign") return routineByEvent(w, routineId, () => signOffer(w, task.principal, payload));
    return repeated(times, () => routineByEvent(w, routineId, async () => {
      const { emitEvent } = await import("../../packages/core/src/shared/events");
      const { withWriteLock } = await import("../../packages/db/src/index");
      await withWriteLock(() => w.weft.db.transaction(async (tx) => {
        await emitEvent(tx as never, w.weft.clock as never, { body: { type, payload } as never, subjectRef: payload.subject_ref ?? Object.values(payload)[0] ?? type, attended: false, requestedBy: null });
      }));
      return null;
    }));
  }
  if ("portal" in input) {
    const res = await post(w, "/v1/portal/agent/runs", { text: input.portal }, task.principal);
    if (res.status !== 200 && res.status !== 202) return { mainRunId: null, routineRunId: null, chatMode: null, error: `START_REFUSED: portal ask answered ${res.status} ${(await res.text()).slice(0, 200)}` };
    const out = (await res.json()) as { runId: string | null; status: string };
    if (!out.runId) return { mainRunId: null, routineRunId: null, chatMode: "portal_handoff", error: null };
    await settled(w, out.runId);
    return { mainRunId: out.runId, routineRunId: null, chatMode: "portal", error: null };
  }
  if ("mention" in input) {
    const res = await post(w, "/v1/sim/chat/inbound", { channel: input.channel, from: task.principal, text: input.mention }, task.principal);
    if (res.status !== 200 && res.status !== 202) return { mainRunId: null, routineRunId: null, chatMode: null, error: `START_REFUSED: inbound chat answered ${res.status} ${(await res.text()).slice(0, 200)}` };
    const { mentionId } = (await res.json()) as { mentionId: string | null };   // 202 with a runId when a run started
    if (!mentionId) return { mainRunId: null, routineRunId: null, chatMode: "mention_ignored", error: null };
    let runId: string | null = null;
    for (let i = 0; i < 200; i++) {   // the answer posts in the thread after the run settles
      const [m] = await w.q("SELECT status, run_id FROM agent_mentions WHERE id = ?", [mentionId]);
      if (m?.run_id && !runId) { runId = String(m.run_id); await settled(w, runId); }
      if (m && m.status !== "queued" && m.status !== "running") break;
      await sleep(50);
    }
    return { mainRunId: runId, routineRunId: null, chatMode: "mention", error: null };
  }
  const surface = Object.keys(input)[0];
  return { mainRunId: null, routineRunId: null, chatMode: null, error: `SURFACE_UNAVAILABLE: no driver for the ${surface} surface` };
}

/** GP18's offer flow: a person drafts and sends an offer, the candidate persona signs it in the portal. */
async function signOffer(w: TrialWorld, who: string, p: Record<string, string>): Promise<string | null> {
  const call = async (as: string, method: string, path: string, body?: unknown) => (await w.weft.app.request(path, { method, headers: w.headers(as), body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<Record<string, any>>;
  const draft = await call(who, "POST", "/v1/offers", {
    candidateFirst: p.first, candidateLast: p.last, candidateEmail: p.email, title: p.title, departmentId: p.department,
    workState: p.state, baseCents: Number(p.base_cents), payKind: p.pay_kind ?? "salary", startDate: p.start,
  });
  const offerId = draft?.data?.offer_id as string | undefined;
  if (!offerId) return `START_REFUSED: offer draft failed ${JSON.stringify(draft).slice(0, 200)}`;
  const persona = (await call(who, "POST", `/v1/offers/${offerId}/send`))?.data?.persona_principal_id as string | undefined;
  if (!persona) return "START_REFUSED: offer send failed";
  const letter = ((await call(persona, "GET", "/v1/portal/me")).documents as { id: string; kind: string; sha256: string }[]).find((d) => d.kind === "offer_letter");
  if (!letter) return "START_REFUSED: no offer letter in the portal";
  const signed = await call(persona, "POST", `/v1/portal/documents/${letter.id}/sign`, { typedName: `${p.first} ${p.last}`, documentSha256: letter.sha256 });
  return signed?.data?.offer_status === "accepted" ? null : `START_REFUSED: offer not accepted ${JSON.stringify(signed).slice(0, 200)}`;
}
