// The in-app Platform page readout (design 10): today's dollars against the caps, neurons, restores left, leases,
// queue dead letters, the degradation level and each daily share against its use. Aggregates only, never content.
// It composes three sources: the Lobby (pool, leases, shares, level), SpendDO (dollars and neurons) and D1 (dead
// letters), plus the extras' own daily counters. GET /api/_hosted/platform is anonymous, so the Lobby's readout carries
// the SpendDO status its level already read and the extras' counters (one Durable Object RPC, and SpendDO only when
// the Lobby's 30 s level memo is cold), the dead-letter count stops at DEAD_LETTERS_MAX index entries, and weft-core
// reuses the whole readout for PLATFORM_MEMO_MS per isolate. Track cf6-extras.
import type { HostedSpendLedger, HostedSpendStatus } from "../../contracts/src/ext/cf-agent";
import { BROWSER_SECONDS_PER_DAY, type PlatformReadout } from "../../contracts/src/ext/cf-extras";
import { HOSTED_SETTINGS, type DegradationLevel } from "../../contracts/src/ext/cf-hosted";
import type { D1Like } from "./bindings";
import { utcDay } from "./bytes";
import { COUNTERS, type DailyCounters } from "./counters";

/** How long weft-core reuses the whole readout per isolate (the Lobby's own readout memo is as long). */
export const PLATFORM_MEMO_MS = 30_000;
/** The dead-letter count reads at most this many index entries of today's failed jobs (the page shows the cap). */
export const DEAD_LETTERS_MAX = 1_000;

/** What LobbyDO reports for the page (cf4-worker implements `extrasReadout()`; see the cf6 contract requests). */
export interface LobbyReadout {
  day: string;
  level: DegradationLevel;
  restoresLeft: number;
  leases: { active: number; pool: number; waitlist: number };
  lastSweepAt: string | null;
  shares: Record<string, { used: number; share: number }>;
  /** Today's extras counters by name (COUNTERS), read with the readout so the page needs no peek of its own. */
  counters?: Partial<Record<string, number>>;
  /** SpendDO's status({}) as the Lobby's level last read it (at most 30 s old), so the page needs no SpendDO call. */
  spend?: HostedSpendStatus | null;
}

export interface PlatformPorts {
  lobby: () => Promise<LobbyReadout>;
  spend: Pick<HostedSpendLedger, "status">;
  ops?: D1Like | null;
  counters?: DailyCounters | null;
  now?: () => Date;
}

/** Failed jobs since `since`, counted through the failed_at index and stopped at DEAD_LETTERS_MAX entries. */
export async function deadLettersSince(db: D1Like, since: string): Promise<number> {
  const r = await db.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM failed_jobs WHERE failed_at >= ? LIMIT ?)").bind(since, DEAD_LETTERS_MAX).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

const usd = (micros: number) => Math.round(micros) / 1_000_000;

export async function buildPlatformReadout(p: PlatformPorts): Promise<PlatformReadout> {
  const now = p.now?.() ?? new Date();
  const day = utcDay(now);
  const dead = p.ops ? deadLettersSince(p.ops, `${day}T00:00:00.000Z`).catch(() => 0) : Promise.resolve(0);
  const lobby = await p.lobby();
  // What the Lobby's readout already carries is not asked for again (an older Lobby sends neither).
  const peek = (name: string) => {
    const v = lobby.counters?.[name];
    return typeof v === "number" ? Promise.resolve(v) : p.counters ? p.counters.peek(name, day) : Promise.resolve(null);
  };
  const [spend, deadLetters, help, browserMs] = await Promise.all([
    lobby.spend ? Promise.resolve(lobby.spend) : p.spend.status({}),
    dead,
    peek(COUNTERS.help),
    peek(COUNTERS.browserMs),
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
