// The in-app Platform page readout (design 10): today's dollars against the caps, neurons, restores left, leases,
// queue dead letters, the degradation level and each daily share against its use. Aggregates only, never content.
// It composes three sources: the Lobby (pool, leases, shares, level), SpendDO (dollars and neurons) and D1 (dead
// letters), plus the extras' own daily counters. Track cf6-extras.
import type { HostedSpendLedger } from "../../contracts/src/ext/cf-agent";
import { BROWSER_SECONDS_PER_DAY, type PlatformReadout } from "../../contracts/src/ext/cf-extras";
import { HOSTED_SETTINGS, type DegradationLevel } from "../../contracts/src/ext/cf-hosted";
import type { D1Like } from "./bindings";
import { utcDay } from "./bytes";
import { COUNTERS, type DailyCounters } from "./counters";

/** What LobbyDO reports for the page (cf4-worker implements `extrasReadout()`; see the cf6 contract requests). */
export interface LobbyReadout {
  day: string;
  level: DegradationLevel;
  restoresLeft: number;
  leases: { active: number; pool: number; waitlist: number };
  lastSweepAt: string | null;
  shares: Record<string, { used: number; share: number }>;
}

export interface PlatformPorts {
  lobby: () => Promise<LobbyReadout>;
  spend: Pick<HostedSpendLedger, "status">;
  ops?: D1Like | null;
  counters?: DailyCounters | null;
  now?: () => Date;
}

export async function deadLettersSince(db: D1Like, since: string): Promise<number> {
  const r = await db.prepare("SELECT count(*) AS n FROM failed_jobs WHERE failed_at >= ?").bind(since).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

const usd = (micros: number) => Math.round(micros) / 1_000_000;

export async function buildPlatformReadout(p: PlatformPorts): Promise<PlatformReadout> {
  const now = p.now?.() ?? new Date();
  const day = utcDay(now);
  const [lobby, spend, deadLetters, help, browserMs] = await Promise.all([
    p.lobby(),
    p.spend.status({}),
    p.ops ? deadLettersSince(p.ops, `${day}T00:00:00.000Z`).catch(() => 0) : Promise.resolve(0),
    p.counters ? p.counters.peek(COUNTERS.help, day) : Promise.resolve(null),
    p.counters ? p.counters.peek(COUNTERS.browserMs, day) : Promise.resolve(null),
  ]);
  const shares: PlatformReadout["shares"] = { ...lobby.shares };
  if (help !== null) shares["help.queries"] = { used: help, share: HOSTED_SETTINGS.helpQueriesPerDay };
  if (browserMs !== null) shares["pdf.browser_seconds"] = { used: Math.round(browserMs / 100) / 10, share: BROWSER_SECONDS_PER_DAY };
  return {
    day,
    level: lobby.level,
    dollars: { spentUsd: usd(spend.spentMicros.day), dayCapUsd: spend.caps.dayUsd, runCapUsd: spend.caps.runUsd },
    neurons: { used: spend.neurons.used, cap: spend.caps.neuronsDay },
    restoresLeft: lobby.restoresLeft,
    leases: lobby.leases,
    deadLetters,
    lastSweepAt: lobby.lastSweepAt,
    shares,
  };
}
