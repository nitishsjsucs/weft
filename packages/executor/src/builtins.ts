// Executor-owned commands (SPEC 9.2, T3): comms.post_update, actions.list, actions.get_run, agent.read_artifact,
// and code.run (wave 2, harness 3). actions.list summaries are built from structured fields only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_CODE_LIMITS, Refused, type Preview } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";
import { actions, execRuns, proposals, runArtifacts } from "@weft/db";
import type { Engine } from "./engine";
import { codeFiles } from "./sandbox/files";
import { sandboxCall } from "./sandbox/host";
import { artifactPage } from "./workspace";
import { sandboxFromEnv } from "./sandbox/select";

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

  const listActions: WeftCommand<{ limit?: number; before_seq?: number; agent_run_id?: string; command?: string; response_format?: "concise" | "detailed" }> = {
    ...base, name: "actions.list", namespace: "actions", summary: "List recent actions from the audit log",
    description: "List recent actions from the hash-chained audit log, newest first: seq, time, actor, command, summary, proposal id. limit is 1 to 50 (default 20). Filter by agent_run_id (an agent run, run_...; never a pay run) or an exact command name. Use it to answer how something changed. Example: { \"limit\": 10, \"command\": \"tax.update_rate\" }",
    compactDescription: "List recent audit log actions.",
    input: z.object({ limit: z.number().int().optional(), before_seq: z.number().int().optional(), agent_run_id: z.string().optional(), command: z.string().optional(), response_format: fmt }),
    domain: "company", needs: "view", effect: "read", risk: () => "R0", approval: "never", autoAllow: "never", tiers: { main: "executable", task: "executable" }, mcp: "read",
    sandbox: "read",
    errorHints: { INVALID_INPUT: { hint: "limit is 1 to 50; agent_run_id is an agent run id (run_...)", example: { limit: 10 } } },
    async run(i, _ctx, deps) {
      const runId = i.agent_run_id?.trim();
      if (runId && !runId.startsWith("run_")) {
        // Pay runs (pay_...) and agent runs (run_...) are different records; payroll.get_run reads a pay run and its approval.
        const pay = runId.startsWith("pay_");
        throw new Refused("INVALID_INPUT", `agent_run_id ${runId} is not an agent run id (run_...)`, {
          hint: pay ? "That is a pay run. Read it with payroll.get_run (approved_by, approved_at, totals); for its audit rows filter actions.list by command, such as payroll.submit_run." : "Pass an agent run id (run_...), or filter by command instead.",
          example: pay ? { command: "payroll.submit_run", limit: 10 } : { limit: 10 },
        });
      }
      if (i.command && !e.registry.def(i.command)) {
        const logged = (await deps.tx.selectDistinct({ c: actions.command }).from(actions)).map((r) => r.c);
        if (!logged.includes(i.command)) {
          const near = nearestNames(i.command, [...new Set([...e.registry.all().map((d) => d.name), ...logged])], new Set(logged));
          throw new Refused("UNKNOWN_REFERENCE", `No command named ${i.command}; nearest: ${near.join(", ") || "none"}`, {
            hint: "command is an exact registered name. Retry with one of the nearest names, or omit command to list the newest actions. Reads (get, list, search) are never in the audit log; their records answer from the read itself.",
            example: near[0] ? { command: near[0], limit: 10 } : { limit: 10 },
          });
        }
      }
      const limit = Math.min(Math.max(Math.trunc(i.limit ?? 20) || 20, 1), 50);
      const conds = [];
      if (i.before_seq) conds.push(lt(actions.seq, i.before_seq));
      if (runId) conds.push(eq(actions.agentRunId, runId));
      if (i.command) conds.push(eq(actions.command, i.command));
      const rows = await deps.tx.select().from(actions).where(conds.length ? and(...conds) : undefined).orderBy(desc(actions.seq)).limit(limit);
      const detailed = i.response_format === "detailed";
      const data = rows.map((r) => ({
        seq: r.seq, ts: r.ts, actor: `${r.actorKind}:${r.actorId}`, command: r.command, summary: r.summary, proposal_id: r.proposalId, result_id: r.resultId,
        reversible: r.reversible, reverses_seq: r.reversesSeq, ...(detailed ? { on_behalf_of: r.onBehalfOf, run_id: r.agentRunId, routine_run_id: r.routineRunId, hash: r.hash } : {}),
      }));
      const clamped = i.limit !== undefined && i.limit !== limit;
      return { data: { limit_applied: limit, ...(clamped ? { limit_note: `limit ${i.limit} is outside 1 to 50; used ${limit}` } : {}), actions: data }, summary: `${data.length} actions${i.command ? ` for ${i.command}` : ""}` };
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
    description: "Page through a tool result that was too large to return inline (it came back with an artifact_ref). Returns up to 50 rows from offset, fewer when the rows are large (next_offset says where to continue), with total and row_count. Example: { \"ref\": \"art_0001\", \"offset\": 10, \"limit\": 20 }",
    compactDescription: "Page a saved large result by artifact_ref.",
    input: z.object({ ref: z.string().startsWith("art_"), offset: z.number().int().optional(), limit: z.number().int().optional() }),
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
      const { data, summary } = artifactPage(a.id, a.summary, json, i.offset ?? 0, i.limit ?? 50);
      const out = { data, summary };
      return a.taintedBy ? Object.assign(out, { taintedBy: `artifact:${a.id}` }) : out;
    },
  };
  // code.run (harness 3): one short read-only script in QuickJS. On no wave 1 allowlist, hidden from MCP, refused
  // outside an agent run (people and API keys have no run), never callable from inside itself (sandbox hidden).
  // Off unless WEFT_SANDBOX=quickjs. Inner calls go through sandboxCall; the result's taint is the OR of theirs,
  // and a tainted result is wrapped as untrusted with the run nonce.
  const codeRun: WeftCommand<{ source: string; purpose: string; inputs_json?: string }> = {
    ...base, name: "code.run", namespace: "code", summary: "Run a short read-only script over many reads",
    description: "Run a short JavaScript async function body that reads with await weft.call(\"people__search\", args) and returns one JSON value (the data of each call is in .data). Read commands only. Limits: 2 s CPU, 25 calls, 64 KiB result. Example: { \"purpose\": \"count CA staff\", \"source\": \"const r = await weft.call('people__search', { state: 'CA' }); return r.data.people.length;\" }",
    compactDescription: "Run read-only JS: await weft.call(tool, args); return JSON.",
    input: z.object({ source: z.string().min(1).max(20_000), purpose: z.string().min(1).max(200), inputs_json: z.string().max(65_536).optional() }),
    domain: "company", needs: "view", effect: "read", risk: () => "R0", approval: "never", autoAllow: "never", tiers: { main: "executable", task: "executable" },
    mcp: "hidden", sandbox: "hidden",
    errorHints: {
      INVALID_INPUT: { hint: "source is the body of an async function that returns a value; inputs_json is optional JSON the script reads as inputs", example: { purpose: "count people", source: "const r = await weft.call('people__search', {}); return r.data.people.length;" } },
      SANDBOX_TIMEOUT: { hint: "do less work per run: fewer loops, fewer calls", example: null },
      CALL_BUDGET: { hint: "at most 25 weft.call calls and 256 KiB of results per run; filter in the call args", example: null },
    },
    async run(i, ctx, deps) {
      if (!ctx.run) throw Object.assign(new Error("code.run runs inside agent runs"), { code: "NOT_PERMITTED" });
      const s = sandboxFromEnv(process.env);
      if (!s.engine) throw Object.assign(new Error(s.reason), { code: "UNAVAILABLE" });
      let inputs: unknown = null;
      if (i.inputs_json !== undefined && i.inputs_json.trim()) {
        try { inputs = JSON.parse(i.inputs_json) as unknown; } catch { throw Object.assign(new Error("inputs_json is not valid JSON"), { code: "INVALID_INPUT" }); }
      }
      // Memory reads in the box are pinned to the commit at start (harness 3.3).
      let memoryAt = "";
      try { memoryAt = await e.memory.head(); } catch { /* no memory repo in this world */ }
      const files = codeFiles(e, ctx, i.source);
      const res = await s.engine.run({ language: "js", source: i.source, purpose: i.purpose, inputs }, DEFAULT_CODE_LIMITS, sandboxCall(e, deps.tx, ctx, { memoryAt }));
      files.writeOutput({ purpose: i.purpose, ok: res.ok, value: res.value, error: res.error, logs: res.logs, calls: res.calls, tainted: res.tainted, memory_at: memoryAt });
      // Resource failures are refusals the model can act on; a script error comes back as data so it can be fixed.
      if (res.error && res.error.code !== "SANDBOX_ERROR") throw Object.assign(new Error(res.error.message), { code: res.error.code });
      const data = { ok: res.ok, value: res.value, error: res.error, logs: res.logs, calls: res.calls, memory_at: memoryAt };
      const out = { data, summary: `Ran a script: ${res.calls.length} inner call${res.calls.length === 1 ? "" : "s"}, ${res.ok ? "ok" : "error"}` };
      return res.tainted ? Object.assign(out, { taintedBy: "sandbox:code.run", untrusted: ["value", "logs", "error"] }) : out;
    },
  };
  return [postUpdate, listActions, getRun, readArtifact, codeRun] as WeftCommand[];
}

