// The cursor assistant's run as the client reads it, the pure parts: which presentation effects of a run may be played
// (and when), which refusals the popover should say out loud, the request fitted under the API's byte cap, the long
// answer clipped for the popover, and the handoff run's steps as plain-words progress lines.
import type { ApprovalCardW3, Proposal, RunStepRow, RunTrace } from "@weft/contracts";
import { SCREEN_LIMITS, type AssistEffect, type AssistRunRequest, type AssistTraceExtras, type ScreenItem } from "../../../../../packages/contracts/src/ext/assist";
import { priorityOf } from "./screen-map-core";

/** What GET /v1/agent/runs/:id/trace returns for the cursor assistant: the trace plus cards and AssistTraceExtras. */
export type AssistTrace = RunTrace & Partial<AssistTraceExtras> & { cards?: ApprovalCardW3[]; proposals?: Proposal[] };

export interface PlayableEffect { n: number; tool: string; effect: AssistEffect }

const EFFECTS = new Set(["point", "navigate", "show", "say", "handoff", "steps"]);
const effectOf = (s: RunStepRow): AssistEffect | null => {
  const d = (s.result as { outcome?: { ok?: boolean; data?: unknown } } | null)?.outcome;
  const e = d?.ok ? (d.data as { effect?: unknown } | undefined) : undefined;
  return e && typeof e.effect === "string" && EFFECTS.has(e.effect) ? (e as AssistEffect) : null;
};
const isRepair = (s: RunStepRow) => s.kind === "notice" && (s.result as { notice?: unknown } | null)?.notice === "repair";
/** The loop's verdict on a batch's presentation words (loop.ts presentationText): grounded, withheld, or none yet. */
const markOf = (s: RunStepRow) => (s.kind === "verify" && s.stage === "post" ? (s.result as { presentation?: unknown } | null)?.presentation : undefined);

/**
 * The presentation effects the client may play, in step order: the accepted ui__* calls of each model step once that
 * step is settled (a later model call started, or the run finished) and the loop marked its words grounded (their
 * figures come from this run's results). It fails closed: a step with no mark, one marked withheld, or one the run
 * sent back for a repair is never played, so nothing it would have shown reaches the screen; the repaired step that
 * follows is.
 */
export function playableEffects(steps: readonly RunStepRow[], finished: boolean): PlayableEffect[] {
  const out: PlayableEffect[] = [];
  let group: PlayableEffect[] = [];
  let repaired = false;
  let grounded = false;
  let started = false;
  const close = (settled: boolean) => { if (settled && grounded && !repaired) out.push(...group); group = []; repaired = false; grounded = false; };
  for (const s of [...steps].sort((a, b) => a.n - b.n)) {
    if (s.kind === "model_call") { if (started) close(true); started = true; continue; }
    if (isRepair(s)) { repaired = true; continue; }
    if (markOf(s) !== undefined) { grounded = markOf(s) === "grounded"; continue; }
    if (s.kind !== "tool_call" || s.outcome !== "ok" || !(s.toolName ?? "").startsWith("ui__")) continue;
    const e = effectOf(s);
    if (e) group.push({ n: s.n, tool: s.toolName!, effect: e });
  }
  close(finished);
  return out;
}

/**
 * What the interaction trail records once an effect played ("The assistant showed Approvals"), or null for none. A
 * tainted run's labels are model words written after it read untrusted text, so its points and shows are recorded
 * without them: a later question never gets them back as the app's own words, as a thread drops a tainted turn.
 */
export function effectTrailLabel(e: AssistEffect, tainted: boolean): string | null {
  if (e.effect === "say" || e.effect === "handoff") return null;
  if (e.effect === "steps") return "The assistant started a walkthrough";
  // A route the executor validated (a page and the view state keys of its shape), not free text.
  if (e.effect === "navigate") return `The assistant opened ${e.route}`;
  const label = tainted ? null : e.label;
  return `The assistant showed ${label || "something"}`;
}

/** True when the run refused a show or a walkthrough on a control that changes data (the popover says so plainly). */
export function refusedChange(steps: readonly RunStepRow[]): boolean {
  return steps.some((s) => s.kind === "tool_call" && (s.toolName === "ui__show" || s.toolName === "ui__steps") && s.outcome === "refused:NOT_PERMITTED");
}

