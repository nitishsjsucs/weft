"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronRight, Clock, PanelLeft, PanelRight, Search, Sparkles } from "lucide-react";
import { Badge, Button, Kbd } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID, type W2OnboardingOfferDetail } from "@weft/contracts";
import { crumbs } from "../nav";
import { fmtClock, fmtShortClock } from "../format";
import { PRINCIPALS, setPrincipal, useGet, useHealth, usePrincipal, useSimClock } from "@/lib/api/hooks";
import { useAgent } from "../agent-context";

/** New-hire personas from sent, viewed or accepted offers. They sign in to the portal only (PORTAL_ONLY elsewhere). */
function usePortalPersonas(): { id: string; name: string }[] {
  const offers = useGet("/v1/offers", { query: { limit: 100 }, refreshMs: 15_000 });
  const rows = (offers.data?.data ?? []) as unknown as W2OnboardingOfferDetail[];
  return rows
    .filter((o) => o.personaPrincipalId && (o.status === "sent" || o.status === "viewed" || o.status === "accepted"))
    .map((o) => ({ id: o.personaPrincipalId!, name: `${o.candidateFirst} ${o.candidateLast}` }));
}

const PORTAL_PREFIX = "portal:";

export function ViewingAs() {
  const who = usePrincipal();
  const personas = usePortalPersonas();
  const current = PRINCIPALS.find((p) => p.id === who) ?? PRINCIPALS[0];
  const choose = (v: string) => {
    // A persona opens the new-hire portal in place of switching the admin shell's principal.
    if (v.startsWith(PORTAL_PREFIX)) window.location.assign(`/portal?as=${encodeURIComponent(v.slice(PORTAL_PREFIX.length))}`);
    else setPrincipal(v);
  };
  return (
    <label className="relative flex min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg py-1 pr-1.5 pl-1 text-1 shadow-[var(--shadow-border)] hover:bg-gray-2" title={`Demo control: viewing as ${current.name}, ${current.title}. Switches the signed-in human (dev auth only) and defeats self-approval checks by design.`}>
      <Badge tone="amber" size="xs"><span className="@min-[560px]:hidden">Demo</span><span className="hidden @min-[560px]:inline">Demo control</span></Badge>
      <span className="hidden text-gray-11 @min-[900px]:inline">Viewing as</span>
      <span className="font-medium whitespace-nowrap">{current.name.split(" ")[0]}</span>
      <ChevronDown className="size-3 text-gray-10" aria-hidden />
      <select
        data-testid={TID.viewingAs}
        aria-label="Viewing as (demo control)"
        value={who}
        onChange={(e) => choose(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {PRINCIPALS.map((p) => <option key={p.id} value={p.id}>{p.name}, {p.title}</option>)}
        {personas.length ? (
          <optgroup label="New-hire portal">
            {personas.map((p) => <option key={p.id} value={`${PORTAL_PREFIX}${p.id}`}>{p.name}, new hire (opens the portal)</option>)}
          </optgroup>
        ) : null}
      </select>
    </label>
  );
}

export function Header({ onToggleSidebar, onOpenSearch }: { onToggleSidebar: () => void; onOpenSearch: () => void }) {
  const pathname = usePathname();
  const trail = crumbs(pathname);
  const health = useHealth();
  const clock = useSimClock();
  const agent = useAgent();
  const now = clock.data?.now ?? health.data?.clock.now;
  return (
    <header className="@container flex h-[var(--app-header-h)] min-w-0 items-center gap-1.5 border-b border-[var(--app-border)] bg-background px-2 @min-[560px]:gap-2 @min-[560px]:px-3">
      <Button variant="ghost" size="icon-sm" onClick={onToggleSidebar} aria-label="Toggle sidebar"><PanelLeft strokeWidth={1.5} /></Button>
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-2 @min-[1040px]:flex-none">
        {trail.map((c, i) => (
          <span key={i} className={cn("flex min-w-0 items-center gap-1", i < trail.length - 1 && "hidden @min-[620px]:flex")}>
            {i > 0 ? <ChevronRight className="size-3.5 shrink-0 text-gray-9" aria-hidden /> : null}
            {c.href && i < trail.length - 1 ? <Link href={c.href} className="truncate text-gray-11 hover:text-foreground">{c.label}</Link> : <span className="truncate font-medium">{c.label}</span>}
          </span>
        ))}
      </nav>
      <div className="hidden min-w-0 flex-1 justify-center @min-[720px]:flex">
        <button type="button" onClick={onOpenSearch} className="flex h-8 w-full max-w-[320px] items-center gap-2 @min-[1040px]:max-w-[420px] rounded-lg border border-[var(--app-border)] bg-card px-2.5 text-2 text-gray-9 shadow-xs hover:bg-gray-2">
          <Search className="size-4" strokeWidth={1.5} />
          <span className="flex-1 truncate text-left">Search or jump to...</span>
          <Kbd>⌘</Kbd><Kbd>K</Kbd>
        </button>
      </div>
      <Button variant="ghost" size="icon-sm" className="@min-[720px]:hidden" onClick={onOpenSearch} aria-label="Search"><Search strokeWidth={1.5} /></Button>
      <Badge data-testid={TID.providerBadge} tone={health.data?.provider.live ? "green" : "outline"} size="md" className="hidden @min-[600px]:inline-flex" title="Active model provider">
        {health.data?.provider.label ?? "Provider"}
      </Badge>
      <Link
        href="/app/simulators"
        data-testid={TID.simClock}
        data-now={now ?? ""}
        title="Simulated clock (Pacific time)"
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-gray-3 px-2 text-1 font-medium tabular whitespace-nowrap text-gray-12 hover:bg-gray-4"
      >
        <Clock className="size-3.5 text-gray-11" strokeWidth={1.5} />
        <span className="hidden @min-[900px]:inline">Sim</span>
        <span className="hidden @min-[900px]:inline">{now ? fmtClock(now) : "..."}</span>
        <span className="@min-[900px]:hidden">{now ? fmtShortClock(now) : "..."}</span>
      </Link>
      <ViewingAs />
      <Button variant={agent.open ? "secondary" : "ghost"} size="icon-sm" onClick={() => agent.setOpen((o) => !o)} aria-label="Toggle agent panel" aria-pressed={agent.open}>
        {agent.open ? <PanelRight strokeWidth={1.5} /> : <Sparkles strokeWidth={1.5} />}
      </Button>
    </header>
  );
}
