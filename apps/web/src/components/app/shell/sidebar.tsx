"use client";
// App sidebar (SPEC 11.3; research/wave3/topbar-design.md D1 and 7.2 to 7.4): a two-line workspace row, search with a
// New agent thread button beside it, then the nav. One pill style only (the Inbox count); "Simulated" is quiet
// trailing text.
import Link from "next/link";
import { useAppPathname } from "@/lib/pathname";
import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Button, Kbd, shortcutLabel } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID, tid, W3_SHELL_TID } from "@weft/contracts";
import { activeNav, NAV, SETTINGS_ITEM, type NavItem } from "../nav";
import { usePendingCount } from "@/lib/api/hooks";
import { useCan } from "@/lib/api/access";
import { useAgent } from "../agent-context";
import { WeftMark } from "../weft-mark";

const TRAILING: Record<"simulated", string> = { simulated: "Simulated" };

function Item({ item, active, pending, onNavigate }: { item: NavItem; active: boolean; pending: number | null; onNavigate?: () => void }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      data-testid={tid.nav(item.slug)}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-lg px-2 text-2 text-gray-12 outline-none transition-colors hover:bg-gray-a3 focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]",
        active && "bg-[var(--app-item-active)] font-medium hover:bg-[var(--app-item-active)]",
      )}
    >
      <Icon className="size-4 shrink-0 text-gray-11" strokeWidth={1.5} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.badge === "inbox" && pending ? (
        <span aria-label={`${pending} pending`} className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent-9 px-1.5 text-[11px] leading-none font-semibold tabular text-white">{pending}</span>
      ) : null}
      {item.badge === "simulated" ? <span className="shrink-0 text-1 font-normal text-gray-9">{TRAILING[item.badge]}</span> : null}
    </Link>
  );
}

/** The platform's shortcut label, set after mount so the server render and the first client render agree. */
function useShortcut(key: string): string {
  const [label, setLabel] = useState(`⌘${key}`);
  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    setLabel(shortcutLabel(key, nav.userAgentData?.platform || nav.platform));
  }, [key]);
  return label;
}

/** Search field (opens the command menu) and the square New agent thread button. */
function SearchRow({ onOpenSearch, onNavigate }: { onOpenSearch: () => void; onNavigate?: () => void }) {
  const agent = useAgent();
  const kbd = useShortcut("K");
  const newThread = () => {
    agent.clear();
    agent.setOpen(true);
    onNavigate?.();
    // Focus the composer once the panel has rendered.
    requestAnimationFrame(() => requestAnimationFrame(() => (document.querySelector(`[data-testid="${TID.agentComposer}"]`) as HTMLElement | null)?.focus()));
  };
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        data-testid={W3_SHELL_TID.sidebarSearch}
        onClick={onOpenSearch}
        aria-keyshortcuts="Meta+K Control+K"
        className="weft-press flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-card pr-1.5 pl-2.5 text-[13px] text-gray-9 shadow-[var(--shadow-border),var(--shadow-xs)] outline-none hover:bg-gray-2 focus-visible:ring-2 focus-visible:ring-[var(--blue-9)] focus-visible:ring-offset-1"
      >
        <Search aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-gray-10" />
        <span className="min-w-0 flex-1 truncate text-left">Search</span>
        <Kbd aria-hidden>{kbd}</Kbd>
      </button>
      <Button variant="secondary" size="icon" data-testid={W3_SHELL_TID.newThread} onClick={newThread} aria-label="New agent thread">
        <Plus strokeWidth={1.5} className="text-gray-11" />
      </Button>
    </div>
  );
}

export function Sidebar({ id, onNavigate, onOpenSearch }: { id?: string; onNavigate?: () => void; onOpenSearch: () => void }) {
  const pathname = useAppPathname();
  const active = activeNav(pathname);
  const pending = usePendingCount();
  const can = useCan();
  return (
    <nav id={id} aria-label="App" className="flex h-full flex-col gap-1 overflow-y-auto px-3 pt-2 pb-3">
      <div className="flex h-10 items-center gap-2.5 rounded-lg px-1.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-gray-12 text-white"><WeftMark className="size-4" /></span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-2 leading-5 font-medium">Larkspur Robotics</span>
          <span className="truncate text-1 text-gray-11">Demo workspace, Admin</span>
        </span>
      </div>
      <div className="mt-1 mb-2"><SearchRow onOpenSearch={onOpenSearch} onNavigate={onNavigate} /></div>
      {NAV.map((g, i) => (
        <div key={g.label ?? i} data-tour="nav-group" data-group={g.label ?? "Main"} className={cn(g.label && "mt-4")}>
          {g.label ? <div className="mb-1 px-2 text-1 font-medium text-gray-10">{g.label}</div> : null}
          <div className="flex flex-col gap-0.5">
            {g.items.filter((it) => !it.domain || can(it.domain)).map((it) => <Item key={it.slug} item={it} active={active?.slug === it.slug} pending={pending} onNavigate={onNavigate} />)}
          </div>
        </div>
      ))}
      <div className="mt-auto pt-4"><Item item={SETTINGS_ITEM} active={active?.slug === "settings"} pending={null} onNavigate={onNavigate} /></div>
    </nav>
  );
}
