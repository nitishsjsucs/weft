"use client";
// React bindings for the hosted shell's module state.
import { useEffect, useState, useSyncExternalStore } from "react";
import { startPoller } from "@/lib/api/hooks";
import { apiFetch } from "@/lib/api/client";
import { hostedStore, type HostedState } from "@/lib/hosted/session";

export function useHostedState(): HostedState {
  return useSyncExternalStore(hostedStore.subscribe, hostedStore.get, hostedStore.get);
}

export interface HostedQuery<T> { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** GET a hosted route (outside the typed /v1 client): once, then every `refreshMs` under the poll scheduler. */
export function useHostedGet<T>(path: string, refreshMs = 60_000): HostedQuery<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    apiFetch(path, { headers: { accept: "application/json" }, signal: ctrl.signal }).then(async (res) => {
      const text = await res.text();
      const json = text ? (JSON.parse(text) as unknown) : null;
      if (!res.ok) throw new Error((json as { message?: string } | null)?.message ?? res.statusText);
      setState({ data: json as T, error: null, loading: false });
    }).catch((e: unknown) => { if (!ctrl.signal.aborted) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false })); });
    return () => ctrl.abort();
  }, [path, tick]);
  useEffect(() => { const p = startPoller(() => setTick((x) => x + 1), refreshMs, path); return () => p.stop(); }, [path, refreshMs]);
  return { ...state, reload: () => setTick((x) => x + 1) };
}
