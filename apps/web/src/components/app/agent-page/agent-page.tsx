"use client";
// The Agent page (/app/agent): the agent at full width. Left, a New chat button, the person's conversations (threads,
// newest first, titled by their first question) and Background work (routine and notice runs with their summaries).
// Right, the selected conversation with the side panel's own parts (RunFeed: tool steps, charts, approval cards, the
// grounded answer and Open run), a header with the latest run's model and the conversation's cost, and a composer.
// The selection lives in the query (?thread=thr_... or ?run=run_...), so the same page works from the static export's
// one prerendered file. Lists poll through useGet (the hosted poll scheduler and change feed); runs stream through
// RunFeed's watchRun (SSE, with the hosted trace fallback).
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUp, BotMessageSquare, PanelLeftOpen, SquarePen, X } from "lucide-react";
import { Badge, Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@weft/ui/components";
import { cn } from "@weft/ui";
import type { AgentRunRow } from "@weft/contracts";
import { AGENT_PAGE_NEW_CHAT_EVENT, AGENT_PAGE_TID as T, type ConversationRunRow } from "../../../../../../packages/contracts/src/ext/agent-page";
import { client, errorText, invalidate, useGet, useSimClock } from "@/lib/api/hooks";
import { HOSTED } from "@/lib/hosted/flags";
import { oneOf, URL_STATE_EVENT, useUrlState } from "@/lib/url-state";
import { PAGE_TABS } from "../../../../../../packages/contracts/src/ext/assist";
import { appendDictation, DictateButton } from "../../hosted/dictate-button";
import { RunFeed } from "../agent/run-feed";
import { PanelStart } from "../agent/panel-start";
import { routineIdOf } from "../agent/follow";
import { CrumbLabel } from "../shell/crumbs";
import { providerLabel } from "../runs/run-view";
import { routineSummaryText } from "../copy";
import { fmtDateTime, usd } from "../format";
import {
  ago, backgroundRuns, conversationCost, conversationTitle, findConversation, groupConversations, isWorking, newThreadId, selectionFromSearch,
  selectionHref, statusDot, type Conversation, type DotTone, type Selection,
} from "./threads";

const PAGE_PATH = "/app/agent";
type Page<R> = { data?: R[] } | undefined;
interface PendingTurn { threadId: string; runId: string; question: string; createdAt: string }

const DOT: Record<DotTone, string> = {
  working: "bg-blue-9 motion-safe:animate-pulse",
  waiting: "bg-amber-9",
  done: "bg-green-9",
  problem: "bg-red-9",
  stopped: "bg-gray-8",
};
function Dot({ status }: { status: AgentRunRow["status"] | undefined }) {
  const d = statusDot(status);
  return <span role="img" aria-label={d.label} title={d.label} data-tone={d.tone} className={cn("inline-block size-2 shrink-0 rounded-full", DOT[d.tone])} />;
}

/** A link that selects in place on a plain click and still opens a new tab on a modified one. */
function SelectLink({ href, onSelect, className, children, ...rest }: { href: string; onSelect: () => void; className?: string; children: ReactNode; "data-testid"?: string; "data-key"?: string; "aria-current"?: "page" | undefined }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onSelect();
  };
  return <a href={href} onClick={onClick} className={className} {...rest}>{children}</a>;
}

