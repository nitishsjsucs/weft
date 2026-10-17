// Drivers: turn a task's input into a run in the trial world (research/wave4/evals.md 4.1). Owner: w4-eval-suite.
// chat posts the request as the task's principal; routine starts the routine the way its trigger does in the product:
//   event null                       -> POST /v1/routines/<id>/trigger (a person's manual trigger)
//   { type: "notice.deliver", scenario } -> the agency notice simulator delivers that scenario
//   { type: "offer.sign", ... }      -> a person drafts and sends an offer and the candidate signs it (GP18)
//   any other { type, ...payload }   -> that domain event is emitted with the payload
// portal and mention surfaces land with w4-parity-agent; until then their tasks end with SURFACE_UNAVAILABLE.
import type { EvalTask } from "../../packages/contracts/src/evals";
import type { TrialWorld } from "./worlds/index";

export interface DriveResult { mainRunId: string | null; routineRunId: string | null; chatMode: string | null; error: string | null }

export const KNOWN_EVENT_DRIVERS = new Set(["notice.deliver", "offer.sign"]);

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
    const { type: rawType, ...payload } = event;
    const type = String(rawType ?? "");
    if (type === "notice.deliver") {
      return routineByEvent(w, routineId, async () => {
        const res = await post(w, "/v1/sim/notices/deliver", { scenario: payload.scenario }, task.principal);
        return res.status === 200 ? null : `START_REFUSED: deliver answered ${res.status}`;
      });
    }
    if (type === "offer.sign") return routineByEvent(w, routineId, () => signOffer(w, task.principal, payload));
    return routineByEvent(w, routineId, async () => {
      const { emitEvent } = await import("../../packages/core/src/shared/events");
      const { withWriteLock } = await import("../../packages/db/src/index");
      await withWriteLock(() => w.weft.db.transaction(async (tx) => {
        await emitEvent(tx as never, w.weft.clock as never, { body: { type, payload } as never, subjectRef: payload.subject_ref ?? Object.values(payload)[0] ?? type, attended: false, requestedBy: null });
      }));
      return null;
    });
  }
  const surface = Object.keys(input)[0];
  return { mainRunId: null, routineRunId: null, chatMode: null, error: `SURFACE_UNAVAILABLE: the ${surface} surface lands with w4-parity-agent` };
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
