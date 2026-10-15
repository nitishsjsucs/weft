// Scripted provider (harness 11.5, SPEC 9.1): replays scenarios/<name>.json. Stateless: the step index is the number
// of model items already in the history, so a requeued run continues where it stopped. Tools execute live through the
// executor; a failed `expect` throws a readable diff. Usage is synthetic (chars / 4) so cost and ledger code runs in CI
// with $0 settled.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryItem, ModelProvider, ModelStepRequest, ModelStepResult, Usage } from "@weft/contracts";

export type ScriptOutput = { type: "text"; text: string } | { type: "function_call"; name: string; arguments: unknown };
export interface ScriptStep {
  expect?: { lastResults: { tool: string; ok?: boolean; status?: string; code?: string }[] };
  output: ScriptOutput[];
  stop?: "tool_calls" | "final" | "refusal" | "incomplete";
}
export interface Script { match?: string; agents: Record<string, ScriptStep[]> }

export interface ScriptedProviderOptions {
  scriptsDir: string;
  /** Inline scripts by name; they win over files of the same name. */
  scripts?: Record<string, Script>;
  /** Force a script for every run (tests); otherwise routines use <routineId>.json and chat uses `match`. */
  scenario?: string;
}

export const SCRIPTED_LABEL = "Scripted, no model";

export class ScriptExpectationError extends Error {
  readonly code = "SCRIPT_EXPECT";
}

interface Parsed { trigger: Record<string, unknown>; derived: Record<string, unknown>; request: string }

function tagJson(text: string, tag: string): Record<string, unknown> {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  if (!m) return {};
  try {
    const v = JSON.parse(m[1]!) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The context pack renders <trigger>, <derived> and <request> blocks (context.ts); the scripted provider reads them. */
export function parseContext(history: HistoryItem[]): Parsed {
  const ctx = history.find((h) => h.kind === "context");
  const text = ctx && ctx.kind === "context" ? ctx.text : "";
  const req = /<request>([\s\S]*?)<\/request>/.exec(text);
  return { trigger: tagJson(text, "trigger"), derived: tagJson(text, "derived"), request: req ? req[1]!.trim() : "" };
}

/** Path lookup that tolerates dotted keys: derived["tax.update_rate"].rate resolves from "tax.update_rate.rate". */
export function lookup(root: unknown, path: string[]): unknown {
  if (path.length === 0) return root;
  if (root === null || typeof root !== "object") return undefined;
  for (let i = path.length; i >= 1; i--) {
    const key = path.slice(0, i).join(".");
    const obj = root as Record<string, unknown>;
    if (Array.isArray(root) && /^\d+$/.test(key)) return lookup((root as unknown[])[Number(key)], path.slice(i));
    if (Object.prototype.hasOwnProperty.call(obj, key)) return lookup(obj[key], path.slice(i));
  }
  return undefined;
}

function lastOutputs(history: HistoryItem[]): { name: string; value: unknown }[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.kind === "tool_outputs") return h.outputs.map((o) => ({ name: o.name, value: safeParse(o.output) }));
  }
  return [];
}

function lastByWire(history: HistoryItem[], wire: string): unknown {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.kind !== "tool_outputs") continue;
    for (let j = h.outputs.length - 1; j >= 0; j--) if (h.outputs[j]!.name === wire) return safeParse(h.outputs[j]!.output);
  }
  return undefined;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

const TEMPLATE = /\{\{\s*(trigger|derived|last)\.([A-Za-z0-9_.\-]+)\s*\}\}/g;

/** Template every string in `v`. A string that is exactly one placeholder takes the raw value (objects included). */
export function applyTemplates(v: unknown, scope: { trigger: unknown; derived: unknown; history: HistoryItem[] }): unknown {
  const resolve = (src: string, path: string): unknown => {
    const parts = path.split(".");
    if (src === "trigger") return lookup(scope.trigger, parts);
    if (src === "derived") return lookup(scope.derived, parts);
    const [wire, ...rest] = parts;
    return lookup(lastByWire(scope.history, wire!), rest);
  };
  if (typeof v === "string") {
    const whole = /^\{\{\s*(trigger|derived|last)\.([A-Za-z0-9_.\-]+)\s*\}\}$/.exec(v);
    if (whole) {
      const r = resolve(whole[1]!, whole[2]!);
      if (r === undefined) throw new ScriptExpectationError(`script template ${v} resolved to nothing`);
      return r;
    }
    return v.replace(TEMPLATE, (m, src: string, path: string) => {
      const r = resolve(src, path);
      if (r === undefined) throw new ScriptExpectationError(`script template ${m} resolved to nothing`);
      return typeof r === "string" ? r : JSON.stringify(r);
    });
  }
  if (Array.isArray(v)) return v.map((x) => applyTemplates(x, scope));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, applyTemplates(x, scope)]));
  return v;
}

