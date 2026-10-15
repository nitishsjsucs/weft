"use client";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@weft/ui";
import { AgentProvider, useAgent } from "../agent-context";
import { AgentPanel } from "../agent/agent-panel";
import { CommandMenu } from "./command-menu";
import { Header } from "./header";
import { Sidebar } from "./sidebar";
import { mocksEnabled } from "@/lib/api/mocks";

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
  const pathname = usePathname();
  const desktop = useMedia("(min-width: 80rem)");
  const laptop = useMedia("(min-width: 64rem)");
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [search, setSearch] = useState(false);
  // Agent panel docks at desktop width; below it the panel overlays the page.
  const [prefLoaded, setPrefLoaded] = useState(false);
  useEffect(() => { if (desktop && !prefLoaded) { agent.setOpen((o) => o || readPref()); setPrefLoaded(true); } }, [desktop]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setMobileNav(false); }, [pathname]);
  useEffect(() => { if (prefLoaded) try { window.localStorage.setItem("weft.agentOpen", agent.open ? "1" : "0"); } catch { /* blocked */ } }, [agent.open, prefLoaded]);

  const showSidebar = laptop && !sidebarHidden;
  const dockAgent = desktop && agent.open;
  return (
    <div
      className="grid h-dvh overflow-hidden"
      style={{ gridTemplateColumns: `${showSidebar ? "var(--app-sidebar-w) " : ""}minmax(0,1fr)${dockAgent ? " var(--app-agent-w)" : ""}` }}
    >
      {showSidebar ? <aside className="min-h-0 bg-[var(--app-sidebar-bg)]"><Sidebar /></aside> : null}
      <div className={cn("flex min-h-0 min-w-0 flex-col bg-background", showSidebar && "border-l border-[var(--app-border)]")}>
        <Header onToggleSidebar={() => (laptop ? setSidebarHidden((h) => !h) : setMobileNav((v) => !v))} onOpenSearch={() => setSearch(true)} />
        {mocksEnabled ? <div className="border-b border-[var(--app-border)] bg-amber-3 px-4 py-1 text-1 text-amber-11">Mock data (NEXT_PUBLIC_WEFT_MOCKS=1). Nothing here talks to the API.</div> : null}
        <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</main>
      </div>
      {dockAgent ? <AgentPanel className="min-h-0" /> : null}
      {!desktop && agent.open ? (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={(e) => { if (e.target === e.currentTarget) agent.setOpen(false); }}>
          <AgentPanel className="w-full max-w-[var(--app-agent-w)] shadow-[var(--shadow-modal)]" />
        </div>
      ) : null}
      {!laptop && mobileNav ? (
        <div className="fixed inset-0 z-40 bg-black/20" onClick={(e) => { if (e.target === e.currentTarget) setMobileNav(false); }}>
          <aside className="h-full w-[min(var(--app-sidebar-w),85vw)] bg-[var(--app-sidebar-bg)] shadow-[var(--shadow-modal)]"><Sidebar onNavigate={() => setMobileNav(false)} /></aside>
        </div>
      ) : null}
      <CommandMenu open={search} onOpenChange={setSearch} />
    </div>
  );
}

function readPref(): boolean {
  try { return window.localStorage.getItem("weft.agentOpen") !== "0"; } catch { return true; }
}

export function AppShell({ children }: { children: ReactNode }) {
  return <AgentProvider><Frame>{children}</Frame></AgentProvider>;
}