/**
 * The handoff run's work as plain-words lines (the agent panel's step summaries), reads and proposals alike; the
 * presentation calls are the assistant's own and are left out.
 */
export function progressSteps(steps: readonly RunStepRow[], summary: (s: RunStepRow) => string): { n: number; text: string; outcome: RunStepRow["outcome"] }[] {
  return steps.filter((s) => s.kind === "tool_call" && !(s.toolName ?? "").startsWith("ui__")).map((s) => ({ n: s.n, text: summary(s), outcome: s.outcome }));
}

export const bodyBytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/**
 * The request under the API's cap (SCREEN_LIMITS.bodyBytes): records go first, then the trail, then the hover trail,
 * then the screen map's lowest ranked items (marked truncated). Null when even the bare request does not fit.
 */
export function fitAssistRequest(req: AssistRunRequest, max: number = SCREEN_LIMITS.bodyBytes): AssistRunRequest | null {
  let r = req;
  if (bodyBytes(r) <= max) return r;
  const a = () => r.assist;
  for (const cut of [
    () => ({ ...a(), records: [] }),
    () => ({ ...a(), trail: [] }),
    () => ({ ...a(), cursor: { ...a().cursor, trail: [] } }),
  ]) {
    r = { ...r, assist: cut() };
    if (bodyBytes(r) <= max) return r;
  }
  const rank = (i: ScreenItem) => priorityOf({ ...i, key: 0 });
  // Lowest ranked first, and among equals the one furthest down the page.
  const order = [...r.assist.screen.items].sort((x, y) => rank(x) - rank(y) || y.box[1] - x.box[1]);
  let items = r.assist.screen.items;
  for (const drop of order) {
    items = items.filter((i) => i.n !== drop.n);
    r = { ...r, assist: { ...r.assist, screen: { ...r.assist.screen, items, truncated: true } } };
    if (bodyBytes(r) <= max) return r;
  }
  return bodyBytes(r) <= max ? r : null;
}

/**
 * A long answer cut for the popover at a sentence near `max` characters (Open in Agent has the rest), never inside a
 * citation chip.
 */
export function clipAnswer(text: string, max = 420): { text: string; clipped: boolean } {
  const t = text.trim();
  if (t.length <= max) return { text: t, clipped: false };
  let cut = t.slice(0, max);
  const open = cut.lastIndexOf("[");
  if (open > cut.lastIndexOf("]")) cut = cut.slice(0, open);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  const out = end > max * 0.4 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "");
  return { text: `${out.trim()}…`, clipped: true };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * A chip's words after "Show me": the record's own name, or for a record the read left unnamed, what its id says
 * ("the Oct 30 pay run" for pay_2026_10_30), so three chips never all read "Pay run".
 */
export function chipLabel(c: { id: string; label: string }): string {
  const l = c.label.trim();
  if (!/^(?:pay run|person|proposal|the proposal)$/i.test(l)) return l;
  const m = /^pay_\d{4}_(\d{2})_(\d{2})$/.exec(c.id);
  if (m && MONTHS[Number(m[1]) - 1]) return `the ${MONTHS[Number(m[1]) - 1]} ${Number(m[2])} pay run`;
  return /proposal/i.test(l) ? "the proposal" : l.toLowerCase() === "person" ? "this person" : l;
}

/**
 * The taint an approval card in the popover carries: the proposal's own, or for a card the run only showed (an
 * approval.card call, not a proposal it filed) the run's when the run read untrusted content, since that text may have
 * chosen which card to surface. A tainted card has no Approve; the person decides it in the Inbox with the full content.
 */
export function cardTaint(t: Pick<AssistTrace, "run" | "proposals">, proposalId: string): string | null {
  const p = t.proposals?.find((x) => x.id === proposalId);
  if (p?.taintedBy) return p.taintedBy;
  if (t.run.tainted && p?.proposerRunId !== t.run.id) return t.run.taintedBy ?? `run:${t.run.id}`;
  return null;
}
