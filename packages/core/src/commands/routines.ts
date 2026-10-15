// routines.* commands. Owner: t4-agent. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
// list and runs are reads; draft (R1) validates the cron with croner, takes tools only from the main-tier enum (at
// most 8), inserts a disabled custom routine and emits routine.drafted, which the proposal notifier turns into a
// routine_enable proposal; enable and disable are human_only (never tools).
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ChatChannel, Refused } from "@weft/contracts";
import { routineRuns, routines } from "@weft/db";
import type { WeftCommand } from "../shared/deps";
import { DRAFT_TZ, validateCron } from "../routines/draft-parser";

/** Main-tier registry names a custom routine may use (harness 5.3: an enum, at most 8 per routine). */
export const MAIN_TIER_TOOLS = [
  "people.search", "people.get", "payroll.list_runs", "payroll.get_run", "tax.get_rates", "tax.list_registrations", "notices.list", "notices.get",
  "actions.list", "actions.get_run", "memory.search", "memory.read", "comms.send_message", "comms.post_update", "onboarding.get_checklist",
] as const;

const fmt = z.enum(["concise", "detailed"]).optional();
const common = {
  namespace: "routines" as const, domain: "company" as const, autoAllow: "never" as const, amountCents: null, ceilingKey: null, lease: null,
  sandbox: "hidden" as const, untrustedFields: [] as string[], preview: null, reversible: false as const,
};

const list: WeftCommand<{ response_format?: "concise" | "detailed" }> = {
  ...common, name: "routines.list", summary: "List routines",
  description: "List the company's routines with trigger, enabled state and tools. Call it before drafting a routine to avoid duplicates. Example: {\"response_format\":null}",
  compactDescription: "List routines.", input: z.object({ response_format: fmt }), needs: "view", effect: "read", risk: () => "R0", approval: "never",
  tiers: { main: "executable", task: "unavailable" }, mcp: "read", access: "all", afterPending: "run", errorHints: {},
  async run(_i, ctx, deps) {
    const rows = await deps.tx.select().from(routines).where(eq(routines.companyId, ctx.companyId)).orderBy(asc(routines.id));
    const data = rows.map((r) => ({ id: r.id, name: r.name, enabled: Boolean(r.enabled), source: r.source, trigger: JSON.parse(r.triggerJson), tools: JSON.parse(r.toolsJson) }));
    return { data: { routines: data }, summary: `Listed ${data.length} routines` };
  },
};

const runs: WeftCommand<{ routine_id: string; limit?: number; response_format?: "concise" | "detailed" }> = {
  ...common, name: "routines.runs", summary: "List a routine's runs",
  description: "List recent runs of one routine: trigger, status, summary, what is left for a person and cost. Example: {\"routine_id\":\"rt_people_digest\",\"limit\":null,\"response_format\":null}",
  compactDescription: "List routine runs.", input: z.object({ routine_id: z.string(), limit: z.number().int().optional(), response_format: fmt }), needs: "view", effect: "read",
  risk: () => "R0", approval: "never", tiers: { main: "executable", task: "unavailable" }, mcp: "read", access: "all", afterPending: "run", errorHints: {},
  async run(i, _ctx, deps) {
    const rows = await deps.tx.select().from(routineRuns).where(eq(routineRuns.routineId, i.routine_id)).orderBy(desc(routineRuns.startedAt)).limit(Math.min(50, Math.max(1, i.limit ?? 10)));
    const data = rows.map((r) => ({ id: r.id, trigger_ref: r.triggerRef, status: r.status, summary: r.summary, left_for_human: JSON.parse(r.leftForHumanJson), cost_usd_micros: r.costUsdMicros, started_at: r.startedAt, ended_at: r.endedAt }));
    return { data: { runs: data }, summary: `Listed ${data.length} runs of ${i.routine_id}` };
  },
};

const draftInput = z.object({
  name: z.string().min(1).max(80),
  cron: z.string(),
  tz: z.string().optional(),
  channel: ChatChannel,
  tools: z.array(z.enum(MAIN_TIER_TOOLS)).min(1).max(8),
  instructions: z.string().min(1).max(600),
  precheck: z.enum(["open_approvals"]).optional(),
});
type DraftInput = z.infer<typeof draftInput>;

