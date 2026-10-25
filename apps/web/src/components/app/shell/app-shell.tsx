"use client";
import { useAppPathname } from "@/lib/pathname";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@weft/ui";
import { AgentProvider, useAgent } from "../agent-context";
import { AgentPanel } from "../agent/agent-panel";
import { CommandMenu } from "./command-menu";
import { BreadcrumbProvider } from "./crumbs";
import { AGENT_PANEL_ID, Header, SIDEBAR_ID } from "./header";
import { Sidebar } from "./sidebar";
import { mocksEnabled } from "@/lib/api/mocks";
import { HOSTED } from "@/lib/hosted/flags";
import { HostedBanner } from "../../hosted/hosted-banner";
import { TourShellBridge } from "../../tour/shell-bridge";
import { CursorAssistant } from "../../assist/assistant";

function useMedia(q: string): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

function Frame({ children }: { children: ReactNode }) {
  const agent = useAgent();
  const pathname = useAppPathname();
  const desktop = useMedia("(min-width: 80rem)");
  const laptop = useMedia("(min-width: 64rem)");
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [search, setSearch] = useState(false);
  // Agent panel docks at desktop width; below it the panel overlays the page.
  const [prefLoaded, setPrefLoaded] = useState(false);
  // The Agent page is the agent at full width, so the side panel starts closed there (the toggle still opens it) and
  // what the person does with it on that page is not saved as their preference. Leaving the page restores the
  // saved state on a desktop window.
  const onAgentPage = isAgentPage(pathname);
  useEffect(() => { if (desktop && !prefLoaded) { agent.setOpen((o) => o || (!onAgentPage && readPref())); setPrefLoaded(true); } }, [desktop]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (onAgentPage) agent.setOpen(false);
    else if (prefLoaded && desktop) agent.setOpen(readPref());
  }, [onAgentPage]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setMobileNav(false); }, [pathname]);
  useEffect(() => { if (prefLoaded && !onAgentPage) try { window.localStorage.setItem("weft.agentOpen", agent.open ? "1" : "0"); } catch { /* blocked */ } }, [agent.open, prefLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const showSidebar = laptop && !sidebarHidden;
  const dockAgent = desktop && agent.open;
  return (
    <div
      // relative + overflow clip: an absolutely positioned descendant with no nearer positioned ancestor (a screen
      // reader table) is contained and clipped here, so it can never make the document scrollable, and nothing can
      // scroll the shell itself (clip, unlike hidden, is not a scroll container).
      className="relative grid h-dvh overflow-clip"
      style={{ gridTemplateColumns: `${showSidebar ? "var(--app-sidebar-w) " : ""}minmax(0,1fr)${dockAgent ? " var(--app-agent-w)" : ""}` }}
    >
      {showSidebar ? <aside className="min-h-0 bg-[var(--app-sidebar-bg)]"><Sidebar id={SIDEBAR_ID} onOpenSearch={() => setSearch(true)} /></aside> : null}
      <div className={cn("flex min-h-0 min-w-0 flex-col bg-background", showSidebar && "border-l border-[var(--app-border)]")}>
        <Header sidebarVisible={showSidebar} sidebarExpanded={laptop ? showSidebar : mobileNav} onToggleSidebar={() => (laptop ? setSidebarHidden((h) => !h) : setMobileNav((v) => !v))} onOpenSearch={() => setSearch(true)} />
        {mocksEnabled ? <div className="border-b border-[var(--app-border)] bg-amber-3 px-4 py-1 text-1 text-amber-11">Mock data (NEXT_PUBLIC_WEFT_MOCKS=1). Nothing here talks to the API.</div> : null}
        {HOSTED ? <HostedBanner /> : null}
        <main data-app-main="" className="relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</main>
      </div>
      {dockAgent ? <AgentPanel id={AGENT_PANEL_ID} className="min-h-0" /> : null}
      {!desktop && agent.open ? (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={(e) => { if (e.target === e.currentTarget) agent.setOpen(false); }}>
          <AgentPanel id={AGENT_PANEL_ID} overlay className="w-full max-w-[var(--app-agent-w)] shadow-[var(--shadow-modal)]" />
        </div>
      ) : null}
      {!laptop && mobileNav ? (
        <div className="fixed inset-0 z-40 bg-black/20" onClick={(e) => { if (e.target === e.currentTarget) setMobileNav(false); }}>
          <aside className="h-full w-[min(var(--app-sidebar-w),85vw)] bg-[var(--app-sidebar-bg)] shadow-[var(--shadow-modal)]"><Sidebar id={SIDEBAR_ID} onNavigate={() => setMobileNav(false)} onOpenSearch={() => { setMobileNav(false); setSearch(true); }} /></aside>
        </div>
      ) : null}
      <CommandMenu open={search} onOpenChange={setSearch} />
      <TourShellBridge setMobileNav={setMobileNav} laptop={laptop} desktop={desktop} />
      {/* The cursor assistant lives in the app shell only: the marketing pages and the portal keep the browser's menu. */}
      <CursorAssistant pathname={pathname} />
    </div>
  );
}

/** The full-page agent (/app/agent, any query). */
export function isAgentPage(pathname: string): boolean {
  return pathname === "/app/agent";
}

function readPref(): boolean {
  try { return window.localStorage.getItem("weft.agentOpen") !== "0"; } catch { return true; }
}

export function AppShell({ children }: { children: ReactNode }) {
  return <AgentProvider><BreadcrumbProvider><Frame>{children}</Frame></BreadcrumbProvider></AgentProvider>;
}