function ConversationList({ conversations, background, routineNames, selectedKey, now, base, loading, onSelect, onNewChat, onClose }: {
  conversations: Conversation[]; background: AgentRunRow[]; routineNames: Map<string, string>; selectedKey: string | null; now: string; base: string; loading: boolean;
  onSelect: (sel: Selection) => void; onNewChat: () => void; onClose?: () => void;
}) {
  // The list's tab is in the link (?tab=background; Conversations when absent), beside the selected thread or run.
  const [tabParam, setTabParam] = useUrlState("tab", oneOf(PAGE_TABS.agent));
  const tab = tabParam ?? "threads";
  return (
    <div data-testid={T.list} className="flex h-full min-h-0 w-full flex-col">
      <div className="flex items-center gap-1.5 px-3 pt-3 pb-2">
        <Button data-testid={T.newChat} variant="secondary" className="flex-1 justify-start" onClick={onNewChat}><SquarePen strokeWidth={1.5} /> New chat</Button>
        {onClose ? <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close conversations"><X strokeWidth={1.5} /></Button> : null}
      </div>
      <Tabs value={tab} onValueChange={(v) => setTabParam(v === "threads" ? null : v)} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-3 shrink-0 max-tablet:flex-nowrap">
          <TabsTrigger value="threads" data-testid={T.threadsTab}>Conversations</TabsTrigger>
          <TabsTrigger value="background" data-testid={T.backgroundTab}>Background work</TabsTrigger>
        </TabsList>
        <TabsContent value="threads" className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-3">
          {conversations.length === 0 ? (
              <p data-testid={T.threadsEmpty} className="px-2.5 py-3 text-[13px] text-gray-10">{loading ? "Loading conversations..." : "No conversations yet. Ask the agent something and it shows up here; a follow-up stays in the same conversation."}</p>
            ) : (
              <ul className="flex flex-col gap-0.5" aria-label="Conversations">
                {conversations.map((c) => {
                  const sel: Selection = c.threadId ? { kind: "thread", threadId: c.threadId } : { kind: "run", runId: c.runs[0]!.id };
                  const current = c.key === selectedKey;
                  return (
                    <li key={c.key}>
                      <SelectLink href={selectionHref(base, sel)} onSelect={() => onSelect(sel)} data-testid={T.thread} data-key={c.key} aria-current={current ? "page" : undefined}
                        className={cn("flex flex-col gap-0.5 rounded-lg px-2.5 py-2 outline-none hover:bg-gray-a3 focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]", current && "bg-[var(--app-item-active)] hover:bg-[var(--app-item-active)]")}>
                        <span className="line-clamp-2 text-[13px] leading-5 font-medium break-words text-gray-12">{c.title}</span>
                        <span className="flex min-w-0 items-center gap-1.5 text-1 text-gray-10">
                          <Dot status={c.status} />
                          <span className="truncate">{ago(c.lastAt, now)}{c.runs.length > 1 ? `, ${c.runs.length} turns` : ""}</span>
                        </span>
                      </SelectLink>
                    </li>
                  );
                })}
              </ul>
            )}
        </TabsContent>
        <TabsContent value="background" className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-3">
          {background.length === 0 ? (
            <p data-testid={T.backgroundEmpty} className="px-2.5 py-3 text-[13px] text-gray-10">{loading ? "Loading..." : "No background work yet. Routines on a schedule and agency notices start runs on their own, and they show up here."}</p>
          ) : (
            <ul className="flex flex-col gap-0.5" aria-label="Background work">
              {background.map((r) => {
                const routine = routineIdOf(r);
                return <li key={r.id}><BackgroundItem r={r} name={(routine && routineNames.get(routine)) ?? "Routine run"} now={now} /></li>;
              })}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** One background run in the list. Its summary is the model's own words: untrusted when the run read untrusted
 *  content, as RunFeed marks it, so the cursor assistant never reads a notice's words as the list's. */
export function BackgroundItem({ r, name, now }: { r: AgentRunRow; name: string; now: string }) {
  return (
    <Link href={`/app/runs/${r.id}`} data-testid={T.background} data-run-id={r.id} className="flex flex-col gap-0.5 rounded-lg px-2.5 py-2 outline-none hover:bg-gray-a3 focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]">
      <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-5 font-medium text-gray-12"><Dot status={r.status} /><span className="truncate">{name}</span></span>
      {r.summary ? <span data-assist-untrusted={r.tainted ? "" : undefined} className="line-clamp-2 text-1 break-words text-gray-11">{routineSummaryText(r.summary)}</span> : null}
      <span className="text-0 text-gray-10">{ago(r.createdAt, now)}</span>
    </Link>
  );
}

/** One turn: the person's question, then the run as the side panel shows it. */
function Turn({ run, question, last }: { run: { id: string; createdAt: string }; question: string | null; last: boolean }) {
  return (
    <div data-testid={T.turn} data-run-id={run.id} className="flex flex-col gap-3">
      {question ? (
        <div data-testid={T.question} className="ml-auto max-w-[85%] rounded-[16px_16px_6px_16px] bg-gray-3 px-3.5 py-2.5 text-2 leading-[22px] break-words whitespace-pre-wrap">{question}</div>
      ) : (
        <p className="text-1 text-gray-10">Asked {fmtDateTime(run.createdAt)}. This earlier run did not keep its question.</p>
      )}
      <RunFeed runId={run.id} latest={last} />
    </div>
  );
}

export function AgentPage() {
  const [sel, setSel] = useState<Selection>({ kind: "new" });
  const [base, setBase] = useState(PAGE_PATH);
  const [listOpen, setListOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTurn[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const pinRef = useRef<() => void>(() => undefined);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // The selection is the URL's: read after mount (the export prerenders the page without a query), on Back, and when
  // the query is written in place (setUrlState: the cursor assistant opening a thread or run on this page).
  useEffect(() => {
    const read = () => { setSel(selectionFromSearch(window.location.search)); setBase(window.location.pathname || PAGE_PATH); };
    read();
    window.addEventListener("popstate", read);
    window.addEventListener(URL_STATE_EVENT, read);
    return () => { window.removeEventListener("popstate", read); window.removeEventListener(URL_STATE_EVENT, read); };
  }, []);
  const go = (next: Selection, replace = false) => {
    setSel(next);
    setError(null);
    setListOpen(false);
    const href = selectionHref(window.location.pathname || PAGE_PATH, next);
    try { if (replace) window.history.replaceState(null, "", href); else window.history.pushState(null, "", href); } catch { /* history blocked */ }
  };

  const clock = useSimClock();
  const now = (clock.data as { now?: string } | undefined)?.now ?? new Date().toISOString();
  const chats = useGet("/v1/agent/runs", { query: { trigger: "chat", limit: 100 }, refreshMs: 10_000 });
  const bg = useGet("/v1/agent/runs", { query: { trigger: "background", limit: 50 }, refreshMs: 15_000 });
  const routines = useGet("/v1/routines");
  const threadQ = useGet("/v1/agent/runs", { query: { thread_id: sel.kind === "thread" ? sel.threadId : undefined, limit: 100 }, enabled: sel.kind === "thread", refreshMs: 15_000 });

  const chatRows = ((chats.data as Page<ConversationRunRow>)?.data ?? []);
  const conversations = useMemo(() => groupConversations(chatRows), [chatRows]);
  const background = useMemo(() => backgroundRuns(((bg.data as Page<AgentRunRow>)?.data ?? [])), [bg.data]);
  const routineNames = useMemo(() => new Map(((routines.data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name])), [routines.data]);

  // A run selected by id selects its thread when it has one (a link to one turn of a conversation).
  const runPick = sel.kind === "run" ? chatRows.find((r) => r.id === sel.runId) : undefined;
  useEffect(() => { if (runPick?.threadId) go({ kind: "thread", threadId: runPick.threadId }, true); }, [runPick?.threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A run the list does not hold (older than its 100 newest): read it alone, once the list has answered.
  const single = useGet("/v1/agent/runs/:id", { params: { id: sel.kind === "run" ? sel.runId : "_" }, enabled: sel.kind === "run" && !runPick && !!chats.data });

  // The selected conversation: the thread's own rows (fresh), else the list's, plus turns sent from here that the
  // lists have not caught up with yet.
  const current: Conversation | null = useMemo(() => {
    if (sel.kind === "new") return null;
    let runs: ConversationRunRow[] = [];
    if (sel.kind === "thread") {
      runs = [...((threadQ.data as Page<ConversationRunRow>)?.data ?? [])];
      for (const r of findConversation(conversations, sel)?.runs ?? []) if (!runs.some((x) => x.id === r.id)) runs.push(r);
      for (const p of pending) {
        if (p.threadId !== sel.threadId || runs.some((x) => x.id === p.runId)) continue;
        runs.push({ id: p.runId, threadId: p.threadId, question: p.question, createdAt: p.createdAt, status: "queued", trigger: "chat", askedFrom: "agent", summary: null, costUsdMicros: 0, provider: "scripted", model: "" } as ConversationRunRow);
      }
    } else {
      const found = findConversation(conversations, sel);
      if (found) return found;
      const one = single.data as AgentRunRow | undefined;
      if (one && one.trigger === "chat") runs = [{ ...one, question: null, askedFrom: "agent" }];
    }
    if (runs.length === 0) return null;
    return groupConversations(runs)[0] ?? null;
  }, [sel, threadQ.data, conversations, pending, single.data]);

  const latest = current?.runs[current.runs.length - 1];
  const working = !!latest && isWorking(latest.status);
  const missing = sel.kind === "run" && !current && !!single.error;
  // Until a selected conversation's rows arrive, say so instead of flashing the empty state.
  const loadingSel = !current && !missing && ((sel.kind === "thread" && !threadQ.data && !threadQ.error) || (sel.kind === "run" && (!chats.data || single.loading)));
  const title = current ? current.title : missing ? "Conversation not found" : loadingSel || sel.kind === "run" ? "Conversation" : "New chat";
  const turns = current?.runs ?? [];
  // The conversation stays pinned to its newest turn while that turn streams in (steps, a chart, the answer), unless
  // the person has scrolled up to read; opening a conversation or sending pins it again.
  const selKey = sel.kind === "thread" ? sel.threadId : sel.kind === "run" ? sel.runId : "new";
  useEffect(() => {
    const box = scrollRef.current, content = contentRef.current;
    if (!box || !content) return;
    // Only a scroll up from where the page last pinned it lets go: content that grows between a pin and its scroll
    // event must not read as the person scrolling away.
    let pinnedAt = 0;
    const pin = () => { if (!stick.current) return; box.scrollTop = box.scrollHeight; pinnedAt = box.scrollTop; };
    const onScroll = () => {
      if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) stick.current = true;
      else if (box.scrollTop < pinnedAt - 4) stick.current = false;
    };
    pinRef.current = pin;
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(pin);
    ro?.observe(content);
    box.addEventListener("scroll", onScroll, { passive: true });
    pin();
    return () => { ro?.disconnect(); box.removeEventListener("scroll", onScroll); };
  }, []);
  useEffect(() => { stick.current = true; pinRef.current(); }, [selKey, turns.length]);

  async function send(prompt?: string) {
    const t = (prompt ?? text).trim();
    if (!t || busy) return;
    // A thread continues; a new chat, or an answer that has no thread (the side panel's runs, a portal question),
    // starts a new conversation.
    const threadId = sel.kind === "thread" ? sel.threadId : newThreadId();
    setBusy(true);
    setError(null);
    try {
      const res = (await client.post("/v1/agent/runs", { body: { text: t, pageContext: null, threadId } })) as { runId: string };
      setPending((p) => [...p, { threadId, runId: res.runId, question: t, createdAt: now }]);
      setText("");
      if (sel.kind !== "thread") go({ kind: "thread", threadId }, sel.kind === "new");
      invalidate();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!listOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setListOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listOpen]);

  const newChat = () => {
    go({ kind: "new" });
    setText("");
    requestAnimationFrame(() => composerRef.current?.focus());
  };
  // The sidebar's New agent thread button, pressed on this page.
  const newChatRef = useRef(newChat);
  newChatRef.current = newChat;
  useEffect(() => {
    const onNew = () => newChatRef.current();
    window.addEventListener(AGENT_PAGE_NEW_CHAT_EVENT, onNew);
    return () => window.removeEventListener(AGENT_PAGE_NEW_CHAT_EVENT, onNew);
  }, []);

  const list = (onClose?: () => void) => (
    <ConversationList conversations={conversations} background={background} routineNames={routineNames} selectedKey={current?.key ?? null} now={now} base={base}
      loading={chats.loading && !chats.data} onSelect={(s) => go(s)} onNewChat={newChat} onClose={onClose} />
  );

  const note = working ? "The agent is still working on the last question."
    : sel.kind === "run" && current && !current.threadId ? "This answer is not part of a thread, so a message here starts a new conversation."
    : current?.threadId ? "A follow-up sees the last three turns of this conversation."
    : null;

  return (
    <div data-testid={T.page} className="absolute inset-0 flex min-h-0">
      <CrumbLabel label={title} />
      <aside aria-label="Conversations and background work" className="hidden w-[288px] shrink-0 border-r border-[var(--app-border)] bg-[var(--app-sidebar-bg)] tablet:flex">
        {list()}
      </aside>
      {listOpen ? (
        <div className="fixed inset-0 z-40 bg-black/20 tablet:hidden" onClick={(e) => { if (e.target === e.currentTarget) setListOpen(false); }}>
          <aside aria-label="Conversations and background work" className="flex h-full w-[min(320px,88vw)] bg-[var(--app-sidebar-bg)] shadow-[var(--shadow-modal)]">{list(() => setListOpen(false))}</aside>
        </div>
      ) : null}
      <section aria-label="Conversation" className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-3 tablet:px-5">
          <Button data-testid={T.listToggle} variant="ghost" size="icon" className="tablet:hidden" onClick={() => setListOpen(true)} aria-label="Show conversations" aria-expanded={listOpen}>
            <PanelLeftOpen strokeWidth={1.5} />
          </Button>
          <h1 data-testid={T.title} className="min-w-0 flex-1 truncate text-2 font-semibold">{title}</h1>
          {latest && latest.model ? (
            <>
              <Badge data-testid={T.model} tone="outline" size="md" className="max-w-[45%] min-w-0 tablet:max-w-[260px]" title={`The latest turn ran on ${providerLabel(latest)}`}><span className="truncate">{providerLabel(latest)}</span></Badge>
              <span data-testid={T.cost} className="shrink-0 text-1 text-gray-10 tabular" title={current && current.runs.length > 1 ? `${current.runs.length} turns` : "One turn"}>{usd(conversationCost(current?.runs ?? []))}</span>
            </>
          ) : null}
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div ref={contentRef} className="mx-auto flex w-full max-w-[760px] flex-col gap-8 px-4 py-6 tablet:px-6">
            {missing ? (
              <div className="text-2 text-gray-10">
                <p className="text-foreground">No conversation {sel.kind === "run" ? sel.runId : ""}.</p>
                <p className="mt-1">The link may be from before the workspace was reset. Start a new chat, or pick a conversation from the list.</p>
              </div>
            ) : loadingSel ? (
              <p className="pt-6 text-2 text-gray-10">Loading the conversation...</p>
            ) : turns.length === 0 ? (
              <div data-testid={T.start} className="flex flex-col gap-2 pt-6 tablet:pt-12">
                <span className="grid size-9 place-items-center rounded-lg bg-gray-3 text-gray-11"><BotMessageSquare strokeWidth={1.5} className="size-5" /></span>
                <h2 className="mt-2 text-5 font-semibold tracking-tight">Ask the Weft agent</h2>
                <p className="max-w-[560px] text-2 text-gray-11">It reads payroll, people, taxes and the rest through the same tools you do, and asks before it changes anything. A follow-up stays in the conversation and sees its last three turns.</p>
                <PanelStart pathname={PAGE_PATH} recent={false} testId="agent-page-prompts" onAsk={(p) => void send(p)} onOpen={(runId) => go({ kind: "run", runId })} />
              </div>
            ) : (
              turns.map((r, i) => <Turn key={r.id} run={r} question={r.question} last={i === turns.length - 1} />)
            )}
          </div>
        </div>
        <div className="shrink-0 px-3 pb-3 tablet:px-6 tablet:pb-5">
          <div className="mx-auto w-full max-w-[760px]">
            <div className="rounded-xl border border-[var(--app-border)] bg-card px-3 py-2.5 shadow-xs">
              <textarea
                ref={composerRef}
                data-testid={T.composer}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!working) void send(); } }}
                rows={2}
                placeholder={current?.threadId ? "Ask a follow-up..." : "Ask the agent..."}
                aria-label="Message the agent"
                className="w-full resize-none bg-transparent text-2 outline-none placeholder:text-gray-9"
              />
              <div className="mt-1 flex items-center gap-2">
                {HOSTED ? <DictateButton onText={(t) => setText((cur) => appendDictation(cur, t))} /> : null}
                <span data-testid={T.composerNote} className="min-w-0 flex-1 truncate text-1 text-gray-10" title={note ?? undefined}>{note}</span>
                <Button data-testid={T.send} variant="primary" size="icon-sm" className="rounded-full" onClick={() => void send()} disabled={busy || working || !text.trim()} aria-label="Send">
                  <ArrowUp />
                </Button>
              </div>
            </div>
            {error ? <p role="alert" className="mt-1.5 text-1 text-red-11">{error}</p> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
