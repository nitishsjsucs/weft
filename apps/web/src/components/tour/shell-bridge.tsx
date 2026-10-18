"use client";
// Rendered inside AppShell's Frame: hands the agent panel and the nav drawer to the tour through bridge.ts.
import { useEffect, useRef } from "react";
import { useAgent } from "../app/agent-context";
import { registerBridge } from "./bridge";

export function TourShellBridge({ setMobileNav, laptop, desktop }: { setMobileNav: (open: boolean) => void; laptop: boolean; desktop: boolean }) {
  const agent = useAgent();
  const live = useRef({ agent, setMobileNav, laptop, desktop });
  live.current = { agent, setMobileNav, laptop, desktop };
  useEffect(() => registerBridge({
    agentOpen: () => live.current.agent.open,
    setAgentOpen: (open) => live.current.agent.setOpen(open),
    clearThread: () => live.current.agent.clear(),
    runIds: () => live.current.agent.thread.filter((t) => t.kind === "run" && t.runId).map((t) => t.runId!),
    openNav: () => live.current.setMobileNav(true),
    closeNav: () => live.current.setMobileNav(false),
    laptop: () => live.current.laptop,
    desktop: () => live.current.desktop,
  }), []);
  return null;
}