/**
 * Command names closest to an unknown one. A namespace of at most `wholeNs` commands is listed whole (names with audit
 * rows first, so the retry can return something), since a guessed verb rarely shares letters with the real one
 * ("payroll.approve" for payroll.submit_run); otherwise the `max` nearest by shared words, then edit distance.
 */
export function nearestNames(name: string, names: readonly string[], logged: ReadonlySet<string> = new Set(), max = 6, wholeNs = 10): string[] {
  const q = name.toLowerCase();
  const nsOf = (n: string) => n.toLowerCase().split(".")[0] ?? "";
  const words = new Set(q.split(/[._\s]+/).filter(Boolean));
  const score = (n: string) => {
    const l = n.toLowerCase();
    const shared = l.split(/[._]+/).filter((w) => words.has(w) || [...words].some((x) => x.length >= 4 && (w.startsWith(x) || x.startsWith(w)))).length;
    return (logged.has(n) ? 50 : 0) + shared * 10 - editDistance(q, l) / 10;
  };
  const ranked = (list: string[]) => list.map((n) => [n, score(n)] as const).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([n]) => n);
  const pool = names.filter((n) => n !== name);
  const same = ranked(pool.filter((n) => nsOf(n) === nsOf(q)));
  const other = ranked(pool.filter((n) => nsOf(n) !== nsOf(q)));
  const take = same.length && same.length <= wholeNs ? same.length : max;
  return [...same, ...other].slice(0, Math.max(take, Math.min(max, same.length + other.length)));
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

export type { Preview };
