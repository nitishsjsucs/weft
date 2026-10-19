// /v1 routines routes. Owner: t4-agent. Paths from packages/contracts/src/api.ts.
// Reads come from the routines engine; draft runs the deterministic parser, then routines.draft as the human (the
// proposal notifier turns routine.drafted into a routine_enable proposal); enable and disable are UI-only human
// commands through the HumanExecutor. Every mutation calls scheduler.kick() before it answers.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { DRAFT_TOOLS, NotFound, Refused, Unauthorized, type RoutineDef, type RoutineRun, type WeftEvent } from "@weft/contracts";
import { events, type Db } from "@weft/db";
// Relative on purpose: @weft/core exports only "." and its index is shared; the integrator may re-export it there.
import { parseRoutineDraft } from "../../../../packages/core/src/routines/draft-parser";
import type { EventSource, WeftRoutinesEngine } from "@weft/routines";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { RT_COMPLIANCE_NOTICES } from "../../../../packages/contracts/src/ext/w4-parity-compliance";

/** Routines kept only for the record (folded into another one; they never run). The gallery and the list leave them
 * out; `?include=retired` and GET /v1/routines/:id still return them. */
export const RETIRED_ROUTINES: ReadonlySet<string> = new Set([RT_COMPLIANCE_NOTICES]);

/** Marker the routines engine appends to events.consumed_json once it has matched an event against the routines. */
export const ROUTINES_CONSUMER = "routines";

/**
 * The events source for createRoutines({ events }). Boundary rule 1 keeps the brain off the events table, so the
 * composition root passes this one: unconsumed means consumed_json lacks "routines", in rowid order.
 */
export function createRoutinesEventSource(db: Db): EventSource {
  return {
    async unconsumed(): Promise<WeftEvent[]> {
      const rows = await db.all<{ id: string; type: string; ts: string; subject_ref: string; payload_json: string; attended: number; requested_by: string | null; consumed_json: string }>(
        sql`SELECT id, type, ts, subject_ref, payload_json, attended, requested_by, consumed_json FROM ${events} ORDER BY rowid`);
      return rows
        .filter((r) => { try { return !(JSON.parse(r.consumed_json) as string[]).includes(ROUTINES_CONSUMER); } catch { return true; } })
        .map((r) => ({ id: r.id, type: r.type, ts: r.ts, subjectRef: r.subject_ref, payload: JSON.parse(r.payload_json) as Record<string, string>, attended: !!r.attended, requestedBy: r.requested_by }));
    },
    async consume(eventId: string): Promise<void> {
      await db.run(sql`UPDATE ${events} SET consumed_json = json_insert(CASE WHEN json_valid(consumed_json) THEN consumed_json ELSE '[]' END, '$[#]', ${ROUTINES_CONSUMER})
        WHERE id = ${eventId} AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(consumed_json) THEN consumed_json ELSE '[]' END) WHERE value = ${ROUTINES_CONSUMER})`);
    },
  };
}

const DraftBody = z.object({ prompt: z.string().min(1).max(400) });
/** Wave 3 (w3-parity-routines): an autonomy change is a proposal (routines.set_autonomy), approved in the Inbox. */
const AutonomyBody = z.object({ autonomy: z.enum(["recommend", "approve", "auto"]) });

