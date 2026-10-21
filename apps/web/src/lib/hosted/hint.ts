// A per-browser hint that this visitor holds a lease, so pages that never call the API for unleased visitors (the
// landing, design 3.5) know when a refresh from /api is worth a request. The cookies themselves are HttpOnly. Only a
// convenience: a missing or stale hint costs a fallback number, never correctness.
const KEY = "weft.hosted.lease.v1";

export interface LeaseHint { slot: string; gen: number; expiresAt: string }

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const local = (): Store | null => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };

export function writeLeaseHint(h: LeaseHint | null, store: Store | null = local()): void {
  try { if (h) store?.setItem(KEY, JSON.stringify(h)); else store?.removeItem(KEY); } catch { /* storage blocked */ }
}

/** The hint while its lease has not expired; null otherwise. */
export function readLeaseHint(now = Date.now(), store: Store | null = local()): LeaseHint | null {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LeaseHint>;
    if (typeof v.slot !== "string" || typeof v.gen !== "number" || typeof v.expiresAt !== "string") return null;
    const t = Date.parse(v.expiresAt);
    return Number.isFinite(t) && t > now ? { slot: v.slot, gen: v.gen, expiresAt: v.expiresAt } : null;
  } catch { return null; }
}
