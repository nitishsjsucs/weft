"use client";
// Portal question box (wave 4, w4-parity-agent, T9). Owner: w4-parity-agent. The signed-in person asks about their own
// pay, time off, benefits or company policy; POST /v1/portal/agent/runs answers from their own record only. Medical
// leave, accommodations and workplace concerns are routed by code to a person on the HR team, and the box says so.
// Mounted below the portal sections (contract request: one line in portal-view.tsx).
import { useMemo, useState, type FormEvent } from "react";
import { MessageCircleQuestion, UserRound } from "lucide-react";
import { Button, Card } from "@weft/ui/components";
import { ApiError, createClient } from "@/lib/api/client";
import { W4_ASK_TID, type PortalAskResult } from "../../../../../packages/contracts/src/ext/w4-parity-agent";

const SUGGESTIONS = ["What is the meal limit for a client lunch?", "How much PTO do I have?", "When is my next payday?"];
const field = "min-h-20 w-full resize-y rounded-lg border border-[var(--app-border)] bg-card px-3 py-2 text-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]";

export function PortalAskBox({ principal }: { principal: string }) {
  const api = useMemo(() => createClient({ principal: () => principal || null }), [principal]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PortalAskResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = (await api.post("/v1/portal/agent/runs", { body: { text: q, threadId: result?.threadId ?? null } })) as unknown as PortalAskResult;
      setResult(r);
      if (!r.answer) setError("The answer is taking longer than usual. Try again in a minute.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4" data-testid={W4_ASK_TID.section}>
      <div className="flex items-center gap-2">
        <MessageCircleQuestion className="size-5 text-gray-10" aria-hidden />
        <h2 className="text-4 font-semibold">Ask about your pay, time off or benefits</h2>
      </div>
      <p className="mt-1 text-2 text-gray-11">The Weft agent answers from your own record and company policy only. Questions about medical leave, accommodations or a workplace concern go to a person on the HR team.</p>
      <form onSubmit={ask} className="mt-3 flex flex-col gap-2">
        <label className="sr-only" htmlFor="portal-ask-input">Your question</label>
        <textarea id="portal-ask-input" data-testid={W4_ASK_TID.input} className={field} maxLength={2000} placeholder="For example: how much was my last paycheck?" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); } }} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" size="lg" disabled={busy || !text.trim()} data-testid={W4_ASK_TID.submit}>{busy ? "Looking it up..." : "Ask"}</Button>
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" data-testid={W4_ASK_TID.suggestion} onClick={() => setText(s)} className="rounded-full border border-[var(--app-border)] px-3 py-1 text-1 text-gray-11 hover:bg-gray-a3">{s}</button>
          ))}
        </div>
      </form>
      {error ? <p role="alert" data-testid={W4_ASK_TID.error} className="mt-3 text-2 text-red-11">{error}</p> : null}
      {result?.answer ? (
        result.handoffId ? (
          <div data-testid={W4_ASK_TID.handoff} data-handoff={result.handoffId} className="mt-3 flex gap-2 rounded-lg bg-amber-a3 p-3 text-2 text-gray-12">
            <UserRound className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p data-testid={W4_ASK_TID.answer} className="whitespace-pre-line">{result.answer}</p>
          </div>
        ) : (
          <p data-testid={W4_ASK_TID.answer} data-run={result.runId ?? ""} data-status={result.status} className="mt-3 whitespace-pre-line rounded-lg bg-gray-a3 p-3 text-2 text-gray-12">{result.answer}</p>
        )
      ) : null}
    </Card>
  );
}
