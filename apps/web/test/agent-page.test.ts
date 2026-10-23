// The Agent page's plain logic (components/app/agent-page/threads.ts) and its place in the shell: chat runs grouped
// into conversations (a thread's turns together, a run with no thread on its own, other surfaces left out), titles from
// the first question, status dots, relative times on the simulated clock, the selection a URL names, thread ids, the
// sidebar item after Inbox, the breadcrumb, and the side panel rule.
import { describe, expect, it } from "vitest";
import type { AgentRunRow, RunStatus } from "@weft/contracts";
import type { ConversationRunRow } from "../../../packages/contracts/src/ext/agent-page";
import {
  ago, backgroundRuns, clipLine, conversationCost, conversationTitle, findConversation, groupConversations, newThreadId, selectionFromSearch, selectionHref,
  statusDot,
} from "../src/components/app/agent-page/threads";
import { crumbs, NAV, navGroups } from "../src/components/app/nav";
import { isAgentPage } from "../src/components/app/shell/app-shell";

let n = 0;
function run(p: Partial<ConversationRunRow> & { at: string }): ConversationRunRow {
  n += 1;
  return {
    id: p.id ?? `run_${String(n).padStart(4, "0")}`, companyId: "cmp_larkspur", kind: "main", parentRunId: null, threadId: p.threadId ?? null, routineRunId: null,
    trigger: p.trigger ?? "chat", attended: true, provider: "scripted", model: "scripted", effort: "low", cacheKey: p.cacheKey ?? "weft:main:chat:cmp_larkspur",
    status: (p.status ?? "done") as RunStatus, terminalReason: null, tainted: false, taintedBy: null, checklist: null, budget: { steps: 12, usd: 0.1, minutes: 10 },
    stepsUsed: 1, requeues: 0, consecutiveErrors: 0, costUsdMicros: p.costUsdMicros ?? 0, tokens: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    createdAt: p.at, endedAt: p.at, summary: p.summary ?? "Done.", question: p.question === undefined ? "A question" : p.question, askedFrom: p.askedFrom ?? "agent",
  };
}

describe("groupConversations", () => {
  const rows = [
    run({ id: "run_0001", at: "2026-10-26T15:00:00.000Z", threadId: "thr_aaaaaaaaaa", question: "Show payroll cost by month" }),
    run({ id: "run_0003", at: "2026-10-26T15:10:00.000Z", threadId: "thr_aaaaaaaaaa", question: "And for September?", status: "running" }),
    run({ id: "run_0002", at: "2026-10-26T15:05:00.000Z", question: "Who starts next week?" }),
    run({ id: "run_0004", at: "2026-10-20T09:00:00.000Z", question: null, summary: "Payroll cost by month for 2026: January to August from the imported history." }),
    run({ id: "run_0005", at: "2026-10-26T15:20:00.000Z", askedFrom: "portal", question: "How much PTO do I have?" }),
    run({ id: "run_0006", at: "2026-10-26T15:21:00.000Z", askedFrom: "mention", question: "@weft status?" }),
    run({ id: "run_0007", at: "2026-10-26T15:22:00.000Z", askedFrom: "routine_draft", question: "Every Friday, post open approvals" }),
    run({ id: "run_0008", at: "2026-10-26T15:23:00.000Z", trigger: "routine:rtr_0001", question: null }),
  ];
  const list = groupConversations(rows);

  it("puts a thread's turns together, oldest first, and a run with no thread on its own", () => {
    expect(list.map((c) => c.key)).toEqual(["thread:thr_aaaaaaaaaa", "run:run_0002", "run:run_0004"]);
    expect(list[0]!.runs.map((r) => r.id)).toEqual(["run_0001", "run_0003"]);
    expect(list[0]!.threadId).toBe("thr_aaaaaaaaaa");
    expect(list[1]!.threadId).toBeNull();
  });

  it("orders by the latest turn and takes the status of the latest turn", () => {
    expect(list[0]!.lastAt).toBe("2026-10-26T15:10:00.000Z");
    expect(list[0]!.status).toBe("running");
    expect(list[1]!.status).toBe("done");
  });

  it("leaves out portal questions, chat mentions, routine drafts and background runs", () => {
    const ids = list.flatMap((c) => c.runs.map((r) => r.id));
    for (const id of ["run_0005", "run_0006", "run_0007", "run_0008"]) expect(ids).not.toContain(id);
  });

  it("titles a conversation by its first question, else by its first answer's opening sentence", () => {
    expect(list[0]!.title).toBe("Show payroll cost by month");
    expect(list[2]!.title).toBe("Payroll cost by month for 2026");
    expect(conversationTitle([{ question: null, summary: null, createdAt: "2026-10-20T16:00:00.000Z" }])).toBe("Conversation of Oct 20");
    expect(conversationTitle([])).toBe("New conversation");
    expect(clipLine("word ".repeat(40), 30).length).toBeLessThanOrEqual(30);
    expect(clipLine("word ".repeat(40), 30).endsWith("…")).toBe(true);
  });

  it("does not count a run twice when the thread read and the list both hold it", () => {
    const twice = groupConversations([...rows.slice(0, 2), rows[0]!]);
    expect(twice[0]!.runs).toHaveLength(2);
  });

  it("finds the conversation a URL selects, a run inside a thread included", () => {
    expect(findConversation(list, { kind: "thread", threadId: "thr_aaaaaaaaaa" })?.key).toBe("thread:thr_aaaaaaaaaa");
    expect(findConversation(list, { kind: "run", runId: "run_0003" })?.key).toBe("thread:thr_aaaaaaaaaa");
    expect(findConversation(list, { kind: "run", runId: "run_0002" })?.key).toBe("run:run_0002");
    expect(findConversation(list, { kind: "new" })).toBeNull();
    expect(conversationCost([{ costUsdMicros: 1200 }, { costUsdMicros: 800 }])).toBe(2000);
  });
});

