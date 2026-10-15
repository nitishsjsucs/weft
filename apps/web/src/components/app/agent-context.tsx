"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface ThreadItem { id: string; kind: "user" | "run" | "error"; text?: string; runId?: string; label?: string }

interface AgentCtx {
  open: boolean;
  setOpen: (v: boolean | ((x: boolean) => boolean)) => void;
  thread: ThreadItem[];
  push: (item: Omit<ThreadItem, "id">) => void;
  /** Show a run started elsewhere (Run review now, Deliver notice) in the panel and open it. */
  watch: (runId: string, label: string) => void;
  clear: () => void;
}
const Ctx = createContext<AgentCtx | null>(null);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const push = useCallback((item: Omit<ThreadItem, "id">) => setThread((t) => [...t, { ...item, id: `${Date.now()}-${t.length}` }]), []);
  const watch = useCallback((runId: string, label: string) => {
    setThread((t) => (t.some((x) => x.runId === runId) ? t : [...t, { id: `${Date.now()}-${t.length}`, kind: "run", runId, label }]));
    setOpen(true);
  }, []);
  const clear = useCallback(() => setThread([]), []);
  const value = useMemo(() => ({ open, setOpen, thread, push, watch, clear }), [open, thread, push, watch, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAgent(): AgentCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAgent outside AgentProvider");
  return v;
}
