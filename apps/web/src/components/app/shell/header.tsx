"use client";
// The 48 px app top bar (research/wave3/topbar-design.md D1 to D8): sidebar toggle, breadcrumb, a search icon only
// while the sidebar is hidden, one environment pill (model, simulated clock, Viewing as) and the agent toggle. Every
// control is 32 px at radius 8; the pill's segments are 28 px at radius 6. The bar collapses in three tiers by its own
// container width (Full from 760, Compact from 480, Mini below), so docking the agent changes the tier, not the window.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, PanelLeft, PanelRight, Search } from "lucide-react";
import { Button } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { W3_SHELL_TID, W3_TOPBAR_SHELL_DOM } from "@weft/contracts";
import { crumbs } from "../nav";
import { useAgent } from "../agent-context";
import { useCrumbTitle } from "./crumbs";
import { EnvPill } from "./env-pill";
import { barIconClass } from "./segment";

export const SIDEBAR_ID = W3_TOPBAR_SHELL_DOM.sidebar;
export const AGENT_PANEL_ID = W3_TOPBAR_SHELL_DOM.agentPanel;

function Breadcrumb() {
  const pathname = usePathname();
  const trail = crumbs(pathname, useCrumbTitle());
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center">
      <ol className="flex min-w-0 items-center gap-1 text-2">
        {trail.map((c, i) => {
          const last = i === trail.length - 1;
          return (
            <li key={i} className={cn("flex min-w-0 items-center gap-1", !last && "hidden shrink-0 @min-[620px]:flex")}>
              {i > 0 ? <ChevronRight aria-hidden strokeWidth={1.5} className="hidden size-3.5 shrink-0 text-gray-9 @min-[620px]:block" /> : null}
              {c.href && !last ? (
                <Link href={c.href} className="truncate rounded-sm text-gray-11 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--blue-9)] focus-visible:ring-offset-1">{c.label}</Link>
              ) : (
                <span aria-current="page" className={cn("truncate font-medium text-gray-12", c.id && "font-mono text-1 font-normal text-gray-11")}>{c.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * `sidebarVisible` is the docked sidebar (it carries search, so the bar shows a search icon only without it);
 * `sidebarExpanded` is the docked sidebar or the drawer below 1024 px, for the toggle's aria-expanded.
 */
export function Header({ sidebarVisible, sidebarExpanded, onToggleSidebar, onOpenSearch }: { sidebarVisible: boolean; sidebarExpanded: boolean; onToggleSidebar: () => void; onOpenSearch: () => void }) {
  const agent = useAgent();
  return (
    <div className="@container shrink-0 border-b border-[var(--app-border)] bg-background">
      <header className="flex h-[var(--tb-h)] min-w-0 items-center gap-[var(--tb-gap)] px-[var(--tb-pad-x)]">
        <Button variant="ghost" size="icon" className={barIconClass} onClick={onToggleSidebar} aria-label="Toggle sidebar" aria-expanded={sidebarExpanded} aria-controls={SIDEBAR_ID}>
          <PanelLeft strokeWidth={1.5} />
        </Button>
        <Breadcrumb />
        {sidebarVisible ? null : (
          <Button variant="ghost" size="icon" className={barIconClass} onClick={onOpenSearch} aria-label="Search pages, people and payroll runs" aria-keyshortcuts="Meta+K Control+K">
            <Search strokeWidth={1.5} />
          </Button>
        )}
        <EnvPill />
        <Button
          variant="ghost"
          size="icon"
          data-testid={W3_SHELL_TID.agentToggle}
          className={barIconClass}
          onClick={() => agent.setOpen((o) => !o)}
          aria-label="Toggle agent panel"
          aria-pressed={agent.open}
          aria-controls={AGENT_PANEL_ID}
        >
          <PanelRight strokeWidth={1.5} />
        </Button>
      </header>
    </div>
  );
}
