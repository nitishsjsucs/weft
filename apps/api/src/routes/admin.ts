// /v1 Reports screen, permissions screen and routine gallery routes (wave 4, docs/wave4.md). Owner: w4-parity-admin. Paths come from packages/contracts/src/api.ts.
// Every route answers 501 until the owner registers real handlers before stubRoutes and lists them in `except`.
//
// Reads go through the executor's human surface so the caller's grants and the redactor apply exactly as they do for
// the agent. Changes are proposals filed with executor.human.propose: emailing a report (comms.send_report) and a
// per-action agent override (settings.set_agent_action_override) both wait in the Inbox until a person approves.
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { Forbidden, Unauthorized, ValidationError, type HumanSession, type ToolOutcome } from "@weft/contracts";
import { REPORT_CATALOG } from "@weft/core";
import { principals } from "@weft/db";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { kick, redactJson } from "./proposals";
import { isRetiredRoutine } from "../../../../packages/contracts/src/ext/dp-agent-runtime";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dates are YYYY-MM-DD");
const SendBody = z.object({ from: Day, to: Day, groupBy: z.enum(["month", "quarter"]).optional(), recipients: z.array(z.string()).min(1).max(10) }).strict();
const OverrideBody = z.object({ principalId: z.string().min(1), command: z.string().min(1), mode: z.enum(["deny", "propose_only", "clear"]) }).strict();

function outcomeResponse(weft: Weft, outcome: ToolOutcome) {
  if (!outcome.ok) {
    const status = outcome.refusal.code === "NOT_PERMITTED" ? 403 : 422;
    return { status, body: redactJson(weft, { _tag: "Refused", code: outcome.refusal.code, message: outcome.refusal.message }) } as const;
  }
  return { status: 200, body: redactJson(weft, outcome) } as const;
}

/** A person's own gated call: the proposal path, so the change waits in the Inbox. */
async function propose(weft: Weft, s: HumanSession, command: string, args: unknown): Promise<ToolOutcome> {
  const human = weft.executor.human;
  if (!human.propose) throw new Forbidden("This executor cannot file proposals for a person");
  return human.propose(s, command, args);
}

async function body<T>(schema: z.ZodType<T>, raw: unknown): Promise<T> {
  const p = schema.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
  return p.data;
}

export function adminRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();

  /** The catalog: every metric with its label, unit and data domain, and whether this person may read it. */
  r.get("/v1/reports", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const [p] = await weft.db.select({ grantsJson: principals.grantsJson }).from(principals).where(eq(principals.id, s.principalId)).limit(1);
    let grants: Record<string, string> = {};
    try { grants = p ? JSON.parse(p.grantsJson) as Record<string, string> : {}; } catch { grants = {}; }
    return c.json(REPORT_CATALOG.map((m) => ({ ...m, allowed: !!grants[m.domain] && grants[m.domain] !== "none" })));
  });

  /** "Email this report": a comms.send_report proposal. Nothing is sent until a person approves it. */
  r.post("/v1/reports/:metric/send", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const metric = c.req.param("metric");
    if (!REPORT_CATALOG.some((m) => m.metric === metric)) throw new ValidationError(`metric is one of ${REPORT_CATALOG.map((m) => m.metric).join(", ")}`);
    const b = await body(SendBody, await c.req.json().catch(() => ({})));
    const outcome = await propose(weft, s, "comms.send_report", { metric, from: b.from, to: b.to, ...(b.groupBy ? { group_by: b.groupBy } : {}), recipients: b.recipients });
    await kick(weft);
    const out = outcomeResponse(weft, outcome);
    return c.json(out.body, out.status);
  });

  r.get("/v1/permissions/matrix", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const outcome = await weft.executor.human.exec(s, "settings.permission_matrix", {});
    if (!outcome.ok) { const out = outcomeResponse(weft, outcome); return c.json(out.body, out.status); }
    if (outcome.status !== "done") throw new ValidationError("settings.permission_matrix does not propose");
    // A retired routine (folded into another, never run) keeps its row but is no entry in the gallery.
    return c.json(redactJson(weft, (outcome.data as { rows: { routineId?: string }[] }).rows.filter((r) => !isRetiredRoutine(String(r.routineId ?? "")))));
  });

  /** A per-action override (deny, propose_only or clear) for one person or the agent: always a proposal. */
  r.post("/v1/permissions/agent-actions", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const b = await body(OverrideBody, await c.req.json().catch(() => ({})));
    const outcome = await propose(weft, s, "settings.set_agent_action_override", { principal_id: b.principalId, command: b.command, mode: b.mode });
    await kick(weft);
    const out = outcomeResponse(weft, outcome);
    return c.json(out.body, out.status);
  });

  /** The routine gallery: created by, enabled at, last and next run, and approval and override counts per routine. */
  r.get("/v1/routine-gallery", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    // The prebuilt rows are written on first use, as GET /v1/routines does through the engine's list().
    await (weft.routines as Partial<{ ensurePrebuilt(): Promise<void> }>).ensurePrebuilt?.();
    const outcome = await weft.executor.human.exec(s, "routines.gallery", {});
    if (!outcome.ok) { const out = outcomeResponse(weft, outcome); return c.json(out.body, out.status); }
    if (outcome.status !== "done") throw new ValidationError("routines.gallery does not propose");
    // A retired routine (folded into another, never run) keeps its row but is no entry in the gallery.
    return c.json(redactJson(weft, (outcome.data as { rows: { routineId?: string }[] }).rows.filter((r) => !isRetiredRoutine(String(r.routineId ?? "")))));
  });

  return stubRoutes(r, "admin", ["GET /v1/reports", "POST /v1/reports/:metric/send", "GET /v1/permissions/matrix", "POST /v1/permissions/agent-actions", "GET /v1/routine-gallery"]);
}
