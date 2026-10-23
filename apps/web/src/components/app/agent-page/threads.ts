// The Agent page's conversations, as plain data (no React): grouping chat runs into conversations, their titles and
// status dots, relative times on the simulated clock, the selection a URL names, and new thread ids. Unit tested in
// apps/web/test/agent-page.test.ts.
import type { AgentRunRow, RunStatus } from "@weft/contracts";
import type { ConversationRunRow } from "../../../../../../packages/contracts/src/ext/agent-page";
import { answerPlain } from "../agent/answer";
import { fmtDate } from "../format";

/** One conversation: a thread's runs, or a single run that has no thread (the seeded history, the side panel's runs). */
export interface Conversation {
  /** `thread:<thr_...>` or `run:<run id>`. */
  key: string;
  threadId: string | null;
  /** Oldest first. */
  runs: ConversationRunRow[];
  title: string;
  startedAt: string;
  lastAt: string;
  status: RunStatus;
}

export const TITLE_MAX = 72;

const byCreation = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.length - b.id.length || a.id.localeCompare(b.id);

/** A line of text cut at a word to `max` characters, with an ellipsis when cut. */
export function clipLine(text: string, max = TITLE_MAX): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/**
 * The conversation's title: its first question. A run that never stored its question (the seeded history) is titled
 * by the first sentence of its answer, and with neither by the day it ran.
 */
export function conversationTitle(runs: Pick<ConversationRunRow, "question" | "summary" | "createdAt">[]): string {
  const first = runs[0];
  if (!first) return "New conversation";
  const q = runs.find((r) => r.question?.trim())?.question;
  if (q) return clipLine(q.split("\n")[0]!);
  const answer = first.summary ? answerPlain(first.summary) : "";
  const sentence = answer.split(/(?<=[.!?])\s|:\s/)[0] ?? "";
  if (sentence.trim()) return clipLine(sentence.replace(/[.!?]$/, ""));
  return `Conversation of ${fmtDate(first.createdAt)}`;
}

/** Chat runs as conversations, newest activity first. Only runs asked from the app count: a portal question, a chat
 * thread that tagged the agent and a routine draft live on their own pages. */
export function groupConversations(rows: readonly ConversationRunRow[]): Conversation[] {
  const groups = new Map<string, ConversationRunRow[]>();
  for (const r of rows) {
    if (r.trigger !== "chat" || (r.askedFrom ?? "agent") !== "agent") continue;
    const key = r.threadId ? `thread:${r.threadId}` : `run:${r.id}`;
    const g = groups.get(key);
    if (g) { if (!g.some((x) => x.id === r.id)) g.push(r); } else groups.set(key, [r]);
  }
  const out: Conversation[] = [];
  for (const [key, runs] of groups) {
    runs.sort(byCreation);
    const last = runs[runs.length - 1]!;
    out.push({ key, threadId: runs[0]!.threadId, runs, title: conversationTitle(runs), startedAt: runs[0]!.createdAt, lastAt: last.createdAt, status: last.status });
  }
  return out.sort((a, b) => byCreation({ createdAt: b.lastAt, id: b.runs[b.runs.length - 1]!.id }, { createdAt: a.lastAt, id: a.runs[a.runs.length - 1]!.id }));
}

/** Background work: routine and notice runs (any trigger but chat), newest first. */
export function backgroundRuns<T extends Pick<AgentRunRow, "trigger" | "createdAt" | "id">>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.trigger !== "chat").sort((a, b) => byCreation(b, a));
}

export type DotTone = "working" | "waiting" | "done" | "problem" | "stopped";

/** The status dot of a run or a conversation (its latest run). */
export function statusDot(status: RunStatus | undefined): { tone: DotTone; label: string } {
  switch (status) {
    case "queued": case "running": case undefined: return { tone: "working", label: "Working" };
    case "waiting": return { tone: "waiting", label: "Waiting for approval" };
    case "held": return { tone: "waiting", label: "Held" };
    case "done": return { tone: "done", label: "Done" };
    case "cancelled": case "expired": return { tone: "stopped", label: status === "cancelled" ? "Cancelled" : "Expired" };
    default: return { tone: "problem", label: status === "refused" ? "Refused" : status === "escalated" ? "Needs a person" : "Failed" };
  }
}

export const isWorking = (s: RunStatus | undefined) => s === undefined || s === "queued" || s === "running";

/** "just now", "12m ago", "3h ago", "4d ago", then the date, against the simulated clock's now. */
export function ago(iso: string, nowIso: string): string {
  const ms = Date.parse(nowIso) - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return fmtDate(iso);
}

/** What the URL selects: a thread, a single run, or nothing (a new chat). */
export type Selection = { kind: "thread"; threadId: string } | { kind: "run"; runId: string } | { kind: "new" };

const THREAD_RE = /^thr_[A-Za-z0-9_-]{8,40}$/;
const RUN_RE = /^run_[A-Za-z0-9_]{1,40}$/;

export function selectionFromSearch(search: string): Selection {
  const q = new URLSearchParams(search);
  const t = q.get("thread");
  if (t && THREAD_RE.test(t)) return { kind: "thread", threadId: t };
  const r = q.get("run");
  if (r && RUN_RE.test(r)) return { kind: "run", runId: r };
  return { kind: "new" };
}

/** The URL for a selection, keeping the page's own path (the static export's trailing slash included). */
export function selectionHref(pathname: string, sel: Selection): string {
  if (sel.kind === "thread") return `${pathname}?thread=${encodeURIComponent(sel.threadId)}`;
  if (sel.kind === "run") return `${pathname}?run=${encodeURIComponent(sel.runId)}`;
  return pathname;
}

/** The conversation a selection names, if the list has it: a run selects its thread when it has one. */
export function findConversation(list: readonly Conversation[], sel: Selection): Conversation | null {
  if (sel.kind === "thread") return list.find((c) => c.threadId === sel.threadId) ?? null;
  if (sel.kind === "run") return list.find((c) => c.runs.some((r) => r.id === sel.runId)) ?? null;
  return null;
}

/** A new thread id: `thr_` and 20 random hex characters. */
export function newThreadId(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return `thr_${Array.from(random(new Uint8Array(10)), (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** The cost of a conversation, all turns, in micro dollars. */
export const conversationCost = (runs: readonly Pick<AgentRunRow, "costUsdMicros">[]) => runs.reduce((s, r) => s + (r.costUsdMicros ?? 0), 0);
