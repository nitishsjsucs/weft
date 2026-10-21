"use client";
// The hosted landing's live islands (docs/cloudflare/design.md 3.5). The page is a static asset: it renders the
// snapshot builder's stats.json and the frozen hosted clock, so an unleased visit costs no Worker or Durable Object
// request. A visitor who holds a lease (the per-browser hint) then refreshes both from their own demo company.
import type { Health, Stats } from "@weft/contracts";
import { useEffect, useState } from "react";
import { readLeaseHint } from "@/lib/hosted/hint";
import { SimClockTicker } from "./client";
import { toLandingStats, type LandingStats } from "./live";
import { StatsTiles } from "./sections";

type Clock = { now: string; rate: number };
interface LiveLanding { stats: LandingStats | null; clock: Clock | null }

let pending: Promise<LiveLanding> | null = null;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, credentials: "same-origin" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch { return null; }
}

/**
 * One read per page view, shared by both islands: stats.json when the build had none, then the leased visitor's own
 * stats and clock. Exported for tests.
 */
export function loadHostedLanding(initial: LandingStats, leased: boolean): Promise<LiveLanding> {
  pending ??= (async () => {
    let stats: LandingStats | null = null;
    if (initial.source === "fallback") {
      const snap = await getJson<Partial<Stats>>("/stats.json");
      const s = toLandingStats(snap, "snapshot");
      if (s.source === "snapshot") stats = s;
    }
    if (!leased) return { stats, clock: null };
    const [live, health] = await Promise.all([getJson<Partial<Stats>>("/api/v1/stats"), getJson<Partial<Health>>("/api/v1/health")]);
    const l = toLandingStats(live, "live");
    return { stats: l.source === "live" ? l : stats, clock: health?.clock ?? null };
  })();
  return pending;
}
/** Test hook. */
export function resetHostedLanding(): void { pending = null; }

function useLiveLanding(initial: LandingStats): LiveLanding {
  const [v, setV] = useState<LiveLanding>({ stats: null, clock: null });
  useEffect(() => {
    let live = true;
    void loadHostedLanding(initial, readLeaseHint() !== null).then((r) => { if (live) setV(r); });
    return () => { live = false; };
  }, [initial]);
  return v;
}

export function HostedStatsTiles({ initial }: { initial: LandingStats }) {
  const live = useLiveLanding(initial);
  return <StatsTiles stats={live.stats ?? initial} />;
}

/** The hero clock; `stats` is the same build-time stats the tiles get, so both islands share one read. */
export function HostedClock({ initial, stats }: { initial: Clock; stats: LandingStats }) {
  const live = useLiveLanding(stats);
  const c = live.clock ?? initial;
  return <SimClockTicker now={c.now} rate={c.rate} />;
}
