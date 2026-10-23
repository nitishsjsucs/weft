// The Agent page and conversation threads (additive; README "The Agent page", SPEC 11.3). A person's conversation with
// the agent is a thread: every chat run started from the Agent page carries the same `thr_` id on agent_runs.thread_id,
// and a follow-up gets the thread's earlier turns (question and final answer only, bounded) in its context pack. The
// side panel keeps starting single runs with no thread. Types, constants and pure helpers only.
import type { AgentRunRow } from "../trace";

/** A thread id as the client mints it: `thr_` and 8 to 40 letters, digits, `_` or `-`. */
export const THREAD_ID_RE = /^thr_[A-Za-z0-9_-]{8,40}$/;
export const isThreadId = (v: unknown): v is string => typeof v === "string" && THREAD_ID_RE.test(v);

/** At most this many earlier turns reach a follow-up's context pack (the most recent ones). */
export const THREAD_PRIOR_TURNS = 3;
/** At most this many characters of earlier question and answer text in all (tags and labels not counted). */
export const THREAD_PRIOR_CHARS = 2_000;

/** GET /v1/agent/runs filters. `chat` and `thread_id` list the viewer's own conversations only (runs that acted for
 * them); `background` lists routine and notice runs (any trigger other than chat) under the usual run visibility. */
export const AGENT_RUN_TRIGGERS = ["chat", "background"] as const;
export type AgentRunTriggerFilter = (typeof AGENT_RUN_TRIGGERS)[number];

/** Where a chat run was asked: the app (Agent page, side panel, API or an MCP client), the employee portal, a chat
 * thread that tagged the agent, or the Routines page's draft box. Only `agent` runs are conversations on the page. */
export type AskedFrom = "agent" | "portal" | "mention" | "routine_draft";

/** A row of GET /v1/agent/runs filtered by `trigger=chat` or `thread_id`: the run plus the person's question (null when
 * the run never stored one, such as the seeded history) and where it was asked. Unfiltered lists keep AgentRunRow. */
export interface ConversationRunRow extends AgentRunRow { question: string | null; askedFrom: AskedFrom }

/** Test ids on the Agent page. */
export const AGENT_PAGE_TID = {
  page: "agent-page",
  newChat: "agent-page-new-chat",
  listToggle: "agent-page-list-toggle",
  list: "agent-page-list",
  threadsTab: "agent-page-tab-threads",
  backgroundTab: "agent-page-tab-background",
  thread: "agent-page-thread",
  threadsEmpty: "agent-page-threads-empty",
  background: "agent-page-background",
  backgroundEmpty: "agent-page-background-empty",
  title: "agent-page-title",
  model: "agent-page-model",
  cost: "agent-page-cost",
  turn: "agent-page-turn",
  question: "agent-page-question",
  start: "agent-page-start",
  composer: "agent-page-composer",
  send: "agent-page-send",
  composerNote: "agent-page-composer-note",
} as const;
