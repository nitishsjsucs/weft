"use client";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, FileSearch, Plus, X } from "lucide-react";
import { Button } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID } from "@weft/contracts";
import { client, errorText } from "@/lib/api/hooks";
import { useAgent } from "../agent-context";
import { PanelStart } from "./panel-start";
import { RunFeed } from "./run-feed";

/** The agent panel (every app page): thread, live step chips, composer, and "Ask about this page". */
/** `overlay` is true when the panel covers the page (below 1280 px); only then does its header carry a close X. */
export function AgentPanel({ id, className, overlay = false }: { id?: string; className?: string; overlay?: boolean }) {
  const agent = useAgent();
  const pathname = usePathname();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [withPage, setWithPage] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [agent.thread.length]);

  async function send(prompt?: string) {
    const t = (prompt ?? text).trim();
    if (!t || busy) return;
    setBusy(true);
    agent.push({ kind: "user", text: t });
    setText("");
    try {
      const { runId } = await client.post("/v1/agent/runs", { body: { text: t, pageContext: withPage ? pathname : null, threadId: null } });
      agent.push({ kind: "run", runId });
    } catch (e) {
      agent.push({ kind: "error", text: errorText(e) });
    } finally { setBusy(false); setWithPage(false); }
  }

  return (
    <aside id={id} aria-label="Agent" data-tour="agent-panel" className={cn("flex h-full min-h-0 flex-col border-l border-[var(--app-border)] bg-[var(--app-sidebar-bg)]", className)}>
      <div className="flex h-[var(--app-header-h)] shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-4">
        <span className="flex-1 text-2 font-semibold">Weft agent</span>
        <Button variant="ghost" size="icon" onClick={agent.clear} aria-label="New thread"><Plus strokeWidth={1.5} /></Button>
        {/* Docked, the top bar's agent toggle closes the panel; the X shows only when the panel overlays the page. */}
        {overlay ? <Button variant="ghost" size="icon" onClick={() => agent.setOpen(false)} aria-label="Close agent panel"><X strokeWidth={1.5} /></Button> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {agent.thread.length === 0 ? (
          <div className="flex flex-col gap-2 text-2 text-gray-11">
            <p>Ask about payroll, people, taxes or anything on this page. The agent reads through the same tools you do and asks before it changes anything.</p>
            <p className="text-1 text-gray-10">Every company, person and agency here is synthetic.</p>
            <PanelStart pathname={pathname} onAsk={(p) => void send(p)} onOpen={(runId, label) => agent.watch(runId, label)} />
          </div>
        ) : null}
        <div className="flex flex-col gap-4">
          {agent.thread.map((m, i) =>
            m.kind === "user" ? (
              <div key={m.id} className="ml-auto max-w-[85%] rounded-[16px_16px_6px_16px] bg-gray-3 px-3 py-2 text-2 break-words whitespace-pre-wrap">{m.text}</div>
            ) : m.kind === "error" ? (
              <div key={m.id} className="rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{m.text}</div>
            ) : (
              <RunFeed key={m.id} runId={m.runId!} label={m.label} latest={!agent.thread.slice(i + 1).some((x) => x.kind === "run")} />
            ),
          )}
        </div>
        <div ref={endRef} />
      </div>
      <div className="shrink-0 p-3">
        <div data-tour="agent-composer" className="rounded-xl border border-[var(--app-border)] bg-card px-3 py-2.5 shadow-xs">
          <textarea
            data-testid={TID.agentComposer}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            rows={2}
            placeholder="Ask the agent..."
            aria-label="Message the agent"
            className="w-full resize-none bg-transparent text-2 outline-none placeholder:text-gray-9"
          />
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setWithPage((v) => !v)}
              aria-pressed={withPage}
              className={cn("inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-1 text-gray-11 shadow-[var(--shadow-border)] hover:bg-gray-2", withPage && "bg-blue-3 text-blue-11")}
            >
              <FileSearch className="size-3.5" /> Ask about this page
            </button>
            <span className="flex-1" />
            <Button data-testid={TID.agentSend} data-tour="agent-send" variant="primary" size="icon-sm" className="rounded-full" onClick={() => void send()} disabled={busy || !text.trim()} aria-label="Send">
              <ArrowUp />
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
}
