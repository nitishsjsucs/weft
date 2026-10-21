// Server-side reads for the landing page. Both routes are public (SPEC 10), so no proxy header is needed; when
// the API is down or a route is still a stub, the page falls back to the seed's numbers and says so. Owner: t6-site.
import type { Health, Stats } from "@weft/contracts";

export interface LandingStats {
  /** live: GET /v1/stats answered; snapshot: the hosted build's stats.json from the seeded world; fallback: the seed's numbers. */
  source: "live" | "fallback" | "snapshot";
  employees: number;
  simulatedAgencies: number;
  runsLogged: number;
  realAgenciesContacted: 0;
}

/** The seed's numbers (SPEC 5 and 11.2), shown when GET /v1/stats is unavailable. */
export const FALLBACK_STATS: LandingStats = { source: "fallback", employees: 48, simulatedAgencies: 7, runsLogged: 0, realAgenciesContacted: 0 };
export const SEED_CLOCK = { now: "2026-10-26T15:30:00.000Z", rate: 0 };

const apiBase = () => `http://127.0.0.1:${process.env.WEFT_API_PORT ?? "4070"}`;

async function getJson<T>(path: string, ms = 1200): Promise<T | null> {
  try {
    const res = await fetch(`${apiBase()}${path}`, { cache: "no-store", signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function toLandingStats(s: Partial<Stats> | null, source: "live" | "snapshot" = "live"): LandingStats {
  if (!s || typeof s.employees !== "number" || typeof s.simulatedAgencies !== "number" || typeof s.runsLogged !== "number") return FALLBACK_STATS;
  return { source, employees: s.employees, simulatedAgencies: s.simulatedAgencies, runsLogged: s.runsLogged, realAgenciesContacted: 0 };
}

export async function loadLanding(): Promise<{ stats: LandingStats; clock: { now: string; rate: number }; live: boolean }> {
  const [stats, health] = await Promise.all([getJson<Stats>("/v1/stats"), getJson<Health>("/v1/health")]);
  return { stats: toLandingStats(stats), clock: health?.clock ?? SEED_CLOCK, live: !!health };
}
