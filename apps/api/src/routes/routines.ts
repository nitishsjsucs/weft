// /v1 routines routes. Owner: t4-agent. Paths from packages/contracts/src/api.ts.
// Reads come from the routines engine; draft runs the deterministic parser, then routines.draft as the human (the
// proposal notifier turns routine.drafted into a routine_enable proposal); enable and disable are UI-only human
// commands through the HumanExecutor. Every mutation calls scheduler.kick() before it answers.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { NotFound, Refused, Unauthorized, type RoutineDef, type RoutineRun } from "@weft/contracts";
// Relative on purpose: @weft/core exports only "." and its index is shared; the integrator may re-export it there.
import { parseRoutineDraft } from "../../../../packages/core/src/routines/draft-parser";
import type { WeftRoutinesEngine } from "@weft/routines";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";

const DraftBody = z.object({ prompt: z.string().min(1).max(400) });

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

  r.get("/v1/routines", async (c) => c.json(await engine.list()));

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
      const handle = await weft.executor.runs.openChatRun(s, { threadId: null, surface: "human_ui" });
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
      return c.json(outcome);
    });
  }

  return stubRoutes(r, "routines", [
    "GET /v1/routines", "GET /v1/routines/:id", "GET /v1/routines/:id/runs", "GET /v1/routine-runs/:id", "POST /v1/routines/:id/trigger",
    "POST /v1/routines/draft", "POST /v1/routines/:id/enable", "POST /v1/routines/:id/disable",
  ]);
}