describe("background work", () => {
  it("is every run but chat, newest first", () => {
    const rows = [
      { id: "run_0001", trigger: "routine:rtr_0001", createdAt: "2026-10-20T00:00:00.000Z" },
      { id: "run_0002", trigger: "chat", createdAt: "2026-10-21T00:00:00.000Z" },
      { id: "run_0003", trigger: "routine:rtr_0002", createdAt: "2026-10-22T00:00:00.000Z" },
    ] as Pick<AgentRunRow, "id" | "trigger" | "createdAt">[];
    expect(backgroundRuns(rows).map((r) => r.id)).toEqual(["run_0003", "run_0001"]);
  });
});

describe("status dots and times", () => {
  it("names every run status", () => {
    expect(statusDot("running")).toEqual({ tone: "working", label: "Working" });
    expect(statusDot("queued").tone).toBe("working");
    expect(statusDot("waiting")).toEqual({ tone: "waiting", label: "Waiting for approval" });
    expect(statusDot("done").tone).toBe("done");
    expect(statusDot("failed").tone).toBe("problem");
    expect(statusDot("refused").label).toBe("Refused");
    expect(statusDot("cancelled").tone).toBe("stopped");
  });

  it("reads times against the simulated clock", () => {
    const now = "2026-10-26T15:30:00.000Z";
    expect(ago("2026-10-26T15:29:40.000Z", now)).toBe("just now");
    expect(ago("2026-10-26T15:18:00.000Z", now)).toBe("12m ago");
    expect(ago("2026-10-26T12:30:00.000Z", now)).toBe("3h ago");
    expect(ago("2026-10-23T15:30:00.000Z", now)).toBe("3d ago");
    expect(ago("2026-10-06T15:30:00.000Z", now)).toBe("Oct 6");
  });
});

describe("selection in the URL", () => {
  it("reads ?thread= and ?run=, ignoring anything malformed", () => {
    expect(selectionFromSearch("?thread=thr_0123456789abcdef")).toEqual({ kind: "thread", threadId: "thr_0123456789abcdef" });
    expect(selectionFromSearch("?run=run_0042")).toEqual({ kind: "run", runId: "run_0042" });
    expect(selectionFromSearch("?thread=evil%3Cscript%3E")).toEqual({ kind: "new" });
    expect(selectionFromSearch("")).toEqual({ kind: "new" });
  });

  it("writes it back on the page's own path, the export's trailing slash included", () => {
    expect(selectionHref("/app/agent", { kind: "thread", threadId: "thr_0123456789abcdef" })).toBe("/app/agent?thread=thr_0123456789abcdef");
    expect(selectionHref("/app/agent/", { kind: "run", runId: "run_0042" })).toBe("/app/agent/?run=run_0042");
    expect(selectionHref("/app/agent/", { kind: "new" })).toBe("/app/agent/");
  });

  it("mints thread ids the API accepts", () => {
    const id = newThreadId();
    expect(id).toMatch(/^thr_[0-9a-f]{20}$/);
    expect(newThreadId()).not.toBe(id);
    expect(newThreadId((b) => b.fill(255))).toBe(`thr_${"ff".repeat(10)}`);
  });
});

describe("the shell", () => {
  it("lists Agent right after Inbox and keeps every other item and slug", () => {
    const main = NAV[0]!.items.map((i) => i.slug);
    expect(main).toEqual(["home", "inbox", "agent", "payroll", "people", "hiring", "offboarding"]);
    const agent = NAV[0]!.items[2]!;
    expect(agent).toMatchObject({ label: "Agent", href: "/app/agent" });
    expect(navGroups(true).flatMap((g) => g.items).map((i) => i.slug)).toContain("agent");
  });

  it("reads the breadcrumb Agent > conversation title", () => {
    expect(crumbs("/app/agent", "Off-cycle pay for Lena")).toEqual([{ label: "Agent", href: "/app/agent" }, { label: "Off-cycle pay for Lena" }]);
    expect(crumbs("/app/agent", null)).toEqual([{ label: "Agent", href: "/app/agent" }]);
    // Other list pages keep their one crumb whatever title is registered.
    expect(crumbs("/app/inbox", "Something")).toEqual([{ label: "Inbox", href: "/app/inbox" }]);
  });

  it("keeps the side panel closed by default on the Agent page only", () => {
    expect(isAgentPage("/app/agent")).toBe(true);
    expect(isAgentPage("/app/inbox")).toBe(false);
    expect(isAgentPage("/app/agents")).toBe(false);
  });
});
