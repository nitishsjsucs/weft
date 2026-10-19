"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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

// While a guided tour runs (its state is in sessionStorage weft.tour.v1), the thread is kept in sessionStorage too, so
// the hop to /portal and back (which remounts the app shell) does not drop the notice run and the chart.
const TOUR_KEY = "weft.tour.v1";
const THREAD_KEY = "weft.agent.thread.v1";
const store = (): Storage | null => { try { return window.sessionStorage; } catch { return null; } };
const touring = () => { try { return !!store()?.getItem(TOUR_KEY); } catch { return false; } };
function loadThread(): ThreadItem[] {
  try {
    if (!touring()) { store()?.removeItem(THREAD_KEY); return []; }
    const raw = store()?.getItem(THREAD_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(v) ? (v as ThreadItem[]).filter((x) => x && typeof x.id === "string" && (x.kind === "user" || x.kind === "run" || x.kind === "error")) : [];
  } catch { return []; }
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const restored = useRef(false);
  useEffect(() => { const t = loadThread(); restored.current = true; if (t.length) setThread(t); }, []);
  useEffect(() => {
    if (!restored.current) return;
    try { if (touring() && thread.length) store()?.setItem(THREAD_KEY, JSON.stringify(thread.slice(-20))); else store()?.removeItem(THREAD_KEY); } catch { /* storage blocked */ }
  }, [thread]);
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
