"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Badge } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { tid } from "@weft/contracts";
import { activeNav, NAV, SETTINGS_ITEM, type NavItem } from "../nav";
import { usePendingCount } from "@/lib/api/hooks";
import { WeftMark } from "../weft-mark";

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
      {item.badge === "inbox" && pending ? <Badge tone="accent" size="xs" aria-label={`${pending} pending`}>{pending}</Badge> : null}
      {item.badge === "simulated" ? <Badge tone="outline" size="xs">Simulated</Badge> : null}
      {item.badge === "soon" ? <Badge tone="gray" size="xs">Coming soon</Badge> : null}
    </Link>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = activeNav(pathname);
  const pending = usePendingCount();
  return (
    <nav aria-label="App" className="flex h-full flex-col gap-1 overflow-y-auto px-3 pt-2 pb-3">
      <div className="mb-2 flex h-9 items-center gap-2 rounded-lg px-1.5">
        <span className="grid size-5 place-items-center rounded-md bg-gray-12 text-white"><WeftMark className="size-3.5" /></span>
        <span className="min-w-0 flex-1 truncate text-2 font-medium">Larkspur Robotics (demo)</span>
        <Badge tone="blue" size="xs">Admin</Badge>
        <ChevronDown className="size-4 text-gray-10" strokeWidth={1.5} aria-hidden />
      </div>
      {NAV.map((g, i) => (
        <div key={g.label ?? i} className={cn(g.label && "mt-4")}>
          {g.label ? <div className="mb-1 flex items-center gap-1 px-2 text-1 font-medium text-gray-10">{g.label}<ChevronDown className="size-3" aria-hidden /></div> : null}
          <div className="flex flex-col gap-0.5">
            {g.items.map((it) => <Item key={it.slug} item={it} active={active?.slug === it.slug} pending={pending} onNavigate={onNavigate} />)}
          </div>
        </div>
      ))}
      <div className="mt-auto pt-4"><Item item={SETTINGS_ITEM} active={active?.slug === "settings"} pending={null} onNavigate={onNavigate} /></div>
    </nav>
  );
}
