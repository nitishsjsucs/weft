// Executor-owned commands (SPEC 9.2, T3): comms.post_update, actions.list, actions.get_run, agent.read_artifact.
// actions.list summaries are built from structured fields only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import type { Preview } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";
import { actions, execRuns, proposals, runArtifacts } from "@weft/db";
import type { Engine } from "./engine";

const base = {
  compactDescription: "", amountCents: null, ceilingKey: null, reversible: false as const, lease: null, sandbox: "hidden" as const,
  access: "all" as const, untrustedFields: [] as string[], afterPending: "run" as const, errorHints: {}, preview: null,
};
const fmt = z.enum(["concise", "detailed"]).optional();

export function builtinCommands(e: Engine): WeftCommand[] {
  const postUpdate: WeftCommand<{ text: string }> = {
    ...base, name: "comms.post_update", namespace: "comms", summary: "Post a short progress update to the run feed",
    description: "Post a one-line progress update to this run's feed in the Weft app (not to chat). Use it to tell the person what you are doing. Returns { posted: true }. Example: { \"text\": \"Drafted the reply; waiting for approval.\" }",
    compactDescription: "Post a progress line to the run feed.",
    input: z.object({ text: z.string().min(1).max(500) }), domain: "comms", needs: "view", effect: "draft", risk: () => "R1", approval: "never", autoAllow: "never",
    tiers: { main: "executable", task: "executable" }, mcp: "hidden",
    errorHints: { INVALID_INPUT: { hint: "text is one line, at most 500 characters", example: { text: "Checked the draft payroll." } } },
    async run(i, ctx) {
      // The text is not echoed back: a model-authored string must never become a grounding source for its own answer.
      return { data: { posted: true, run_id: ctx.run?.id ?? null }, summary: `Posted an update to the run feed${ctx.run ? ` of ${ctx.run.id}` : ""}` };
    },
  };

  const listActions: WeftCommand<{ limit?: number; before_seq?: number; run_id?: string; command?: string; response_format?: "concise" | "detailed" }> = {
    ...base, name: "actions.list", namespace: "actions", summary: "List recent actions from the audit log",
    description: "List recent actions from the hash-chained audit log, newest first: seq, time, actor, command, summary, proposal id. Filter by run_id or command. Use it to answer how something changed. Example: { \"limit\": 10, \"command\": \"tax.update_rate\" }",
    compactDescription: "List recent audit log actions.",
    input: z.object({ limit: z.number().int().min(1).max(50).optional(), before_seq: z.number().int().optional(), run_id: z.string().startsWith("run_").optional(), command: z.string().optional(), response_format: fmt }),
    domain: "company", needs: "view", effect: "read", risk: () => "R0", approval: "never", autoAllow: "never", tiers: { main: "executable", task: "executable" }, mcp: "read",
    sandbox: "read",
    errorHints: { INVALID_INPUT: { hint: "limit is 1 to 50", example: { limit: 10 } } },
    async run(i, _ctx, deps) {
      const conds = [];
      if (i.before_seq) conds.push(lt(actions.seq, i.before_seq));
      if (i.run_id) conds.push(eq(actions.agentRunId, i.run_id));
      if (i.command) conds.push(eq(actions.command, i.command));
      const rows = await deps.tx.select().from(actions).where(conds.length ? and(...conds) : undefined).orderBy(desc(actions.seq)).limit(i.limit ?? 20);
      const detailed = i.response_format === "detailed";
      const data = rows.map((r) => ({
        seq: r.seq, ts: r.ts, actor: `${r.actorKind}:${r.actorId}`, command: r.command, summary: r.summary, proposal_id: r.proposalId, result_id: r.resultId,
        reversible: r.reversible, reverses_seq: r.reversesSeq, ...(detailed ? { on_behalf_of: r.onBehalfOf, run_id: r.agentRunId, routine_run_id: r.routineRunId, hash: r.hash } : {}),
      }));
      return { data: { actions: data }, summary: `${data.length} actions${i.command ? ` for ${i.command}` : ""}` };
    },
  };

  const getRun: WeftCommand<{ run_id: string; response_format?: "concise" | "detailed" }> = {
    ...base, name: "actions.get_run", namespace: "actions", summary: "Show what one agent run did",
    description: "Show what one agent run did: its actions (seq, command, summary) and its proposals (id, status, headline). Use it to explain a run. Example: { \"run_id\": \"run_0003\" }",
    compactDescription: "Show one run's actions and proposals.",
    input: z.object({ run_id: z.string().startsWith("run_"), response_format: fmt }), domain: "company", needs: "view", effect: "read", risk: () => "R0",
    approval: "never", autoAllow: "never", tiers: { main: "executable", task: "executable" }, mcp: "read", sandbox: "read",
    errorHints: { UNKNOWN_REFERENCE: { hint: "use a run id from actions.list", example: { run_id: "run_0001" } } },
    async run(i, _ctx, deps) {
      const [run] = await deps.tx.select().from(execRuns).where(eq(execRuns.id, i.run_id)).limit(1);
      const acts = await deps.tx.select().from(actions).where(eq(actions.agentRunId, i.run_id)).orderBy(actions.seq);
      const props = await deps.tx.select().from(proposals).where(eq(proposals.proposerRunId, i.run_id)).orderBy(proposals.id);
      return {
        data: {
          run_id: i.run_id, kind: run?.agentKind ?? null, surface: run?.surface ?? null, attended: run?.attended ?? null, created_at: run?.createdAt ?? null,
          actions: acts.map((a) => ({ seq: a.seq, command: a.command, summary: a.summary, proposal_id: a.proposalId })),
          proposals: props.map((p) => ({ id: p.id, command: p.command, status: p.status, headline: p.headline, risk: p.risk, executed_action_seq: p.executedActionSeq })),
        },
        summary: `${i.run_id}: ${acts.length} actions, ${props.length} proposals`,
      };
    },
  };

  const readArtifact: WeftCommand<{ ref: string; offset?: number; limit?: number }> = {
    ...base, name: "agent.read_artifact", namespace: "agent", summary: "Page through a large tool result saved to the run workspace",
    description: "Page through a tool result that was too large to return inline (it came back with an artifact_ref). Returns up to 50 rows from offset. Example: { \"ref\": \"art_0001\", \"offset\": 10, \"limit\": 20 }",
    compactDescription: "Page a saved large result by artifact_ref.",
    input: z.object({ ref: z.string().startsWith("art_"), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional() }),
    domain: "company", needs: "view", effect: "read", risk: () => "R0", approval: "never", autoAllow: "never", tiers: { main: "executable", task: "executable" },
    mcp: "hidden",
    errorHints: { UNKNOWN_REFERENCE: { hint: "use the artifact_ref returned by the earlier call", example: { ref: "art_0001", offset: 0, limit: 20 } } },
    async run(i, ctx, deps) {
      if (!ctx.run) throw Object.assign(new Error("artifacts belong to agent runs"), { code: "NOT_PERMITTED" });
      const family = [ctx.run.id];
      const [me] = await deps.tx.select().from(execRuns).where(eq(execRuns.id, ctx.run.id)).limit(1);
      if (me?.parentRunId) family.push(me.parentRunId);
      for (const c of await deps.tx.select({ id: execRuns.id }).from(execRuns).where(eq(execRuns.parentRunId, ctx.run.id))) family.push(c.id);
      const [a] = await deps.tx.select().from(runArtifacts).where(and(eq(runArtifacts.id, i.ref), inArray(runArtifacts.runId, family))).limit(1);
      if (!a) throw Object.assign(new Error(`No artifact ${i.ref} in this run`), { code: "UNKNOWN_REFERENCE" });
      const json = JSON.parse(readFileSync(join(e.dataDir, a.path), "utf8")) as unknown;
      const rows = Array.isArray(json) ? json : json && typeof json === "object" ? (Object.values(json).find(Array.isArray) as unknown[] | undefined) ?? [json] : [json];
      const off = i.offset ?? 0, lim = i.limit ?? 50;
      const page = rows.slice(off, off + lim);
      const out = { data: { artifact_ref: a.id, offset: off, row_count: rows.length, rows: page, has_more: off + lim < rows.length }, summary: `${a.summary} (rows ${off + 1} to ${off + page.length} of ${rows.length})` };
      return a.taintedBy ? Object.assign(out, { taintedBy: `artifact:${a.id}` }) : out;
    },
  };
  return [postUpdate, listActions, getRun, readArtifact] as WeftCommand[];
}

export type { Preview };
