"use client";
// The hosted shell's banner under the top bar (docs/cloudflare/design.md 6.2 and 6.5): on the shared read-only
// showcase, the offer to open your own workspace; in your own workspace, nothing unless there is something to say
// (its rows budget is spent, or new runs use the scripted provider because of the day budget, the neuron cap or the
// kill switch). Either way a hidden marker names the world the tab reads (`hosted-world`, for the e2e suites).
import { useEffect } from "react";
import { Button } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { bootSession, leaseDeadline, refreshSession, requestStart } from "@/lib/hosted/session";
import { blockedText, HOSTED_COPY as C, providerNote } from "./copy";
import { useHostedState } from "./use-hosted";

const bar = "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--app-border)] px-4 py-1.5 text-1";
/** setTimeout's longest delay; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function HostedBanner() {
  useEffect(() => { bootSession(); }, []);
  const s = useHostedState();
  const lease = s.status?.lease ?? null;
  const deadline = lease ? leaseDeadline(lease) : null;
  // The lease's deadline passed: ask the Lobby (the answer shows the lease-ended screen when the lease is gone). Only
  // while visible, so a hidden tab stays at zero requests; the scheduler's visibility change re-reads it later anyway.
  useEffect(() => {
    if (deadline === null) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      const wait = deadline - Date.now();
      if (wait > 0) { t = setTimeout(arm, Math.min(wait, MAX_TIMER_MS)); return; }
      if (!document.hidden) void refreshSession();
    };
    arm();
    return () => { if (t !== null) clearTimeout(t); };
  }, [deadline]);

  if (!s.status) {
    // Degradation level 4 (design 6.5): the platform answers 429 on Worker paths once the account's request cap is
    // reached, while every page still loads from static assets. Any other failed read gets a plain line.
    if (!s.error) return null;
    return <div role="status" data-testid="hosted-banner" data-world="unavailable" className={cn(bar, "bg-amber-3 text-amber-11")}>{s.errorStatus === 429 ? (s.errorCode === "RATE_LIMITED" ? C.rateLimited : C.requestCap) : C.apiDown}</div>;
  }
  const note = providerNote(s.status.provider, s.status.agentEnabled);
  if (s.status.world === "showcase" || !lease) {
    return (
      <>
        <span hidden data-testid="hosted-world" data-world="showcase" />
        <div data-testid="hosted-banner" data-world="showcase" className={cn(bar, "bg-blue-3 text-blue-11")}>
          <span className="min-w-0 flex-1">{s.blocked ? blockedText(s.blocked) : `${C.showcase} ${C.showcaseMore}`}</span>
          {s.limited?.kind === "showcase" ? <span className="w-full text-amber-11" data-testid="hosted-limit">{C.showcaseLimit}</span> : null}
          {s.status.level >= 3 ? null : <Button size="xs" variant="primary" data-testid="hosted-start-cta" onClick={() => requestStart("button")}>{C.showcaseCta}</Button>}
          {note ? <span className="w-full text-amber-11">{note}</span> : null}
        </div>
      </>
    );
  }
  const limited = s.limited?.kind === "demo";
  const marker = <span hidden data-testid="hosted-world" data-world="slot" data-slot={lease.slot} />;
  if (!limited && !note) return marker;
  return (
    <>
      {marker}
      <div role="status" data-testid="hosted-banner" data-world="slot" data-slot={lease.slot} className={cn(bar, "bg-amber-3 text-amber-11")}>
        {limited ? <span className="w-full" data-testid="hosted-limit">{C.demoLimit}</span> : null}
        {note ? <span className="w-full" data-testid="hosted-provider-note">{note}</span> : null}
      </div>
    </>
  );
}
