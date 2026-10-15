// Context pack recipes (harness 7.2, SPEC 9.6): input[1], rendered once per run and stored as a context step so
// replays are byte-identical. Budgets are enforced in code by an estimate of 4 characters per token. The pack is
// wrapped in <context n="<nonce>">; the scripted provider reads its <trigger>, <derived> and <request> blocks.
import { canonicalJson, escapeTagText } from "./canonical";

export const approxTokens = (s: string) => Math.ceil(s.length / 4);

export interface RunLimits { steps: number; toolCallsPerStep: number; usd: number; minutes: number }
export interface OpenLoop { id: string; title: string; owner: string; due: string | null }

function limitsLine(l: RunLimits): string {
  return `limits: ${l.steps} model steps, ${l.toolCallsPerStep} tool calls per step, $${l.usd.toFixed(2)} per run, ${l.minutes} minutes`;
}

function clip(text: string, maxTokens: number): string {
  if (approxTokens(text) <= maxTokens) return text;
  return text.slice(0, maxTokens * 4 - 20) + " [truncated]";
}

export interface RoutinePackInput {
  nonce: string; now: string; actingFor: string; limits: RunLimits;
  routine: { id: string; name: string; instructions: string };
  trigger: Record<string, unknown>;
  precheck: { severity: string; findings: unknown; derivedArgs: Record<string, unknown> | null };
  checklist: { id: string; label: string }[];
}

export const ROUTINE_BUDGET_TOKENS = 1500;

export function routinePack(p: RoutinePackInput): string {
  const head = [
    `now: ${p.now}`,
    `acting_for: ${p.actingFor}`,
    limitsLine(p.limits),
    `routine: ${p.routine.id} (${escapeTagText(p.routine.name)})`,
    `<instructions>${escapeTagText(p.routine.instructions)}</instructions>`,
    `<trigger>${canonicalJson(p.trigger)}</trigger>`,
    `<derived>${canonicalJson(p.precheck.derivedArgs ?? {})}</derived>`,
    `<checklist>\n${p.checklist.map((c) => `- [ ] ${escapeTagText(c.label)}`).join("\n")}\n</checklist>`,
  ].join("\n");
  const room = Math.max(200, ROUTINE_BUDGET_TOKENS - approxTokens(head) - 20);
  const findings = clip(canonicalJson(p.precheck.findings ?? null), room);
  return `<context n="${p.nonce}">\n${head}\n<findings severity="${p.precheck.severity}">${findings}</findings>\n</context>`;
}

export interface ChatPackInput {
  nonce: string; now: string; actingFor: string; grants: Record<string, string>;
  companySummary: string; openLoops: OpenLoop[]; request: string; pageContext: string | null;
}

export const CHAT_BUDGET_TOKENS = 4000;

export function chatPack(p: ChatPackInput): string {
  const grants = Object.keys(p.grants).sort().map((k) => `${k}=${p.grants[k]}`).join(", ") || "none";
  const fixed = [
    `now: ${p.now}`,
    `acting_for: ${p.actingFor}`,
    `grants: ${grants}`,
    p.pageContext ? `page: ${escapeTagText(p.pageContext)}` : null,
  ].filter(Boolean).join("\n");
  const request = `<request>${escapeTagText(p.request)}</request>`;
  // Overflow drops open-loop rows beyond 20, then truncates the company summary; never the request.
  const loops = p.openLoops.slice(0, 20).map((l) => `${l.id} | ${escapeTagText(l.title)} | ${l.owner} | ${l.due ?? "none"}`);
  const loopsBlock = `<open_loops>\nid | title | owner | due\n${loops.join("\n")}\n</open_loops>`;
  const room = Math.max(100, CHAT_BUDGET_TOKENS - approxTokens(fixed) - approxTokens(request) - approxTokens(loopsBlock) - 30);
  const summary = `<company>${clip(escapeTagText(p.companySummary), room)}</company>`;
  return `<context n="${p.nonce}">\n${fixed}\n${summary}\n${loopsBlock}\n${request}\n</context>`;
}

export interface DraftPackInput { nonce: string; now: string; actingFor: string; request: string; channels: string[]; tools: string[] }

export function routineDraftPack(p: DraftPackInput): string {
  return [
    `<context n="${p.nonce}">`,
    `now: ${p.now}`,
    `acting_for: ${p.actingFor}`,
    `channels: ${[...p.channels].sort().join(", ")}`,
    `tools: ${[...p.tools].sort().join(", ")}`,
    `<request>${escapeTagText(p.request)}</request>`,
    `</context>`,
  ].join("\n");
}