function checkExpect(step: ScriptStep, history: HistoryItem[], where: string) {
  if (!step.expect) return;
  const got = lastOutputs(history).map((o) => {
    const v = (o.value ?? {}) as { ok?: boolean; status?: string; refusal?: { code?: string } };
    return { tool: o.name, ok: v.ok, status: v.status, code: v.refusal?.code };
  });
  const want = step.expect.lastResults;
  const lines: string[] = [];
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    const w = want[i];
    const g = got[i];
    if (!w) continue;
    const bad = !g || g.tool !== w.tool || (w.ok !== undefined && g.ok !== w.ok) || (w.status !== undefined && g.status !== w.status) || (w.code !== undefined && g.code !== w.code);
    if (bad) lines.push(`  [${i}] want ${JSON.stringify(w)}\n      got  ${JSON.stringify(g ?? null)}`);
  }
  if (lines.length) throw new ScriptExpectationError(`scripted expect failed at ${where}:\n${lines.join("\n")}`);
}

function chars(req: ModelStepRequest): { prefix: number; total: number } {
  const prefix = req.frozenPrompt.length + JSON.stringify(req.tools).length;
  const rest = req.history.reduce((n, h) => n + JSON.stringify(h).length, 0);
  return { prefix, total: prefix + rest };
}

function synthUsage(req: ModelStepRequest, outputChars: number, stepIndex: number): Usage {
  const c = chars(req);
  const input = Math.ceil(c.total / 4);
  return { input, cached: stepIndex > 0 ? Math.min(input, Math.floor(c.prefix / 4)) : 0, cacheWrite: 0, output: Math.ceil(outputChars / 4), reasoning: 0 };
}

export function scriptedProvider(opts: ScriptedProviderOptions): ModelProvider {
  const cache = new Map<string, Script | null>();
  const load = (name: string): Script | null => {
    if (opts.scripts?.[name]) return opts.scripts[name]!;
    if (cache.has(name)) return cache.get(name)!;
    const file = join(opts.scriptsDir, `${name}.json`);
    const s = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Script) : null;
    cache.set(name, s);
    return s;
  };
  const allNames = (): string[] => {
    const names = new Set(Object.keys(opts.scripts ?? {}));
    try { for (const f of readdirSync(opts.scriptsDir)) if (f.endsWith(".json")) names.add(f.slice(0, -5)); } catch { /* no dir */ }
    return [...names].sort();
  };

  function pick(req: ModelStepRequest, parsed: Parsed): string | null {
    if (opts.scenario) return opts.scenario;
    const routine = req.cacheKey.split(":")[2] ?? "chat";
    if (routine !== "chat" && load(routine)) return routine;
    for (const name of allNames()) {
      const s = load(name);
      if (s?.match && new RegExp(s.match, "i").test(parsed.request)) return name;
    }
    return null;
  }

  return {
    id: "scripted",
    model: "scripted",
    label: SCRIPTED_LABEL,
    live: false,
    async step(req): Promise<ModelStepResult> {
      const parsed = parseContext(req.history);
      const stepIndex = req.history.filter((h) => h.kind === "model").length;
      const name = pick(req, parsed);
      const agent = req.agentKind === "main" ? "main" : req.agentKind.slice(5);
      const steps = name ? load(name)?.agents[agent] : undefined;
      const step = steps?.[stepIndex];
      if (!name || !steps || !step) {
        const text = name && steps
          ? `${SCRIPTED_LABEL}: the script ${name} has no step ${stepIndex + 1}.`
          : `${SCRIPTED_LABEL}: no script matches this request, so there is no answer to show.`;
        return { stop: "final", text, toolCalls: [], native: { scripted: true, scenario: name, step: stepIndex, output: [{ type: "text", text }] }, usage: synthUsage(req, text.length, stepIndex), servedBy: "scripted", requestId: null };
      }
      checkExpect(step, req.history, `${name}.${agent}[${stepIndex}]`);
      const priorCalls = req.history.reduce((n, h) => n + (h.kind === "model" ? ((h.native as { calls?: number })?.calls ?? 0) : 0), 0);
      const scope = { trigger: parsed.trigger, derived: parsed.derived, history: req.history };
      let text = "";
      const toolCalls: ModelStepResult["toolCalls"] = [];
      for (const o of step.output) {
        if (o.type === "text") text += applyTemplates(o.text, scope) as string;
        else {
          const args = applyTemplates(o.arguments, scope);
          toolCalls.push({ callId: `call_${name}_${agent}_${priorCalls + toolCalls.length + 1}`, name: o.name, argumentsJson: typeof args === "string" ? args : JSON.stringify(args ?? {}) });
        }
      }
      const stop = step.stop ?? (toolCalls.length ? "tool_calls" : "final");
      const native = { scripted: true, scenario: name, step: stepIndex, calls: toolCalls.length, text, toolCalls };
      const usage = synthUsage(req, text.length + toolCalls.reduce((n, c) => n + c.argumentsJson.length + c.name.length, 0), stepIndex);
      const base = { native, usage, servedBy: "scripted", requestId: null };
      if (stop === "refusal") return { ...base, stop, text, toolCalls: [], refusal: { text, category: null } };
      if (stop === "incomplete") return { ...base, stop, text: "", toolCalls: [], error: { code: "PROVIDER_UNAVAILABLE", message: "incomplete: max_output_tokens", retryable: true } };
      return { ...base, stop: toolCalls.length ? "tool_calls" : "final", text, toolCalls };
    },
  };
}
