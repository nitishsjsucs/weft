"use client";
// The hosted shell's banner under the top bar (docs/cloudflare/design.md 6.2 and 6.5): the shared read-only showcase
// with Start my demo company, or the visitor's own demo company with its lease countdown and the fictional-data
// notice; plus why new runs use the scripted provider when the day budget, the neuron cap or the kill switch says so.
import { useEffect } from "react";
import { Button } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { bootSession, fmtLeft, leaseDeadline, refreshSession, requestStart } from "@/lib/hosted/session";
import { blockedText, HOSTED_COPY as C, providerNote } from "./copy";
import { useHostedState, useNow } from "./use-hosted";

const bar = "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--app-border)] px-4 py-1.5 text-1";

export function HostedBanner() {
  useEffect(() => { bootSession(); }, []);
  const s = useHostedState();
  const now = useNow(15_000);
  const lease = s.status?.lease ?? null;
  const deadline = lease ? leaseDeadline(lease) : null;
  const left = deadline === null ? null : deadline - now;
  // The countdown ran out: ask the Lobby (the answer shows the lease-ended screen when the lease is gone). Only while
  // visible, so a hidden tab stays at zero requests; the scheduler's visibility change re-reads it later anyway.
  useEffect(() => {
    if (left !== null && left <= 0 && !document.hidden) void refreshSession();
  }, [left !== null && left <= 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!s.status) {
    // Degradation level 4 (design 6.5): the platform answers 429 on Worker paths once the account's request cap is
    // reached, while every page still loads from static assets. Any other failed read gets a plain line.
    if (!s.error) return null;
    return <div role="status" data-testid="hosted-banner" data-world="unavailable" className={cn(bar, "bg-amber-3 text-amber-11")}>{s.errorStatus === 429 ? (s.errorCode === "RATE_LIMITED" ? C.rateLimited : C.requestCap) : C.apiDown}</div>;
  }
  const note = providerNote(s.status.provider, s.status.agentEnabled);
  if (s.status.world === "showcase" || !lease) {
    return (
      <div data-testid="hosted-banner" data-world="showcase" className={cn(bar, "bg-blue-3 text-blue-11")}>
        <span className="min-w-0 flex-1">{s.blocked ? blockedText(s.blocked) : `${C.showcase} ${C.showcaseMore}`}</span>
        {s.limited?.kind === "showcase" ? <span className="w-full text-amber-11" data-testid="hosted-limit">{C.showcaseLimit}</span> : null}
        {s.status.level >= 3 ? null : <Button size="xs" variant="primary" data-testid="hosted-start-cta" onClick={() => requestStart("button")}>{C.showcaseCta}</Button>}
        {note ? <span className="w-full text-amber-11">{note}</span> : null}
      </div>
    );
  }
  return (
    <div data-testid="hosted-banner" data-world="slot" data-slot={lease.slot} className={cn(bar, "bg-gray-2 text-gray-11")}>
      <span className="font-medium text-gray-12">{C.leased}</span>
      <span data-testid="hosted-lease-left" className="tabular">{left === null ? "" : fmtLeft(Math.max(0, left))}</span>
      <span className="min-w-0 flex-1">{C.fictional}</span>
      {s.limited?.kind === "demo" ? <span className="w-full text-amber-11" data-testid="hosted-limit">{C.demoLimit}</span> : null}
      {note ? <span className="w-full text-amber-11" data-testid="hosted-provider-note">{note}</span> : null}
    </div>
  );
}
