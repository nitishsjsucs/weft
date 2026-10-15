"use client";
// Data hooks for the app (t5-app). One typed client with the "Viewing as" principal; a tiny cache with global
// invalidation after every mutation; mocks swap in through the client's fetch when NEXT_PUBLIC_WEFT_MOCKS=1.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, buildPath, createClient, type CallOptions, type GetPath } from "./client";
import { mockFetch, mocksEnabled, PRINCIPALS } from "./mocks";

export { PRINCIPALS };
export type PrincipalId = (typeof PRINCIPALS)[number]["id"];
export const DEFAULT_PRINCIPAL: PrincipalId = "usr_dana";
const PRINCIPAL_KEY = "weft.viewingAs";

// "Viewing as" (a demo control): the chosen human is sent as x-weft-principal on every request; the Next proxy
// adds x-weft-proxy, which the API requires before it honors the header (SPEC 10).
let principal: string = DEFAULT_PRINCIPAL;
const principalSubs = new Set<() => void>();
if (typeof window !== "undefined") {
  try { const saved = window.localStorage.getItem(PRINCIPAL_KEY); if (saved && PRINCIPALS.some((p) => p.id === saved)) principal = saved; } catch { /* storage blocked */ }
}
export function getPrincipal(): string { return principal; }
export function setPrincipal(id: string) {
  principal = id;
  try { window.localStorage.setItem(PRINCIPAL_KEY, id); } catch { /* storage blocked */ }
  principalSubs.forEach((f) => f());
  invalidate();
}
export function usePrincipal(): string {
  return useSyncExternalStore((cb) => { principalSubs.add(cb); return () => principalSubs.delete(cb); }, getPrincipal, () => DEFAULT_PRINCIPAL);
}

export const client = createClient({ principal: getPrincipal, ...(mocksEnabled ? { fetch: mockFetch } : {}) });
export const rawFetch: typeof fetch = mocksEnabled ? mockFetch : (...a) => fetch(...a);

// Global invalidation: every mutation bumps the version and each mounted query refetches.
let version = 0;
const versionSubs = new Set<() => void>();
export function invalidate() { version++; versionSubs.forEach((f) => f()); }
function useVersion() { return useSyncExternalStore((cb) => { versionSubs.add(cb); return () => versionSubs.delete(cb); }, () => version, () => 0); }

const cache = new Map<string, unknown>();

export interface Query<T> { data: T | undefined; error: ApiError | Error | null; loading: boolean; reload: () => void }

/** GET a typed route. `refreshMs` polls; `enabled: false` skips. Data from the last fetch of the same URL renders at once. */
export function useGet<P extends GetPath>(path: P, opts: CallOptions & { refreshMs?: number; enabled?: boolean } = {}): Query<Awaited<ReturnType<typeof client.get<P>>>> {
  type T = Awaited<ReturnType<typeof client.get<P>>>;
  const { refreshMs, enabled = true, params, query } = opts;
  const key = enabled ? buildPath(path, params, query) : null;
  const v = useVersion();
  const who = usePrincipal();
  const [state, setState] = useState<{ key: string | null; data: T | undefined; error: Error | null; loading: boolean }>(() => ({ key, data: key ? (cache.get(key) as T | undefined) : undefined, error: null, loading: !!key }));
  const [tick, setTick] = useState(0);
  const optsRef = useRef({ params, query });
  optsRef.current = { params, query };

  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    setState((s) => (s.key === key ? { ...s, loading: true } : { key, data: cache.get(key) as T | undefined, error: null, loading: true }));
    client.get(path, { ...optsRef.current, signal: ctrl.signal }).then(
      (data) => { cache.set(key, data); setState({ key, data: data as T, error: null, loading: false }); },
      (e: unknown) => { if (!ctrl.signal.aborted) setState((s) => ({ ...s, key, error: e instanceof Error ? e : new Error(String(e)), loading: false })); },
    );
    return () => ctrl.abort();
  }, [key, v, tick, who, path]);

  useEffect(() => {
    if (!key || !refreshMs) return;
    const t = setInterval(() => setTick((x) => x + 1), refreshMs);
    return () => clearInterval(t);
  }, [key, refreshMs]);

  const reload = useCallback(() => setTick((x) => x + 1), []);
  const same = state.key === key;
  return { data: same ? state.data : (key ? (cache.get(key) as T | undefined) : undefined), error: same ? state.error : null, loading: same ? state.loading : !!key, reload };
}

/** Wraps a mutation: tracks pending and error, invalidates every query on success. */
export function useMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true); setError(null);
    try { const r = await fnRef.current(...args); invalidate(); return r; }
    catch (e) { setError(e instanceof Error ? e : new Error(String(e))); return undefined; }
    finally { setPending(false); }
  }, []);
  return { run, pending, error, reset: () => setError(null) };
}

// Typed convenience hooks used across screens.
export const useHealth = () => useGet("/v1/health", { refreshMs: 15_000 });
export const useSimClock = () => useGet("/v1/sim/clock", { refreshMs: 5_000 });
export const usePendingCount = () => {
  const q = useGet("/v1/proposals", { query: { status: "pending", limit: 100 }, refreshMs: 5_000 });
  return q.data ? q.data.data.filter((p) => p.kind !== "suggestion").length : null;
};

/** Error text for a failed call, preferring the API's `_tag` and message. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return `${e.tag}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
