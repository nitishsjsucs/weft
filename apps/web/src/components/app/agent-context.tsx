"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { client, startPoller } from "@/lib/api/hooks";
import { HOSTED } from "@/lib/hosted/flags";
import { recentAgentRuns, routineIdOf } from "./agent/follow";

/** `background` marks a routine run the panel picked up on its own (no click started it). */
export interface ThreadItem { id: string; kind: "user" | "run" | "error"; text?: string; runId?: string; label?: string; background?: boolean }

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
/** How often the panel looks for routine runs that started on their own. */
const FOLLOW_MS = 4_000;
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
    // A run the follower already added keeps its place and takes the label of the click that started it.
    setThread((t) => (t.some((x) => x.runId === runId) ? t.map((x) => (x.runId === runId ? { ...x, label, background: false } : x)) : [...t, { id: `${Date.now()}-${t.length}`, kind: "run", runId, label }]));
    setOpen(true);
  }, []);
  // Routine runs nobody clicked for (the clock firing a cron routine, an event such as a delivered notice or a new
  // request) join the thread as they start, so the panel follows every run, not only the ones a button watches. They
  // do not open a closed panel, and the guided tour, which scripts its own thread, is left alone.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seen: Set<string> | null = null;
    const names = new Map<string, string>();
    const nameOf = async (routineId: string): Promise<string> => {
      if (!names.size) {
        try { for (const r of (await client.get("/v1/routines")) as unknown as { id: string; name: string }[]) names.set(r.id, r.name); } catch { /* keep the id */ }
      }
      return names.get(routineId) ?? "Routine run";
    };
    const tick = async () => {
      try {
        const rows = await recentAgentRuns();
        if (seen === null) seen = new Set(rows.map((r) => r.id));
        else {
          for (const r of [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
            if (seen.has(r.id)) continue;
            seen.add(r.id);
            const routineId = routineIdOf(r);
            if (!r.routineRunId || !routineId || touring()) continue;
            const label = await nameOf(routineId);
            if (!live) return;
            setThread((t) => (t.some((x) => x.runId === r.id) ? t : [...t, { id: `${Date.now()}-${t.length}`, kind: "run", runId: r.id, label, background: true }]));
          }
        }
      } catch { /* the list may be unavailable for this viewer */ }
      if (live && !HOSTED) timer = setTimeout(() => void tick(), FOLLOW_MS);
    };
    // Hosted: the poll scheduler runs the follower (paused while hidden, and on commits once the change feed is up).
    let busy = false;
    const poller = HOSTED ? startPoller(() => { if (busy) return; busy = true; poller?.ran(); void tick().finally(() => { busy = false; }); }, FOLLOW_MS, "/api/v1/agent/runs?limit=10") : null;
    void tick();
    return () => { live = false; if (timer) clearTimeout(timer); poller?.stop(); };
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