const draft: WeftCommand<DraftInput, { routine_id: string; enabled: false }> = {
  ...common, name: "routines.draft", summary: "Draft a routine (created disabled)",
  description: "Create a disabled custom routine from a cron schedule, a channel and up to 8 tools. A person enables it from the inbox. Example: {\"name\":\"Fridays: open approvals\",\"cron\":\"0 9 * * 5\",\"tz\":null,\"channel\":\"#payroll\",\"tools\":[\"comms.send_message\"],\"instructions\":\"Post open approvals.\",\"precheck\":\"open_approvals\"}",
  compactDescription: "Draft a disabled routine.", input: draftInput, needs: "edit", effect: "draft", risk: () => "R1", approval: "never",
  tiers: { main: "executable", task: "unavailable" }, mcp: "hidden", access: "all", afterPending: "run",
  errorHints: {
    INVALID_INPUT: { hint: "Use a 5-field cron in America/Los_Angeles; every Friday at 9:00 is 0 9 * * 5. Tools come from the main-tier enum, at most 8.", example: { cron: "0 9 * * 5", tools: ["comms.send_message"] } },
    TAINTED_WRITE: { hint: "This run read untrusted content, so it cannot draft routines. Ask a person to draft it from the routines page.", example: null },
  },
  async run(i, ctx, deps) {
    if (ctx.tainted) throw new Refused("TAINTED_WRITE", "A tainted run cannot draft routines.");
    const tz = i.tz ?? DRAFT_TZ;
    const v = validateCron(i.cron, tz);
    if (!v.ok) throw new Refused("INVALID_INPUT", `The cron "${i.cron}" is not valid: ${v.message}`, { hint: "Every Friday at 9:00 is 0 9 * * 5." });
    const id = await deps.newId("rt_");
    const by = ctx.principal.id;
    await deps.tx.insert(routines).values({
      id, companyId: ctx.companyId, name: i.name, description: i.instructions, ownerPrincipalId: ctx.onBehalfOf ?? by, enabled: false, autonomy: "approve",
      triggerJson: JSON.stringify({ type: "cron", cron: i.cron, tz }), filterJson: JSON.stringify({ channel: i.channel }), instructions: i.instructions,
      toolsJson: JSON.stringify(i.tools), precheck: i.precheck ?? "open_approvals",
      checklistJson: JSON.stringify([{ id: "posted", label: `post in ${i.channel}`, check: `posted:${i.channel}:{slot}` }]),
      budgetJson: JSON.stringify({ steps: 6, usd: 0.1, minutes: 10 }), surfaceJson: JSON.stringify({ worthSurfacing: true, channel: i.channel }),
      source: "custom", taintedBy: null, createdAt: deps.clock.now(),
    });
    return { data: { routine_id: id, enabled: false }, summary: `Drafted ${i.name} (${id}), disabled until a person enables it`, events: [{ type: "routine.drafted", subjectRef: id, payload: { routine_id: id } }] };
  },
};

function toggle(enabled: boolean): WeftCommand<{ routine_id: string }> {
  return {
    ...common, name: enabled ? "routines.enable" : "routines.disable", summary: enabled ? "Enable a routine" : "Disable a routine",
    description: `${enabled ? "Enable" : "Disable"} a routine. Human only.`, compactDescription: enabled ? "Enable a routine." : "Disable a routine.",
    input: z.object({ routine_id: z.string() }), needs: "approve", effect: "write", risk: () => "R2", approval: "never",
    tiers: { main: "unavailable", task: "unavailable" }, mcp: "hidden", access: "human_only", afterPending: "run", errorHints: {},
    async run(i, ctx, deps) {
      const rows = await deps.tx.select({ id: routines.id }).from(routines).where(eq(routines.id, i.routine_id));
      if (!rows.length) throw new Refused("UNKNOWN_REFERENCE", `No routine ${i.routine_id}.`);
      await deps.tx.update(routines).set({ enabled }).where(eq(routines.id, i.routine_id));
      return { data: { routine_id: i.routine_id, enabled }, summary: `${enabled ? "Enabled" : "Disabled"} ${i.routine_id}`, reverseArgs: { routine_id: i.routine_id }, events: [{ type: enabled ? "routine.enabled" : "routine.disabled", subjectRef: i.routine_id, payload: { routine_id: i.routine_id } }] };
    },
  };
}

export const routinesCommands: WeftCommand[] = [list, runs, draft, toggle(true), toggle(false)];