export function routinesRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  const engine = weft.routines as WeftRoutinesEngine;
  const session = (c: Context<WeftEnv>) => {
    const v = c.get("session");
    if (!v) throw new Unauthorized();
    return v;
  };
  const kick = async () => { try { await weft.scheduler.kick(); } catch { /* the scheduler may still be a stub */ } };
  const getRoutine = async (id: string): Promise<RoutineDef> => {
    const def = await engine.view.get(id);
    if (!def) throw new NotFound(`No routine ${id}`);
    return def;
  };
  const dto = (run: RoutineRun) => ({ ...run, durationMs: run.startedAt && run.endedAt ? new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime() : null });

  // Wave 3 (w3-parity-routines): each row also carries lastRun and nextRunAt for the gallery and the list.
  r.get("/v1/routines", async (c) => {
    const defs = (await engine.list()).filter((d) => c.req.query("include") === "retired" || !RETIRED_ROUTINES.has(d.id));
    const ov = typeof engine.overview === "function" ? new Map((await engine.overview()).map((o) => [o.routineId, o])) : new Map();
    return c.json(defs.map((d) => ({ ...d, lastRun: ov.get(d.id)?.lastRun ?? null, nextRunAt: ov.get(d.id)?.nextRunAt ?? null })));
  });

  r.get("/v1/routines/:id", async (c) => c.json(await getRoutine(c.req.param("id"))));

  r.get("/v1/routines/:id/runs", async (c) => {
    await getRoutine(c.req.param("id"));
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 25) || 25));
    const rows = await engine.runs(c.req.param("id"), limit + 1);
    return c.json({ hasMore: rows.length > limit, count: Math.min(rows.length, limit), data: rows.slice(0, limit).map(dto) });
  });

  r.get("/v1/routine-runs/:id", async (c) => {
    const run = await engine.getRun(c.req.param("id"));
    if (!run) throw new NotFound(`No routine run ${c.req.param("id")}`);
    return c.json(dto(run));
  });

  r.post("/v1/routines/:id/trigger", async (c) => {
    const s = session(c);
    await getRoutine(c.req.param("id"));
    const out = await engine.trigger(c.req.param("id"), { attended: true, requestedBy: s.principalId });
    await kick();
    return c.json(out);
  });

  r.post("/v1/routines/draft", async (c) => {
    const s = session(c);
    const body = DraftBody.parse(await c.req.json());
    const p = parseRoutineDraft(body.prompt);
    if (!p.ok) {
      // Only a live provider gets the model-backed routine_draft recipe (attended); otherwise ask for a clearer prompt.
      if (!weft.provider.live) throw new Refused(p.reason, p.hint);
      const handle = await weft.executor.runs.openChatRun(s, { threadId: null, surface: "human_ui", allowlist: DRAFT_TOOLS });
      await weft.agent.startChat(handle, { text: body.prompt, recipe: "routine_draft", pageContext: null });
      return c.json({ runId: handle.runId, parser: { reason: p.reason } }, 202);
    }
    const outcome = await weft.executor.human.exec(s, "routines.draft", { name: p.name, cron: p.cron, tz: p.tz, channel: p.channel, tools: p.tools, instructions: p.instructions, precheck: p.precheck });
    await kick();
    return c.json(outcome);
  });

  for (const action of ["enable", "disable"] as const) {
    r.post(`/v1/routines/:id/${action}`, async (c) => {
      const s = session(c);
      await getRoutine(c.req.param("id"));
      const outcome = await weft.executor.human.exec(s, `routines.${action}`, { routine_id: c.req.param("id") });
      await kick();
      if (!outcome.ok) return c.json({ ...outcome, _tag: "Refused", code: outcome.refusal.code, message: outcome.refusal.message }, 422);
      return c.json(outcome);
    });
  }

  r.post("/v1/routines/:id/autonomy", async (c) => {
    const s = session(c);
    const def = await getRoutine(c.req.param("id"));
    const body = AutonomyBody.parse(await c.req.json().catch(() => ({})));
    if (def.autonomy === body.autonomy) throw new Refused("DOMAIN_NO_CHANGE", `${def.id} is already at ${body.autonomy}`);
    const human = weft.executor.human;
    if (!human.propose) throw new Refused("NOT_PERMITTED", "This executor cannot file proposals for a person");
    const outcome = await human.propose(s, "routines.set_autonomy", { routine_id: def.id, autonomy: body.autonomy });
    await kick();
    if (!outcome.ok) return c.json({ ...outcome, _tag: "Refused", code: outcome.refusal.code, message: outcome.refusal.message }, 422);
    return c.json(outcome);
  });

  return stubRoutes(r, "routines", [
    "GET /v1/routines", "GET /v1/routines/:id", "GET /v1/routines/:id/runs", "GET /v1/routine-runs/:id", "POST /v1/routines/:id/trigger",
    "POST /v1/routines/draft", "POST /v1/routines/:id/enable", "POST /v1/routines/:id/disable", "POST /v1/routines/:id/autonomy",
  ]);
}
